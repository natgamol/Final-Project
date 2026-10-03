import {Timestamp} from 'firebase/firestore';

import {thailandCalendarParts, thailandDateKey, thailandDaysInMonth, thailandMonthKey, thailandRange} from '@/lib/thailand-time';

import type {Activity, Schedule, Transaction, WithId} from '@/types/smartlife';

type TimeValue = Date | string | number | Timestamp | {seconds?: number; toDate?: () => Date; toMillis?: () => number} | null | undefined;

export type FinanceBudgetInsight = {
  averageDailyBudget: number;
  daysInMonth: number;
  daysRemainingIncludingToday: number;
  expectedSpentByToday: number;
  financePressureLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  monthKey: string;
  monthlyBudget: number;
  overspendAmount: number;
  remainingBudget: number;
  remainingDailyBudget: number;
  runwayDays: number | null;
  spentSoFar: number;
  /** Expenses dated today in Bangkok, already included in `spentSoFar`. */
  todaySpent: number;
  weekEnd: string;
  weekSpent: number;
  weekStart: string;
  weeklyBudget: number;
  weeklyRemainingBudget: number;
  weeklyStatus: 'safe' | 'warning' | 'exceeded';
  weeklyUsagePercent: number;
};

export type BurnoutDynamicInsight = {
  assessmentWindowDays: number;
  /** Nightly hours implied by the user's declared usual window, if they set one. */
  baselineSleepHours: number | null;
  /**
   * Average of the nights actually backing the assessment. It reads from logged
   * nights when there are any, and only falls back to the declared baseline
   * when there are none -- `sleepEvidenceSource` says which, so a baseline can
   * never be mistaken for a measurement.
   */
  averageSleepHours: number | null;
  busyHoursThisWeek: number;
  busyHoursToday: number;
  evidenceCoverage: 'limited' | 'partial' | 'strong';
  highLoadDays: number;
  lateSleepStreak: number;
  longestContinuousBusyMinutes: number;
  longestFreeSlotMinutes: number;
  overdueTaskCount: number;
  pendingTaskCount: number;
  protectiveFactors: string[];
  reasons: string[];
  riskLevel: 'low' | 'medium' | 'high';
  score: number;
  /** Which NSF duration band `averageSleepHours` falls in. */
  sleepBand: 'borderline' | 'excessive' | 'insufficient' | 'recommended' | 'unknown';
  sleepDataDays: number;
  /** Rolling deficit against the nightly target, from logged nights only. */
  sleepDebtHours: number | null;
  /** Logged nights inside the debt window that produced `sleepDebtHours`. */
  sleepDebtNights: number;
  /** Where the sleep figures came from. A baseline is never counted as logged. */
  sleepEvidenceSource: 'baseline' | 'logged' | 'none';
  studyWorkToSleepRatio: number | null;
  totalFreeMinutes: number;
  urgentTaskCount: number;
};

export type SmartLifeDynamicInsight = {burnout: BurnoutDynamicInsight; finance?: FinanceBudgetInsight};

function toDate(value: TimeValue) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value instanceof Timestamp) return value.toDate();
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

function startOfDay(date: Date) { const result = new Date(date); result.setHours(0, 0, 0, 0); return result; }
function endOfDay(date: Date) { const result = startOfDay(date); result.setHours(23, 59, 59, 999); return result; }
function localDateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function roundMoney(value: number) { return !Number.isFinite(value) || value <= 0 ? 0 : Math.round(value); }
function clamp(value: number, min: number, max: number) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }

