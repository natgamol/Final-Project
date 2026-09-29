import {calculateBudgetTension, calculateDailyAllowance, calculateFinanceBudgetInsight, isSleepActivity, type BudgetTension, type DailyAllowance, type FinanceBudgetInsight} from '@/services/dynamic-insights';
import type {Notification, Transaction, WithId} from '@/types/smartlife';

/**
 * The bell's contents are derived, not stored. Firestore rules forbid the
 * client from creating a notification (`allow create: if false`), and deriving
 * them has the property the stored ones cannot give: an alert exists only while
 * its condition holds. Spending drops back under the line, a task is marked
 * done, the month rolls over -- the alert simply stops being produced, with no
 * cleanup pass and nothing left claiming something that is no longer true.
 *
 * Every signal below is read from the same functions the Calendar, Finance and
 * Notes screens already use, so the bell cannot become a fourth opinion that
 * disagrees with the screen it points at.
 */
export type FeedSource = 'calendar' | 'finance' | 'note' | 'stored';
export type FeedSeverity = 'urgent' | 'warning' | 'info';

export type FeedItem = {
  /** Stable within a load, so lists can key on it. */
  id: string;
  kind: Notification['kind'];
  /** Why it is flagged, in the user's words. */
  message: string;
  /** Short supporting facts, e.g. the priority reasons the AI card shows. */
  reasons: string[];
  severity: FeedSeverity;
  source: FeedSource;
  title: string;
  /** Only stored notifications carry a real read flag; derived items are live. */
  unread: boolean;
};

type Item = Record<string, unknown>;

const HIGH_PRIORITY = /urgent|high|important|ด่วน|สูง|สำคัญ/i;
const IMPORTANT_WORDS = ['quiz', 'สอบ', 'ส่ง', 'deadline', 'ด่วน', 'ต้องทำ', 'ประชุม', 'นำเสนอ', 'รายงาน', 'โปรเจค', 'project', 'assignment', 'homework'];

export function itemsOf(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === 'object') : [];
}