export function calculateFinanceBudgetInsight({dailyBudget, monthlyBudget, now = new Date(), transactions, weeklyBudget}: {
  /** A daily limit the user set. Omitted, the monthly amount is split evenly. */
  dailyBudget?: number;
  monthlyBudget: number;
  now?: Date;
  transactions: Pick<Transaction, 'amount' | 'occurredAt' | 'type'>[];
  /** A weekly limit the user set. Omitted, the monthly amount is split evenly. */
  weeklyBudget?: number;
}): FinanceBudgetInsight | null {
  if (!Number.isFinite(monthlyBudget) || monthlyBudget <= 0) return null;
  // Every boundary below is anchored to Asia/Bangkok, because the spending it
  // divides is queried with `thailandRange`. Reading the device clock here made
  // the pacing math describe a different month than the transactions it used.
  const totalDays = thailandDaysInMonth(now);
  const currentDay = thailandCalendarParts(now).day;
  const daysRemainingIncludingToday = Math.max(1, totalDays - currentDay + 1);
  const expenses = transactions.filter((item) => item.type === 'expense');
  const spentSoFar = expenses.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const remainingBudget = monthlyBudget - spentSoFar;
  // An explicit figure wins; without one the monthly amount is split, which is
  // what every caller got before these arguments existed.
  const setDaily = Number.isFinite(dailyBudget) && (dailyBudget ?? 0) > 0 ? dailyBudget as number : null;
  const setWeekly = Number.isFinite(weeklyBudget) && (weeklyBudget ?? 0) > 0 ? weeklyBudget as number : null;
  const averageDailyBudget = setDaily ?? roundMoney(monthlyBudget / totalDays);
  const dailyExpenses = expenses.reduce((map, item) => {
    const occurredAt = toDate(item.occurredAt);
    if (occurredAt) map.set(thailandDateKey(occurredAt), (map.get(thailandDateKey(occurredAt)) ?? 0) + Number(item.amount ?? 0));
    return map;
  }, new Map<string, number>());
  const todaySpent = dailyExpenses.get(thailandDateKey(now)) ?? 0;

  // What is still spendable today: today's allowance less what today has
  // already spent.
  //
  // Both halves used to be wrong in their own way. With a daily limit set this
  // returned the limit itself, so ฿100 a day read ฿100 after an ฿80 coffee.
  // Without one it divided the month's remainder by the days left, today's
  // spending included -- so the same ฿80 moved today's figure by ฿80 spread
  // over the rest of the month, a few baht, rather than by ฿80.
  //
  // Today's allowance is therefore fixed at the start of the day -- the limit
  // the user set, or the month's remainder as it stood before today spread
  // over the days left -- and today's spending comes straight off it. The
  // month still wins over both: once it is spent there is nothing left today,
  // and today can never offer more than the month has left.
  const remainingAtStartOfToday = monthlyBudget - (spentSoFar - todaySpent);
  const todayAllowance = setDaily ?? remainingAtStartOfToday / daysRemainingIncludingToday;
  const remainingDailyBudget = remainingBudget <= 0 ? 0
    : roundMoney(Math.min(todayAllowance - todaySpent, remainingBudget));
  const expectedSpentByToday = monthlyBudget / totalDays * currentDay;
  const overspendAmount = Math.max(0, spentSoFar - expectedSpentByToday);
  const averageActualDailyExpense = dailyExpenses.size
    ? Array.from(dailyExpenses.values()).reduce((sum, value) => sum + value, 0) / dailyExpenses.size : 0;
  const runwayDays = averageActualDailyExpense > 0 && remainingBudget > 0 ? Math.floor(remainingBudget / averageActualDailyExpense) : null;

  // Keep the saved monthly ceiling, but coach against a Monday-Sunday share.
  const {from: monthStart, to: monthEnd} = thailandRange('month', now);
  const {from: rawWeekStart, to: rawWeekEnd} = thailandRange('week', now);
  const weekStart = rawWeekStart < monthStart ? monthStart : rawWeekStart;
  const weekEnd = rawWeekEnd > monthEnd ? monthEnd : rawWeekEnd;
  const daysInBudgetWeek = Math.max(1, Math.round((weekEnd.getTime() + 1 - weekStart.getTime()) / 86_400_000));
  const weeklyBudgetValue = setWeekly ?? roundMoney(monthlyBudget / totalDays * daysInBudgetWeek);
  const weekSpent = expenses.reduce((sum, item) => {
    const occurredAt = toDate(item.occurredAt);
    return occurredAt && occurredAt >= weekStart && occurredAt <= weekEnd ? sum + Number(item.amount ?? 0) : sum;
  }, 0);
  const weeklyRemainingBudget = Math.round(weeklyBudgetValue - weekSpent);
  const weeklyUsagePercent = weeklyBudgetValue > 0 ? Math.round((weekSpent / weeklyBudgetValue) * 100) : 0;
  const weeklyStatus: FinanceBudgetInsight['weeklyStatus'] = weeklyUsagePercent >= 100 ? 'exceeded' : weeklyUsagePercent >= 80 ? 'warning' : 'safe';
  let financePressureLevel: FinanceBudgetInsight['financePressureLevel'] = 'none';
  if (remainingBudget < 0 || weeklyStatus === 'exceeded') financePressureLevel = 'critical';
  else if (weeklyStatus === 'warning') financePressureLevel = 'high';
  else if (weeklyUsagePercent >= 65) financePressureLevel = 'medium';
  else if (overspendAmount > 0) financePressureLevel = 'low';

  return {
    averageDailyBudget, daysInMonth: totalDays, daysRemainingIncludingToday,
    expectedSpentByToday: Math.round(expectedSpentByToday), financePressureLevel,
    monthKey: thailandMonthKey(now), monthlyBudget, overspendAmount: Math.round(overspendAmount),
    remainingBudget: Math.round(remainingBudget), remainingDailyBudget, runwayDays, spentSoFar, todaySpent: Math.round(todaySpent),
    weekEnd: thailandDateKey(weekEnd), weekSpent: Math.round(weekSpent), weekStart: thailandDateKey(weekStart),
    weeklyBudget: weeklyBudgetValue, weeklyRemainingBudget, weeklyStatus, weeklyUsagePercent,
  };
}

export type DailyAllowance = {
  /** Baht still spendable today at a pace that finishes the month on budget. */
  amount: number;
  monthlyBudget: number;
  /** True once the month's spending has passed the limit, so `amount` is 0. */
  overBudget: boolean;
  /** Negative once over budget, which is what the over-budget copy reports. */
  remainingBudget: number;
  spentSoFar: number;
};

/**
 * The one number the dashboard surfaces answer with: what is left to spend
 * today under the monthly limit. It is the month's remaining budget spread over
 * the days remaining including today, so spending earlier in the month tightens
 * it rather than leaving a flat figure that ignores the pace.
 *
 * Null when no limit is set, so those surfaces can prompt for one instead of
 * showing a ฿0 that reads as "you have nothing left" -- which is what the tile
 * and the assistant chip did while they showed a day's income minus expenses.
 */
export function calculateDailyAllowance({dailyBudget, monthlyBudget, now = new Date(), transactions, weeklyBudget}: {
  dailyBudget?: number;
  monthlyBudget: number;
  now?: Date;
  transactions: Pick<Transaction, 'amount' | 'occurredAt' | 'type'>[];
  weeklyBudget?: number;
}): DailyAllowance | null {
  const insight = calculateFinanceBudgetInsight({dailyBudget, monthlyBudget, now, transactions, weeklyBudget});
  if (!insight) return null;
  return {
    amount: insight.remainingDailyBudget,
    monthlyBudget: insight.monthlyBudget,
    overBudget: insight.remainingBudget <= 0,
    remainingBudget: insight.remainingBudget,
    spentSoFar: insight.spentSoFar,
  };
}

export type TensionLevel = 'safe' | 'caution' | 'tight' | 'very-tight' | 'over-budget';

export type BudgetTension = {
  dailyLimit: number;
  label: string;
  level: TensionLevel;
  monthlyBudget: number;
  percentUsed: number;
  todayRemaining: number;
  todaySpent: number;
};

/**
 * Today's pressure against the monthly limit, given spending already gathered.
 * It lives beside the other budget maths rather than in `budget-tension.ts`
 * because that module reaches Firestore, and both the notification feed and the
 * dashboard need this without a network round trip. `evaluateBudgetTension`
 * re-exports it and remains the loading front door.
 */
export function calculateBudgetTension({dailyBudget, monthlyBudget, now = new Date(), todaySpent}: {
  /** A daily limit the user set. Omitted, the monthly amount is split evenly. */
  dailyBudget?: number;
  monthlyBudget: number;
  now?: Date;
  todaySpent: number;
}): BudgetTension | null {
  if (!Number.isFinite(monthlyBudget) || monthlyBudget <= 0) return null;

  // Bangkok month length, to match the Bangkok day window used for `todaySpent`.
  // A limit the user set is used as given -- not rounded to ten like the
  // derived one, which rounds only because an even split rarely lands neatly.
  const dailyLimit = Number.isFinite(dailyBudget) && (dailyBudget ?? 0) > 0
    ? dailyBudget as number
    : Math.round(monthlyBudget / thailandDaysInMonth(now) / 10) * 10;
  const todayRemaining = dailyLimit - todaySpent;
  const percentUsed = dailyLimit > 0 ? (todaySpent / dailyLimit) * 100 : (todaySpent > 0 ? 100 : 0);

  const [level, label]: [TensionLevel, string] =
    percentUsed < 60 ? ['safe', 'ปลอดภัย']
    : percentUsed < 80 ? ['caution', 'ควรระวัง']
    : percentUsed < 95 ? ['tight', 'เริ่มตึง']
    : percentUsed <= 100 ? ['very-tight', 'ตึงมาก']
    : ['over-budget', 'เกินงบแล้ว'];

  return {dailyLimit, label, level, monthlyBudget, percentUsed, todayRemaining, todaySpent};
}

function itemRange(item: {actualEnd?: TimeValue; actualStart?: TimeValue; endAt?: TimeValue; startAt?: TimeValue}) {
  const actualStart = toDate(item.actualStart);
  const actualEnd = toDate(item.actualEnd);
  const start = actualStart ?? toDate(item.startAt);
  const end = actualStart && actualEnd ? actualEnd : toDate(item.endAt);
  return start ? {end: end && end > start ? end : new Date(start.getTime() + 3_600_000), start} : null;
}

function overlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return Math.max(0, Math.min(aEnd.getTime(), bEnd.getTime()) - Math.max(aStart.getTime(), bStart.getTime())) / 60_000;
}

type BusyBlock = {end: Date; start: Date};
function mergeBlocks(blocks: BusyBlock[], maximumGapMinutes = 0) {
  return [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime()).reduce<BusyBlock[]>((merged, block) => {
    const last = merged[merged.length - 1];
    if (!last || block.start.getTime() > last.end.getTime() + maximumGapMinutes * 60_000) merged.push({...block});
    else if (block.end > last.end) last.end = block.end;
    return merged;
  }, []);
}

/**
 * Sleep duration bands, taken from the National Sleep Foundation's sleep-time
 * duration consensus for young adults (18-25) and adults (26-64): 7-9 hours is
 * the recommended range, 6 hours is classed only as "may be appropriate" rather
 * than recommended, and anything below 6 or above 11 hours is "not
 * recommended". These are the published figures, not tuned cut-offs, so the
 * bands can be defended rather than merely explained.
 *
 * Why sleep belongs in a burnout signal at all: in student populations sleep
 * quality and duration are reported to raise academic burnout largely through
 * perceived stress, and to moderate the stress-to-burnout relationship. That is
 * the rationale for letting sleep adjust -- never dominate -- a score the
 * workload signals build. The output stays a non-diagnostic indicator.
 */
export const SLEEP_REFERENCE = {
  /** Days the rolling deficit is accumulated across. */
  debtWindowDays: 7,
  /** Deficit that is treated as compounding rather than one poor night. */
  debtWarningHours: 7,
  /** Half a warning's worth: enough to mention, not enough to weigh heavily. */
  debtWatchHours: 3.5,
  /** NSF: above this, duration is "not recommended". */
  excessiveHours: 11,
  /** NSF: below this, duration is "not recommended". */
  insufficientHours: 6,
  /** NSF recommended band for 18-64. Below the floor is "may be appropriate". */
  recommendedMaxHours: 9,
  recommendedMinHours: 7,
  /** Nightly target the rolling debt measures against: the recommended floor. */
  targetHours: 7,
} as const;

/**
 * Points each sleep band contributes, and why the two directions are not
 * symmetric.
 *
 * Short sleep and long sleep are both outside the NSF recommended range, but
 * they are not equally informative about burnout. Sleep restriction has a
 * direct, experimentally supported path to the outcomes this score cares about
 * -- it can be induced in a lab and the effects on mood, attention and
 * exhaustion follow. Long sleep has no comparable experimental base: the
 * evidence is largely observational, and long duration tends to travel *with*
 * illness, low mood, or recovery from prior debt rather than causing them. It
 * is better read as a symptom worth noticing than as a driver of risk.
 *
 * So `excessive` is scored at roughly a third of `insufficient` -- enough for
 * the assessment to mention it, not enough to push someone into a higher risk
 * band on its own. Treating them equally would let a recovering weekend look
 * like a week of deprivation.
 *
 * A declared baseline is a statement of habit, not a measurement, so every band
 * is halved again when the figure came from the user's stated window.
 */
export const SLEEP_SCORE_WEIGHTS = {
  /** Below the NSF floor but inside "may be appropriate". */
  borderline: 10,
  /** Weakest of the three: observational evidence, often a symptom not a cause. */
  excessive: 6,
  /** Strongest evidence base of the three bands. */
  insufficient: 20,
  /** Applied to any band when the source is the declared window, not a log. */
  statedBaselineMultiplier: 0.5,
} as const;

/** Points for a band, halved when the figure is a stated habit not a log. */
export function sleepBandScore(band: BurnoutDynamicInsight['sleepBand'], source: BurnoutDynamicInsight['sleepEvidenceSource']) {
  const base = band === 'insufficient' ? SLEEP_SCORE_WEIGHTS.insufficient
    : band === 'borderline' ? SLEEP_SCORE_WEIGHTS.borderline
    : band === 'excessive' ? SLEEP_SCORE_WEIGHTS.excessive
    : 0;
  return source === 'baseline' ? Math.round(base * SLEEP_SCORE_WEIGHTS.statedBaselineMultiplier) : base;
}

/** Which NSF band a nightly average sits in. `null` hours means no evidence. */
export function sleepDurationBand(hours: number | null): BurnoutDynamicInsight['sleepBand'] {
  if (hours === null || !Number.isFinite(hours)) return 'unknown';
  if (hours < SLEEP_REFERENCE.insufficientHours) return 'insufficient';
  if (hours < SLEEP_REFERENCE.recommendedMinHours) return 'borderline';
  if (hours > SLEEP_REFERENCE.excessiveHours) return 'excessive';
  return 'recommended';
}