export function string(item: Item, key: string, fallback = '-') {
  const value = item[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function millis(item: Item) {
  const date = new Date(String(item.startAt ?? item.dueAt ?? item.createdAt ?? ''));
  return Number.isNaN(date.getTime()) ? Number.POSITIVE_INFINITY : date.getTime();
}

function itemText(item: Item) {
  return `${string(item, 'title', '')} ${string(item, 'note', '')} ${string(item, 'details', '')} ${string(item, 'category', '')}`.toLowerCase();
}

function hoursUntil(item: Item, now: Date) {
  return (millis(item) - now.getTime()) / 36e5;
}

/**
 * The ranking behind the "AI จัดลำดับวันนี้" card. It lives here rather than in
 * the dashboard screen so the card and the bell score the same item the same
 * way; the screen imports it back.
 */
export function priorityScore(item: Item, now = new Date()) {
  const text = itemText(item);
  const type = string(item, 'type', string(item, 'category', ''));
  let score = 0;
  if (/task|งาน|assignment|homework/i.test(type)) score += 40;
  if (/appointment|นัด|ประชุม/i.test(type)) score += 28;
  if (/activity|class|เรียน/i.test(type)) score += 18;
  if (HIGH_PRIORITY.test(string(item, 'priority', ''))) score += 24;
  IMPORTANT_WORDS.forEach((word) => { if (text.includes(word.toLowerCase())) score += 10; });
  const until = hoursUntil(item, now);
  if (until <= 0) score += 34;
  else if (until <= 24) score += 30;
  else if (until <= 72) score += 18;
  else if (until <= 168) score += 8;
  return score;
}

export function priorityReasons(item: Item, now = new Date()) {
  const reasons: string[] = [];
  const text = itemText(item);
  const type = string(item, 'type', string(item, 'category', ''));
  const until = hoursUntil(item, now);
  if (/task|งาน|assignment|homework/i.test(type)) reasons.push('เป็นงานที่ต้องทำ');
  if (/appointment|นัด|ประชุม/i.test(type)) reasons.push('เป็นนัดหมาย/ประชุม');
  if (HIGH_PRIORITY.test(string(item, 'priority', ''))) reasons.push('ตั้งความสำคัญไว้สูง');
  if (until <= 0) reasons.push('เลยกำหนดหรือถึงเวลาแล้ว');
  else if (until <= 24) reasons.push('กำหนดภายในวันนี้');
  else if (until <= 72) reasons.push('ใกล้ deadline');
  const matched = IMPORTANT_WORDS.find((word) => text.includes(word.toLowerCase()));
  if (matched) reasons.push(`พบคำสำคัญ: ${matched}`);
  return reasons.slice(0, 3);
}

/** Completed work is never urgent, whatever it scores. */
export function isOpen(item: Item) {
  return item.status !== 'completed' && !item.completedAt;
}

/**
 * A logged night is a record of something that happened, not work waiting to be
 * done, so it never belongs in a priority ranking or the bell. This reuses the
 * burnout model's own predicate rather than re-deriving one, so the two can
 * never disagree about what counts as sleep.
 */
export function isRankable(item: Item) {
  return !isSleepActivity(item);
}

/**
 * The urgent band the AI card already rewards most heavily: due within a day
 * (or already past due), or explicitly flagged high priority. Expressed once
 * here so the bell flags exactly the items the card calls "ด่วน".
 */
export function isCalendarUrgent(item: Item, now = new Date()) {
  return isRankable(item) && isOpen(item) && (hoursUntil(item, now) <= 24 || HIGH_PRIORITY.test(string(item, 'priority', '')));
}

/** Notes carry their own priority field; `important` and `urgent` both count. */
export function isNoteImportant(item: Item) {
  return isOpen(item) && /urgent|important|ด่วน|สำคัญ/i.test(string(item, 'priority', ''));
}

function money(value: number) {
  return `฿${Math.round(Math.abs(value)).toLocaleString('th-TH')}`;
}

function calendarAlerts(activities: Item[], now: Date): FeedItem[] {
  return activities
    .filter((item) => isCalendarUrgent(item, now))
    .sort((a, b) => priorityScore(b, now) - priorityScore(a, now) || millis(a) - millis(b))
    .map((item, index) => ({
      id: `calendar:${string(item, 'id', String(index))}`,
      kind: 'schedule' as const,
      message: `คะแนนความเร่งด่วน ${priorityScore(item, now)} จากตารางและกำหนดส่ง`,
      reasons: priorityReasons(item, now),
      severity: hoursUntil(item, now) <= 0 ? 'urgent' as const : 'warning' as const,
      source: 'calendar' as const,
      title: string(item, 'title', 'รายการในตาราง'),
      unread: true,
    }));
}

function noteAlerts(notes: Item[]): FeedItem[] {
  return notes.filter(isNoteImportant).map((item, index) => ({
    id: `note:${string(item, 'id', String(index))}`,
    kind: 'urgent' as const,
    message: `โน้ตนี้ถูกตั้งความสำคัญไว้เป็น ${string(item, 'priority', 'important')} และยังไม่ถูกปิด`,
    reasons: [`หมวด ${string(item, 'category', 'ทั่วไป')}`],
    severity: /urgent|ด่วน/i.test(string(item, 'priority', '')) ? 'urgent' as const : 'warning' as const,
    source: 'note' as const,
    title: string(item, 'title', 'โน้ตสำคัญ'),
    unread: true,
  }));
}

/**
 * Budget alerts, read entirely off the existing calculators: the monthly and
 * weekly windows come from `calculateFinanceBudgetInsight`, today's pressure
 * from `calculateBudgetTension`, and the daily allowance from
 * `calculateDailyAllowance` -- the same number the dashboard tile shows.
 */
function financeAlerts(insight: FinanceBudgetInsight | null, allowance: DailyAllowance | null, tension: BudgetTension | null): FeedItem[] {
  const alerts: FeedItem[] = [];
  if (!insight) return alerts;

  if (insight.remainingBudget < 0) {
    alerts.push({
      id: 'finance:month',
      kind: 'finance',
      message: `ใช้ไป ${money(insight.spentSoFar)} จากลิมิต ${money(insight.monthlyBudget)} เกินมา ${money(insight.remainingBudget)}`,
      reasons: [`เดือน ${insight.monthKey}`],
      severity: 'urgent',
      source: 'finance',
      title: 'เกินงบเดือนนี้แล้ว',
      unread: true,
    });
  }

  if (insight.weeklyStatus !== 'safe') {
    const exceeded = insight.weeklyStatus === 'exceeded';
    alerts.push({
      id: 'finance:week',
      kind: 'finance',
      message: exceeded
        ? `สัปดาห์นี้ใช้ ${money(insight.weekSpent)} จากงบสัปดาห์ ${money(insight.weeklyBudget)} เกินมา ${money(insight.weeklyRemainingBudget)}`
        : `สัปดาห์นี้ใช้ไปแล้ว ${insight.weeklyUsagePercent}% ของงบสัปดาห์ เหลือ ${money(insight.weeklyRemainingBudget)}`,
      reasons: [`ช่วง ${insight.weekStart} ถึง ${insight.weekEnd}`],
      severity: exceeded ? 'urgent' : 'warning',
      source: 'finance',
      title: exceeded ? 'เกินงบสัปดาห์นี้' : 'ใกล้เต็มงบสัปดาห์นี้',
      unread: true,
    });
  }

  // Today's pressure only reads as news while the month still has room; once
  // the month is blown the alert above already says something stronger.
  if (tension && insight.remainingBudget >= 0 && (tension.level === 'over-budget' || tension.level === 'very-tight')) {
    const over = tension.todayRemaining < 0;
    alerts.push({
      id: 'finance:day',
      kind: 'finance',
      message: over
        ? `วันนี้ใช้ ${money(tension.todaySpent)} จากลิมิตวันละ ${money(tension.dailyLimit)} เกินมา ${money(tension.todayRemaining)}`
        : `วันนี้ใช้ ${money(tension.todaySpent)} จากลิมิตวันละ ${money(tension.dailyLimit)} เหลือ ${money(tension.todayRemaining)}`,
      reasons: allowance ? [`งบที่ใช้ได้ต่อวัน ${money(allowance.amount)}`, tension.label] : [tension.label],
      severity: over ? 'urgent' : 'warning',
      source: 'finance',
      title: over ? 'เกินงบวันนี้' : 'งบวันนี้เริ่มตึง',
      unread: true,
    });
  }

  return alerts;
}

/**
 * Spending measured against money actually received, rather than against a
 * limit the user chose.
 *
 * `financeAlerts` above returns nothing at all until a monthly budget exists,
 * so an account that never set one -- or set one far larger than it really
 * earns -- stayed silent while a single expense dwarfed every baht taken in.
 * This check needs no budget. It reads the same month-scoped transactions the
 * callers already pass, which is why it covers every write path at once: manual
 * entry, the rows the assistant writes, and receipts saved server-side by the
 * `saveReviewedReceipt` function, which never touches `transactions.create`.
 *
 * Amounts are stored positive with the direction carried by `type`, so the
 * totals below compare like with like.
 */
function fundsAlerts(transactions: Pick<Transaction, 'amount' | 'occurredAt' | 'type'>[]): FeedItem[] {
  const value = (item: {amount?: number}) => Math.abs(Number(item.amount ?? 0));
  const total = (kind: Transaction['type']) => transactions
    .filter((item) => item.type === kind)
    .reduce((sum, item) => sum + value(item), 0);
  const income = total('income');
  const expense = total('expense');

  // Income has to be on record for this to mean anything. With none logged the
  // available balance is unknown rather than zero -- plenty of people track
  // only what they spend -- and claiming they had overspent would be a guess.
  // The reported case had ฿100,500 of income on record, so it is covered.
  if (income <= 0 || expense <= income) return [];

  // The single row most responsible is named, because the case this was built
  // for was one mistyped entry rather than a month of gradual drift.
  const expenses = transactions.filter((item) => item.type === 'expense');
  const largest = expenses.reduce((top, item) => (value(item) > value(top) ? item : top));
  const reasons = [`รายรับเดือนนี้ ${money(income)} · รายจ่าย ${money(expense)}`];
  if (value(largest) > income) {
    reasons.push(`รายการเดียวที่ ${money(value(largest))} ก็เกินรายรับทั้งเดือนแล้ว`);
  }

  return [{
    id: 'finance:funds',
    kind: 'finance',
    message: `ใช้ไป ${money(expense)} แต่รับเข้ามา ${money(income)} เกินเงินที่มีอยู่ ${money(expense - income)}`,
    reasons,
    severity: 'urgent',
    source: 'finance',
    title: 'รายจ่ายเกินเงินที่มี',
    unread: true,
  }];
}

function storedAlerts(stored: WithId<Notification>[]): FeedItem[] {
  return stored.map((item) => ({
    id: `stored:${item.id}`,
    kind: item.kind,
    message: item.message,
    reasons: [],
    severity: item.kind === 'urgent' ? 'urgent' as const : 'info' as const,
    source: 'stored' as const,
    title: item.title,
    unread: item.read !== true,
  }));
}

const SEVERITY_ORDER: Record<FeedSeverity, number> = {urgent: 0, warning: 1, info: 2};

/**
 * Everything the bell should currently be saying, newest concern first.
 * `stored` are the documents the server writes (admin announcements, adaptive
 * scheduling); the rest are derived from data the caller already holds.
 */
export function buildNotificationFeed({activities, dailyBudget, monthlyBudget, monthTransactions, notes, now = new Date(), stored = [], todayExpenses = [], weeklyBudget}: {
  activities?: unknown;
  /** A daily limit the user set; omitted, the monthly amount is split evenly. */
  dailyBudget?: number;
  monthlyBudget?: number;
  monthTransactions?: Pick<Transaction, 'amount' | 'occurredAt' | 'type'>[];
  notes?: unknown;
  now?: Date;
  stored?: WithId<Notification>[];
  todayExpenses?: {amount: number}[];
  /** A weekly limit the user set; omitted, the monthly amount is split evenly. */
  weeklyBudget?: number;
}): FeedItem[] {
  const budget = monthlyBudget ?? 0;
  const transactions = monthTransactions ?? [];
  const insight = calculateFinanceBudgetInsight({dailyBudget, monthlyBudget: budget, now, transactions, weeklyBudget});
  const allowance = calculateDailyAllowance({dailyBudget, monthlyBudget: budget, now, transactions, weeklyBudget});
  const tension = calculateBudgetTension({
    dailyBudget,
    monthlyBudget: budget,
    now,
    todaySpent: todayExpenses.reduce((sum, item) => sum + Number(item.amount ?? 0), 0),
  });

  return [
    ...financeAlerts(insight, allowance, tension),
    ...fundsAlerts(transactions),
    ...calendarAlerts(itemsOf(activities), now),
    ...noteAlerts(itemsOf(notes)),
    ...storedAlerts(stored),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * What the badge shows: alerts that are true right now, plus stored
 * notifications that have genuinely not been read. A derived alert has no read
 * flag to carry, so it counts while its condition holds and stops counting the
 * moment it does not.
 */
export function unreadCount(feed: FeedItem[]) {
  return feed.filter((item) => item.unread).length;
}