const SLEEP_TEXT_PATTERN = /(นอน|เข้านอน|ตื่นนอน|พักผ่อนกลางคืน|sleep|bedtime)/i;

/**
 * True for a record that represents sleep rather than something to do.
 *
 * Exported because the burnout model is not the only surface that has to ignore
 * sleep. The dashboard's "AI จัดลำดับวันนี้" ranking and the notification bell
 * must make the identical call, and a second copy of this pattern would drift
 * from this one -- which is exactly how a logged night ended up listed as an
 * overdue to-do with a "เสร็จ" button.
 *
 * A record the user filed as a `task` is deliberately never sleep, however it
 * is worded: "อ่านหนังสือก่อนนอน" is work they intend to do, and hiding it from
 * the priority list because it contains "นอน" would be worse than the bug this
 * predicate exists to fix. Only non-task records are matched on wording.
 *
 * Accepts loose records because the dashboard sees page data serialised to
 * plain objects, not typed `Activity` documents.
 */
export function isSleepActivity(item: {category?: unknown; note?: unknown; title?: unknown; type?: unknown}) {
  if (typeof item.type === 'string' && item.type.toLowerCase() === 'task') return false;
  const text = [item.title, item.category, item.note]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join(' ');
  return SLEEP_TEXT_PATTERN.test(text);
}

function activityLooksLikeSleep(item: Pick<Activity, 'category' | 'note' | 'title' | 'type'>) {
  return isSleepActivity(item);
}

/**
 * A night still in progress is not evidence yet. The one-tap logger writes the
 * record at "เข้านอน" with a provisional end so the night is visible in the
 * calendar straight away, and closes it at "ตื่นนอน"; counting the provisional
 * span would let a placeholder duration masquerade as a measurement.
 */
function sleepEntryIsFinished(item: Pick<Activity, 'status'>) {
  return item.status !== 'in-progress';
}

export function calculateBurnoutDynamicInsight({activities, finance: _finance, now = new Date(), pendingTasks, schedules, sleepBaselineHours = null, weekActivities, weekSchedules}: {
  activities: WithId<Activity>[];
  finance?: FinanceBudgetInsight | null;
  now?: Date;
  pendingTasks?: WithId<Activity>[];
  schedules: WithId<Schedule>[];
  /**
   * The user's declared usual nightly hours. It is a weaker class of evidence
   * than a logged night and is treated as such: it is used only when no night
   * was logged, it scores at half weight (see SLEEP_SCORE_WEIGHTS), and it can
   * never lift `evidenceCoverage` past `partial`.
   *
   * KNOWN AND INTENTIONAL LIMITATION -- not a bug: the choice between logged
   * and baseline is made once for the whole window, not per missing night. A
   * week with three logged nights reports the average of those three and
   * ignores the baseline for the other four, rather than filling the gaps in.
   *
   * Blending was considered and rejected. A blended average is a number no
   * single source can vouch for, and `sleepEvidenceSource` -- which every
   * surface uses to tell the user where the figure came from -- would have to
   * become a proportion the UI cannot honestly render in one line. Reporting
   * "the nights you actually logged" is weaker on coverage and stronger on
   * honesty, which is the trade this feature is built around.
   */
  sleepBaselineHours?: number | null;
  weekActivities?: WithId<Activity>[];
  weekSchedules?: WithId<Schedule>[];
}): BurnoutDynamicInsight {
  const todayStart = startOfDay(now); const todayEnd = endOfDay(now);
  const assessmentStart = startOfDay(now); assessmentStart.setDate(assessmentStart.getDate() - 6);
  const allWeekActivities = weekActivities ?? activities;
  const allWeekSchedules = weekSchedules ?? schedules;
  const sleepActivities = allWeekActivities.filter((item) => activityLooksLikeSleep(item) && sleepEntryIsFinished(item));
  const nonSleepActivities = allWeekActivities.filter((item) => !activityLooksLikeSleep(item) && item.status !== 'cancelled');
  const taskSource = pendingTasks ?? allWeekActivities;
  const taskItems = taskSource.filter((item) => item.type === 'task' && item.status !== 'completed' && item.status !== 'cancelled');
  const todayBusyBlocks = mergeBlocks([
    ...schedules.flatMap((item) => { const range = itemRange(item); return range ? [range] : []; }),
    ...activities.flatMap((item) => { const range = item.status !== 'cancelled' && !activityLooksLikeSleep(item) ? itemRange(item) : null; return range ? [range] : []; }),
  ].filter((range) => range.end >= todayStart && range.start <= todayEnd));
  const busyMinutes = todayBusyBlocks.reduce((sum, block) => sum + overlapMinutes(block.start, block.end, todayStart, todayEnd), 0);
  const overdueTaskCount = taskItems.filter((item) => (toDate(item.deadline) ?? itemRange(item)?.start ?? now) < now).length;
  const urgentTaskCount = taskItems.filter((item) => {
    const due = toDate(item.deadline) ?? itemRange(item)?.start ?? null;
    return item.priority === 'urgent' || item.priority === 'high' || item.priority === 'important' || Boolean(due && (due.getTime() - now.getTime()) / 36e5 <= 24);
  }).length;

  const activeStart = new Date(todayStart); activeStart.setHours(8, 0, 0, 0);
  const activeEnd = new Date(todayStart); activeEnd.setHours(22, 0, 0, 0);
  let cursor = activeStart; let longestFreeSlotMinutes = 0; let totalFreeMinutes = 0;
  todayBusyBlocks.forEach((block) => {
    const blockStart = new Date(Math.max(block.start.getTime(), activeStart.getTime()));
    const blockEnd = new Date(Math.min(block.end.getTime(), activeEnd.getTime()));
    if (blockEnd <= activeStart || blockStart >= activeEnd) return;
    const gap = Math.max(0, (blockStart.getTime() - cursor.getTime()) / 60_000);
    longestFreeSlotMinutes = Math.max(longestFreeSlotMinutes, gap); totalFreeMinutes += gap;
    if (blockEnd > cursor) cursor = blockEnd;
  });
  const tailGap = Math.max(0, (activeEnd.getTime() - cursor.getTime()) / 60_000);
  longestFreeSlotMinutes = Math.max(longestFreeSlotMinutes, tailGap); totalFreeMinutes += tailGap;

  const weekBlocks = [
    ...allWeekSchedules.flatMap((item) => { const range = itemRange(item); return range ? [range] : []; }),
    ...nonSleepActivities.flatMap((item) => { const range = itemRange(item); return range ? [range] : []; }),
  ].filter((range) => range.end >= assessmentStart && range.start <= todayEnd);
  const blocksByDay = weekBlocks.reduce((map, block) => {
    const key = localDateKey(block.start); map.set(key, [...(map.get(key) ?? []), block]); return map;
  }, new Map<string, BusyBlock[]>());
  let busyMinutesThisWeek = 0; let highLoadDays = 0; let longestContinuousBusyMinutes = 0;
  blocksByDay.forEach((blocks) => {
    const day = startOfDay(blocks[0].start); const dayFinish = endOfDay(day);
    const dailyMinutes = mergeBlocks(blocks).reduce((sum, block) => sum + overlapMinutes(block.start, block.end, day, dayFinish), 0);
    busyMinutesThisWeek += dailyMinutes; if (dailyMinutes >= 360) highLoadDays += 1;
    longestContinuousBusyMinutes = Math.max(longestContinuousBusyMinutes, mergeBlocks(blocks, 15).reduce((max, block) => Math.max(max, (block.end.getTime() - block.start.getTime()) / 60_000), 0));
  });

  const sleepEvidence = sleepActivities.flatMap((item) => {
    const range = itemRange(item); if (!range) return [];
    const hours = (range.end.getTime() - range.start.getTime()) / 36e5;
    return hours >= 2 && hours <= 14 ? [{hours, start: range.start}] : [];
  }).sort((a, b) => a.start.getTime() - b.start.getTime());
  const loggedSleepHours = sleepEvidence.length ? Math.round((sleepEvidence.reduce((sum, item) => sum + item.hours, 0) / sleepEvidence.length) * 10) / 10 : null;
  const baselineSleepHours = Number.isFinite(sleepBaselineHours) && (sleepBaselineHours as number) > 0
    ? Math.round((sleepBaselineHours as number) * 10) / 10
    : null;
  // A logged night always wins. The baseline only speaks when nothing was
  // logged, and `sleepEvidenceSource` carries that distinction to every surface
  // that shows a number, so no caller has to re-derive it.
  const sleepEvidenceSource: BurnoutDynamicInsight['sleepEvidenceSource'] =
    loggedSleepHours !== null ? 'logged' : baselineSleepHours !== null ? 'baseline' : 'none';
  const averageSleepHours = sleepEvidenceSource === 'logged' ? loggedSleepHours
    : sleepEvidenceSource === 'baseline' ? baselineSleepHours : null;
  const sleepBand = sleepDurationBand(averageSleepHours);
  let lateSleepStreak = 0; let currentLateStreak = 0;
  sleepEvidence.forEach((entry) => { const hour = entry.start.getHours(); currentLateStreak = hour >= 0 && hour < 5 ? currentLateStreak + 1 : 0; lateSleepStreak = Math.max(lateSleepStreak, currentLateStreak); });

  // Rolling sleep debt: sleep deprivation compounds, so a week of six-hour
  // nights is a different signal from one short night. Nights are collapsed per
  // calendar date first, because two entries for one night would otherwise each
  // be charged a full night's target. A long night pays debt back, and the
  // total floors at zero -- banked surplus is not a credit against next week.
  const debtWindowStart = startOfDay(now);
  debtWindowStart.setDate(debtWindowStart.getDate() - (SLEEP_REFERENCE.debtWindowDays - 1));
  const hoursByNight = sleepEvidence.reduce((map, entry) => {
    if (entry.start < debtWindowStart) return map;
    const key = localDateKey(entry.start);
    return map.set(key, (map.get(key) ?? 0) + entry.hours);
  }, new Map<string, number>());
  const sleepDebtNights = hoursByNight.size;
  const sleepDebtHours = sleepDebtNights
    ? Math.round(Math.max(0, Array.from(hoursByNight.values())
      .reduce((sum, hours) => sum + (SLEEP_REFERENCE.targetHours - hours), 0)) * 10) / 10
    : null;

  let score = 0; const reasons: string[] = []; const protectiveFactors: string[] = [];
  if (busyMinutes >= 480) { score += 25; reasons.push(`วันนี้มีเรียนหรือทำงานรวม ${Math.round(busyMinutes / 60)} ชั่วโมง`); }
  else if (busyMinutes >= 360) { score += 15; reasons.push(`วันนี้มีเรียนหรือทำงานรวม ${Math.round((busyMinutes / 60) * 10) / 10} ชั่วโมง`); }
  if (longestContinuousBusyMinutes >= 240) { score += 25; reasons.push(`มีช่วงเรียนหรือทำงานต่อเนื่องยาวสุด ${Math.round(longestContinuousBusyMinutes / 60)} ชั่วโมง`); }
  else if (longestContinuousBusyMinutes >= 180) { score += 15; reasons.push(`มีช่วงเรียนหรือทำงานต่อเนื่องยาวสุด ${Math.round(longestContinuousBusyMinutes / 60)} ชั่วโมง`); }
  if (taskItems.length >= 6) { score += 20; reasons.push(`มีงานค้าง ${taskItems.length} รายการ`); }
  else if (taskItems.length >= 3) { score += 10; reasons.push(`มีงานค้าง ${taskItems.length} รายการ`); }
  if (overdueTaskCount > 0) { score += Math.min(20, overdueTaskCount * 10); reasons.push(`มีงานเลยกำหนด ${overdueTaskCount} รายการ`); }
  if (highLoadDays >= 5) { score += 25; reasons.push(`มีภาระอย่างน้อย 6 ชั่วโมง ${highLoadDays} วันในช่วงที่ตรวจ`); }
  else if (highLoadDays >= 3) { score += 15; reasons.push(`มีวันที่ภาระอย่างน้อย 6 ชั่วโมง ${highLoadDays} วันในช่วงที่ตรวจ`); }
  // Sleep scoring, banded on the NSF figures in SLEEP_REFERENCE and weighted by
  // SLEEP_SCORE_WEIGHTS, which documents why long sleep counts for less than
  // short sleep rather than treating the two directions as mirror images.
  if (sleepEvidenceSource === 'logged' && sleepEvidence.length >= 2 && averageSleepHours !== null) {
    const loggedReason = `ข้อมูลการนอนที่บันทึกไว้ ${sleepEvidence.length} คืน เฉลี่ย ${averageSleepHours} ชั่วโมง`;
    score += sleepBandScore(sleepBand, 'logged');
    if (sleepBand === 'insufficient') reasons.push(`${loggedReason} ต่ำกว่าเกณฑ์แนะนำ ${SLEEP_REFERENCE.insufficientHours} ชั่วโมง`);
    else if (sleepBand === 'borderline') reasons.push(`${loggedReason} ยังไม่ถึงช่วงแนะนำ ${SLEEP_REFERENCE.recommendedMinHours}-${SLEEP_REFERENCE.recommendedMaxHours} ชั่วโมง`);
    else if (sleepBand === 'excessive') reasons.push(`${loggedReason} สูงกว่าเกณฑ์แนะนำเกิน ${SLEEP_REFERENCE.excessiveHours} ชั่วโมง ซึ่งมักเป็นสัญญาณของการนอนชดเชยหรือสุขภาพ มากกว่าจะเป็นสาเหตุของภาวะหมดไฟ จึงถ่วงน้ำหนักน้อยกว่าการนอนไม่พอ`);
  } else if (sleepEvidenceSource === 'baseline' && averageSleepHours !== null) {
    score += sleepBandScore(sleepBand, 'baseline');
    if (sleepBand !== 'recommended' && sleepBand !== 'unknown') {
      reasons.push(`ยังไม่มีการบันทึกการนอนจริง จึงใช้ช่วงนอนปกติที่ตั้งไว้ ${averageSleepHours} ชั่วโมงเป็นค่าอ้างอิงชั่วคราว`);
    }
  }
  if (sleepDebtHours !== null && sleepDebtNights >= 3) {
    if (sleepDebtHours >= SLEEP_REFERENCE.debtWarningHours) { score += 12; reasons.push(`สะสมการนอนขาดรวม ${sleepDebtHours} ชั่วโมงใน ${sleepDebtNights} คืนที่บันทึกไว้`); }
    else if (sleepDebtHours >= SLEEP_REFERENCE.debtWatchHours) { score += 6; reasons.push(`เริ่มสะสมการนอนขาดรวม ${sleepDebtHours} ชั่วโมงใน ${sleepDebtNights} คืนที่บันทึกไว้`); }
  }
  if (lateSleepStreak >= 2) { score += 15; reasons.push(`มีบันทึกเข้านอนหลังเที่ยงคืนต่อเนื่อง ${lateSleepStreak} คืน`); }
  if (longestFreeSlotMinutes < 30) { score += 15; reasons.push('วันนี้ไม่มีช่วงว่างต่อเนื่องถึง 30 นาที'); }
  else if (longestFreeSlotMinutes < 45) { score += 8; reasons.push(`วันนี้ช่วงว่างยาวสุด ${Math.round(longestFreeSlotMinutes)} นาที`); }
  if (longestFreeSlotMinutes >= 60) protectiveFactors.push(`วันนี้ยังมีช่วงว่างต่อเนื่อง ${Math.round(longestFreeSlotMinutes)} นาที`);
  if (overdueTaskCount === 0) protectiveFactors.push('ยังไม่พบงานเลยกำหนด');
  if (sleepEvidenceSource === 'logged' && sleepEvidence.length >= 2 && sleepBand === 'recommended') protectiveFactors.push(`การนอนที่บันทึกไว้เฉลี่ย ${averageSleepHours} ชั่วโมง อยู่ในช่วงแนะนำ ${SLEEP_REFERENCE.recommendedMinHours}-${SLEEP_REFERENCE.recommendedMaxHours} ชั่วโมง`);
  if (sleepDebtHours === 0 && sleepDebtNights >= 3) protectiveFactors.push(`ไม่มีการนอนขาดสะสมใน ${sleepDebtNights} คืนที่บันทึกไว้`);

  const finalScore = clamp(Math.round(score), 0, 100);
  // Only logged nights count as evidence signals. A declared baseline is a
  // preference, not a record, so it must not be able to inflate coverage --
  // that is precisely the "default masquerading as evidence" this guards.
  const evidenceSignals = blocksByDay.size + taskItems.length + sleepEvidence.length;
  const studyWorkToSleepRatio = sleepEvidenceSource === 'logged' && averageSleepHours && sleepEvidence.length >= 2
    ? Math.round(((busyMinutesThisWeek / 60 / 7) / averageSleepHours) * 100) / 100
    : null;
  // `strong` now needs a real week of nights behind it, not two. Workload alone
  // still reaches `partial`, because workload evidence genuinely is present --
  // it just cannot claim the sleep dimension it never measured.
  const evidenceCoverage: BurnoutDynamicInsight['evidenceCoverage'] =
    evidenceSignals >= 8 && sleepEvidence.length >= 3 ? 'strong'
    : evidenceSignals >= 3 || sleepEvidence.length >= 1 ? 'partial'
    : 'limited';
  return {
    assessmentWindowDays: 7, averageSleepHours, baselineSleepHours,
    busyHoursThisWeek: Math.round((busyMinutesThisWeek / 60) * 10) / 10,
    busyHoursToday: Math.round((busyMinutes / 60) * 10) / 10,
    evidenceCoverage,
    highLoadDays, lateSleepStreak, longestContinuousBusyMinutes: Math.round(longestContinuousBusyMinutes),
    longestFreeSlotMinutes: Math.round(longestFreeSlotMinutes), overdueTaskCount, pendingTaskCount: taskItems.length,
    protectiveFactors, reasons, riskLevel: finalScore >= 65 ? 'high' : finalScore >= 35 ? 'medium' : 'low',
    score: finalScore, sleepBand, sleepDataDays: sleepEvidence.length, sleepDebtHours, sleepDebtNights,
    sleepEvidenceSource, studyWorkToSleepRatio,
    totalFreeMinutes: Math.round(totalFreeMinutes), urgentTaskCount,
  };
}
