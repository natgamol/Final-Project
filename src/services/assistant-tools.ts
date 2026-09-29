import {Timestamp} from 'firebase/firestore';
import {getFunctions, httpsCallable} from 'firebase/functions';

import {isDemoMode} from '@/lib/demo-mode';
import {ensureAppCheckReady} from '@/lib/app-check';
import {auth, firebaseApp} from '@/lib/firebase';
import {shiftDateKey, thailandAtHour, thailandRange, thailandDateKey, thailandDayStart, thailandTimeKey, thailandWallClockToDate, thailandWeekday} from '@/lib/thailand-time';
import {
  explicitMutationClause,
  financeMutationKind,
  isExplicitNoteMutation,
  isReadOnlyOrAdviceRequest,
  readOnlyClausesFromMixedMessage,
} from '@/services/assistant-action-intent';
import {withAssistantAuthRetry} from '@/services/assistant-auth-retry';
import {assistantErrorMessage, classifyAssistantError} from '@/services/assistant-error';
import {
  deterministicFinancialScenarioAnswer,
  shouldUseDeterministicFinancialScenario,
} from '@/services/assistant-financial-scenario';
import {classifyAssistantIntent, latestConversationIntent, type AssistantIntent} from '@/services/assistant-intent';
import {loadAssistantPreferences, saveAssistantPreference, type AssistantPreferences} from '@/services/assistant-memory';
import {isNoteLookupIntent, noteLookupTerms} from '@/services/assistant-note-intent';
import {chooseAssistantExecutionRoute, chooseAssistantResponseMode, isSavingsPlanningRequest} from '@/services/assistant-response-strategy';
import {isReceiptImageLookupRequest, selfContainedAssistantFallback} from '@/services/assistant-safe-fallback';
import {rankAssistantTasks} from '@/services/assistant-task-ranking';
import {
  calculateBurnoutDynamicInsight,
  calculateFinanceBudgetInsight,
  SLEEP_REFERENCE,
  type SmartLifeDynamicInsight,
} from '@/services/dynamic-insights';
import {adaptiveScheduling} from '@/services/adaptive-scheduling';
import {activities, findScheduleConflicts, notes, scanLogs, schedules, transactions} from '@/services/firestore';
import {currentMonthKey, loadMonthlyBudget} from '@/services/monthly-budget';
import {baselineNightHours, loadSleepBaseline} from '@/services/sleep-log';
import {activityForFreeSlot, TRUSTED_COACHING_SOURCES, WELLBEING_AI_DISCLAIMER} from '@/config/trusted-coaching-knowledge';
import {burnoutRiskBand} from '@/constants/burnout-risk';
import type {AssistantChatMessage, AssistantConversationState, AssistantConversationStatePatch, AssistantErrorKind, AssistantFeedbackRating, AssistantMemoryPayload, AssistantPendingTaskShortcut, AssistantProposedAction, AssistantReplySource, AssistantResponseMode, AssistantToolSchema, ChecklistPayload, FinancePayload, NotePayload, SchedulePayload} from '@/types/assistant';
import type {Activity, Note, ScanLog, Schedule, Transaction, WithId} from '@/types/smartlife';

export const assistantToolSchemas: AssistantToolSchema[] = [
  {description: 'อ่านตารางเรียน กิจกรรม วันสอบ งานส่ง และสถานที่จากข้อมูลจริงของผู้ใช้', mutates: false, name: 'get_user_schedule', parameters: {date: 'ISO date', range: ['day', 'week', 'month']}},
  {description: 'อ่านงานค้างและงานเร่งด่วนจากกิจกรรมที่ผู้ใช้บันทึกไว้', mutates: false, name: 'get_pending_tasks', parameters: {range: ['day', 'week', 'month']}},
  {description: 'เสนอสร้างกิจกรรม งาน หรือนัดหมาย และรอผู้ใช้ยืนยันก่อนเขียน', mutates: true, name: 'add_event', parameters: {payload: 'SchedulePayload'}},
  {description: 'เสนอแก้ไขรายการตาราง ต้อง confirm ก่อนเขียน', mutates: true, name: 'update_schedule_item', parameters: {id: 'string', payload: 'partial SchedulePayload'}},
  {description: 'เสนอ delete รายการตาราง ต้อง confirm ก่อนเขียน', mutates: true, name: 'delete_schedule_item', parameters: {id: 'string'}},
  {description: 'อ่านยอดคงเหลือ งบรายสัปดาห์ สัดส่วนที่ใช้ไป และรายการการเงินจริงตามช่วงเวลา', mutates: false, name: 'get_financial_summary', parameters: {category: 'optional category', timeframe: ['today', 'week', 'month']}},
  {description: 'ประเมินสัญญาณความเสี่ยงหมดไฟจากตาราง งานค้าง และกิจกรรมการนอนที่ผู้ใช้บันทึกจริง โดยไม่วินิจฉัยโรค', mutates: false, name: 'get_wellbeing_summary', parameters: {range: ['week']}},
  {description: 'เสนอเพิ่มรายรับหรือรายจ่าย และรอผู้ใช้ยืนยันก่อนเขียน', mutates: true, name: 'add_transaction', parameters: {payload: 'FinancePayload'}},
  {description: 'อ่านโน้ตล่าสุดจากข้อมูลจริงของผู้ใช้', mutates: false, name: 'get_user_notes', parameters: {tag: ['all', 'class', 'idea', 'task']}},
  {description: 'เสนอสร้างโน้ต และรอผู้ใช้ยืนยันก่อนเขียน', mutates: true, name: 'add_note', parameters: {payload: 'NotePayload'}},
  {description: 'เสนอแก้ไขโน้ต ต้อง confirm ก่อนเขียน', mutates: true, name: 'update_note', parameters: {id: 'string', payload: 'partial NotePayload'}},
  {description: 'เสนอจดจำงบหรือช่วงโฟกัสส่วนตัวในเครื่อง ต้อง confirm ก่อนบันทึก', mutates: true, name: 'save_preference', parameters: {key: ['dailyBudget', 'studyMinutes'], value: 'number'}},
];

export type AssistantContext = {
  availability: Record<'finance' | 'notes' | 'ocr' | 'schedules' | 'tasks', 'available' | 'failed' | 'partial'>;
  balance: number;
  dynamic: SmartLifeDynamicInsight;
  monthExpense: number;
  monthIncome: number;
  monthTransactions: WithId<Transaction>[];
  notes: WithId<Note>[];
  pendingTasks: WithId<Activity>[];
  recentScanLogs: WithId<ScanLog>[];
  todayActivities: WithId<Activity>[];
  todaySchedules: WithId<Schedule>[];
  upcomingActivities: WithId<Activity>[];
  upcomingSchedules: WithId<Schedule>[];
  weekActivities: WithId<Activity>[];
  weekSchedules: WithId<Schedule>[];
  weekTransactions: WithId<Transaction>[];
};

const THAI_TIME_ZONE = 'Asia/Bangkok';
const EXAM_PATTERN = /(สอบ|กลางภาค|ปลายภาค|midterm|final|quiz|ควิซ|test|exam)/i;
const assistantFunctions = getFunctions(firebaseApp, 'asia-southeast1');
const smartLifeAssistantReply = httpsCallable<
  {clientDynamicContext?: SmartLifeDynamicInsight; conversationId: string; conversationState: AssistantConversationState; history?: {content: string; role: 'assistant' | 'user'}[]; intent: AssistantIntent; message: string; responseMode: AssistantResponseMode},
  {content: string; selectedTask?: {dueAt?: string; title: string}; suggestions?: string[]}
>(assistantFunctions, 'smartLifeAssistantReply');
const assistantTelemetry = httpsCallable<
  {
    errorKind?: AssistantErrorKind;
    helpful?: AssistantFeedbackRating;
    intent: AssistantIntent;
    interactionId: string;
    latencyMs: number;
    source: AssistantReplySource;
  },
  {ok: true}
>(assistantFunctions, 'assistantTelemetry');

export type AssistantReply = {
  content: string;
  errorKind?: AssistantErrorKind;
  intent: AssistantIntent;
  latencyMs: number;
  pendingTaskShortcuts?: AssistantPendingTaskShortcut[];
  proposedAction?: AssistantProposedAction;
  source: AssistantReplySource;
  statePatch?: AssistantConversationStatePatch;
  suggestions?: string[];
};

export async function recordAssistantTelemetry(data: {
  errorKind?: AssistantErrorKind;
  helpful?: AssistantFeedbackRating;
  intent: AssistantIntent;
  interactionId: string;
  latencyMs: number;
  source: AssistantReplySource;
}) {
  if (isDemoMode) return;
  await ensureAppCheckReady();
  await assistantTelemetry(data);
}

function rangeFor(period: 'day' | 'month' | 'week', base = new Date()) {
  const {from, to} = thailandRange(period, base);
  return {end: new Date(to.getTime() + 1), start: from};
}

function parseAmount(message: string) {
  const match = message.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:บาท|฿|thb)?/i);
  const amount = match ? Number(match[1]) : 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

const THAI_DIGITS: Record<string, string> = {
  '๐': '0',
  '๑': '1',
  '๒': '2',
  '๓': '3',
  '๔': '4',
  '๕': '5',
  '๖': '6',
  '๗': '7',
  '๘': '8',
  '๙': '9',
};

function normalizeNaturalLanguageInput(message: string) {
  return message
    // Preserve Thai SARA AM so words such as "ทำ", "คำ" and "แนะนำ"
    // remain compatible with the intent and response patterns below.
    .normalize('NFC')
    .replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit] ?? digit)
    .replace(/([ก-๙])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[ก-๙])/g, '$1 ')
    .replace(/เท่าไหร(?:่)?|เท่าไหหล่|เท่าไหร่หรอ/gi, 'เท่าไหร่')
    .replace(/ยังงัย|ยังไงดีอะ|ยังไงอะ/gi, 'ยังไง')
    .replace(/มีไรบ้าง|มีอะไรมั่ง/gi, 'มีอะไรบ้าง')
    .replace(/งานไรบ้าง/gi, 'งานอะไรบ้าง')
    .replace(/พฤหัดบดี|พฤหัด/gi, 'พฤหัสบดี')
    .replace(/\s+/g, ' ')
    .trim();
}

const THAI_MONTHS: [RegExp, number][] = [
  [/(?:ม\.?\s*ค\.?|มกราคม)/i, 0],
  [/(?:ก\.?\s*พ\.?|กุมภาพันธ์)/i, 1],
  [/(?:มี\.?\s*ค\.?|มีนาคม)/i, 2],
  [/(?:เม\.?\s*ย\.?|เมษายน)/i, 3],
  [/(?:พ\.?\s*ค\.?|พฤษภาคม)/i, 4],
  [/(?:มิ\.?\s*ย\.?|มิถุนายน)/i, 5],
  [/(?:ก\.?\s*ค\.?|กรกฎาคม)/i, 6],
  [/(?:ส\.?\s*ค\.?|สิงหาคม)/i, 7],
  [/(?:ก\.?\s*ย\.?|กันยายน)/i, 8],
  [/(?:ต\.?\s*ค\.?|ตุลาคม)/i, 9],
  [/(?:พ\.?\s*ย\.?|พฤศจิกายน)/i, 10],
  [/(?:ธ\.?\s*ค\.?|ธันวาคม)/i, 11],
];

function parseThaiNamedDate(message: string, now = new Date()) {
  for (const [monthPattern, monthIndex] of THAI_MONTHS) {
    // The year group must not swallow the hour of a time that follows the
    // month: in "1 มกราคม 09:00" it captured "09" and produced the year 2009.
    // The lookahead rejects a number that runs on into more digits or into a
    // clock separator, while still accepting a year at the end of a sentence
    // ("1 มกราคม 2027.") and a year that is itself followed by a time.
    const match = message.match(
      new RegExp(`(\\d{1,2})\\s*(${monthPattern.source})(?:\\s*(\\d{2,4})(?!\\d|[:.]\\d))?`, 'i'),
    );
    if (!match) continue;

    let year = match[3] ? Number(match[3]) : Number(thailandDateKey(now).slice(0, 4));
    if (year < 100) year += year >= 50 ? 2500 : 2000;
    if (year > 2400) year -= 543;

    // "12 มีนาคม" names a day on a Thai calendar, so it resolves to midnight in
    // Bangkok. `new Date(year, monthIndex, day)` resolves it to midnight on the
    // device instead -- a different instant, and anywhere but UTC+7 a different
    // day, while every screen renders the result in Bangkok.
    const dayKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
    const date = thailandWallClockToDate(dayKey, '00:00');
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Turns "พรุ่งนี้บ่าย 3" into the instant it names.
 *
 * The day and the time are both wall clock as a user in Thailand means them,
 * and every caller renders the result with `timeZone: 'Asia/Bangkok'`, so this
 * works in Bangkok keys and converts once at the end. Building it with
 * `new Date(y, m, d)` and `setHours` reads and writes the device's clock, which
 * agrees with Bangkok only on a UTC+7 device -- the same bug the activity form
 * had, and worse here, because "พรุ่งนี้" was resolved from the device's idea of
 * what today is.
 */
function parseStartAt(message: string) {
  const now = new Date();
  const explicitDate = message.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/) ??
    message.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/);
  const thaiNamedDate = parseThaiNamedDate(message, now);
  const todayKey = thailandDateKey(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  const at = (hour: number, minute: number) => `${pad(Math.max(0, Math.min(23, hour)))}:${pad(Math.max(0, Math.min(59, minute)))}`;
  let dateKey = todayKey;
  let timeKey = thailandTimeKey(now);
  if (explicitDate) {
    const isIso = explicitDate[0].includes('-') && explicitDate[1].length === 4;
    let year = Number(isIso ? explicitDate[1] : explicitDate[3]);
    const month = Number(explicitDate[2]);
    const day = Number(isIso ? explicitDate[3] : explicitDate[1]);
    if (year < 100) year += 2000;
    if (year > 2400) year -= 543;
    dateKey = `${year}-${pad(month)}-${pad(day)}`;
  } else if (thaiNamedDate) {
    dateKey = thailandDateKey(thaiNamedDate);
  } else {
    const weekdayMatch = message.match(/วัน?(อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์)/i)?.[1];
    const weekdayIndexes: Record<string, number> = {
      อาทิตย์: 0,
      จันทร์: 1,
      อังคาร: 2,
      พุธ: 3,
      พฤหัส: 4,
      พฤหัสบดี: 4,
      ศุกร์: 5,
      เสาร์: 6,
    };
    if (weekdayMatch) {
      let offset = (weekdayIndexes[weekdayMatch] - thailandWeekday(now) + 7) % 7;
      if (/สัปดาห์หน้า|อาทิตย์หน้า|วีคหน้า/i.test(message)) offset += 7;
      dateKey = shiftDateKey(todayKey, offset);
    } else {
      const dayOffset = /มะรืน/i.test(message) ? 2 : /พรุ่งนี้|tomorrow/i.test(message) ? 1 : 0;
      dateKey = shiftDateKey(todayKey, dayOffset);
    }
  }

  const half = /ครึ่ง/.test(message) ? 30 : 0;
  const explicit = message.match(/([01]?\d|2[0-3])[:.](\d{2})/);
  const evening = message.match(/(\d{1,2})\s*ทุ่ม/);
  if (explicit) {
    timeKey = at(Number(explicit[1]), Number(explicit[2]));
  } else if (/เที่ยง/.test(message)) {
    timeKey = at(12, half);
  } else if (/บ่าย/.test(message)) {
    timeKey = at(Number(message.match(/บ่าย\s*(\d)/)?.[1] ?? 1) + 12, half);
  } else if (/เย็น/.test(message)) {
    const hour = Number(message.match(/(\d{1,2})\s*(?:โมง)?\s*เย็น/)?.[1] ?? 5);
    timeKey = at(hour >= 12 ? hour : hour + 12, half);
  } else if (evening) {
    timeKey = at(Number(evening[1]) + 18, half);
  } else {
    timeKey = at(Number(message.match(/(\d{1,2})\s*โมง/)?.[1] ?? 9), half);
  }
  return thailandWallClockToDate(dateKey, timeKey);
}

function hasExplicitTime(message: string) {
  return /([01]?\d|2[0-3])[:.](\d{2})(?:\s*(?:-|–|ถึง)\s*([01]?\d|2[0-3])[:.](\d{2}))?|(?:ตอน|เวลา)\s*\d{1,2}|(?:บ่าย\s*\d{1,2}|\d{1,2}\s*(?:โมง(?:เช้า|เย็น)?|ทุ่ม))/i.test(message);
}

function hasExplicitDate(message: string) {
  return /(?:วันนี้|พรุ่งนี้|มะรืน|สัปดาห์หน้า|อาทิตย์หน้า|วีคหน้า|วัน?(?:อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์)|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b)/i
    .test(message) || Boolean(parseThaiNamedDate(message));
}

function parseEndAt(message: string, start: Date) {
  const range = message.match(/([01]?\d|2[0-3])[:.](\d{2})\s*(?:-|–|ถึง)\s*([01]?\d|2[0-3])[:.](\d{2})/);
  if (!range) return new Date(start.getTime() + 60 * 60 * 1000);
  // "13:00-15:00" is a Bangkok wall-clock range on the same Bangkok day as the
  // start, rolling to the next one when the end reads earlier than the start.
  const end = thailandAtHour(start, Number(range[3]), Number(range[4]));
  return end <= start ? thailandAtHour(start, Number(range[3]), Number(range[4]), 1) : end;
}

function isAdviceOrLookupIntent(message: string) {
  return isReadOnlyOrAdviceRequest(message) ||
    /(จัดลำดับ|งานไหน.*(?:กำหนดส่ง|ใกล้ส่ง)|ใกล้.*(?:กำหนดส่ง|เดดไลน์)|(?:กำหนดส่ง|เดดไลน์).*ใกล้|ใช้.*(?:กี่|ต่อ|วัน|สัปดาห์|เดือน)|พอ.*(?:วัน|สัปดาห์|เดือน)|อะไร.*ก่อน|วิชา.*ก่อน|อ่าน.*ก่อน|ก่อนดี|หรือยัง|สำคัญ.*แค่ไหน|\?)/i.test(message);
}

function isScheduleIntent(message: string) {
  // "กำหนดส่ง" is a deadline field, not a command to create a schedule.
  const explicitWrite = /(เพิ่ม|สร้าง|บันทึก|จด|ลง(?:ใน)?ตาราง|จัดตาราง|กำหนด(?:เวลา|นัด|ตาราง)|เตือน|นัดให้)/i.test(message);
  const statesNewTask = /มีงาน.+(?:ต้องส่ง|ส่งวันที่|กำหนดส่ง|เดดไลน์)/i.test(message);
  // "ตอนนี้" is a time reference used by finance commands too. It is not
  // schedule evidence unless an actual clock time or schedule noun exists.
  const scheduleRecord = /(นัด|ตาราง|เวลา|เรียน|lab|แล็บ|แลบ|quiz|ควิซ|สอบ|schedule|task|งาน)/i.test(message) || hasExplicitTime(message);
  return (explicitWrite || statesNewTask) && scheduleRecord;
}

function scheduleTitleFromMessage(message: string, fallback: string) {
  return message
    .replace(/^(ช่วย)?\s*(เพิ่ม|บันทึก|สร้าง)\s*/i, '')
    .replace(/^(ให้)?\s*(มี)?\s*(นัด|ตาราง|เวลา)?\s*/i, '')
    .replace(/(วันนี้|พรุ่งนี้|ตอน|เวลา|ที่|ห้อง)\s*.*/i, '')
    .replace(/([01]?\d|2[0-3])[:.]\d{2}.*$/i, '')
    .trim()
    .slice(0, 80) || fallback;
}

function explicitScheduleTitle(message: string) {
  return scheduleTitleFromMessage(message, '')
    .replace(/^(?:มี)?\s*(?:งาน|นัด|กิจกรรม|คลาส)\s*/i, '')
    .replace(/วัน(?:อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์)(?:นี้|หน้า)?/gi, ' ')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, ' ')
    .replace(/(?:บ่าย\s*\d{1,2}|\d{1,2}\s*(?:โมง(?:เช้า|เย็น)?|ทุ่ม)|\d{1,2}[:.]\d{2}).*$/i, ' ')
    .replace(/(?:ต้องส่ง|กำหนดส่ง|เดดไลน์|ส่งวันที่)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scheduleCreationClarification(message: string) {
  const actionMessage = explicitMutationClause(message) ?? message.trim();
  if (financeMutationKind(actionMessage, parseAmount(actionMessage))) return null;
  if (!actionMessage || isAdviceOrLookupIntent(actionMessage) || !isScheduleIntent(actionMessage)) return null;
  if (!explicitScheduleTitle(actionMessage)) return 'ต้องการตั้งชื่องานหรือกิจกรรมว่าอะไรครับ';
  if (!hasExplicitDate(actionMessage)) return 'ต้องการให้บันทึกงานหรือกิจกรรมนี้ในวันไหนครับ';
  if (!hasExplicitTime(actionMessage)) return 'ต้องการให้กำหนดเวลากี่โมงครับ';
  return null;
}

function actionId() {
  return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function textDate(date: Date) {
  return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeStyle: 'short', timeZone: THAI_TIME_ZONE}).format(date);
}

function titleFromMessage(message: string, fallback: string) {
  return message
    .replace(/^(ช่วย)?(เพิ่ม|บันทึก|จด|สร้าง)\s*/i, '')
    .replace(/(พรุ่งนี้|วันนี้|ตอน|เวลา|ที่|จำนวน|ราคา|บาท|฿).*/i, '')
    .trim()
    .slice(0, 80) || fallback;
}

function noteTitleFromMessage(message: string) {
  const title = message
    .replace(/^(?:ช่วย)?\s*(?:เพิ่ม|บันทึก|จด|สร้าง)\s*(?:โน้ต|note|บันทึก)?\s*(?:ให้)?\s*(?:หน่อย)?\s*/i, '')
    .replace(/^(?:ว่า|เรื่อง|เมื่อ|สำหรับ|ต้อง)\s*/i, '')
    .replace(/(?:วันที่|วันนี้|พรุ่งนี้|คืนนี้|วัน(?:จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์)|เวลา|ตอน)\s*.*/i, '')
    .replace(/\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}.*$/i, '')
    .replace(/(?:ด้วย|นะ|ครับ|ค่ะ|คับ|หน่อย)\s*$/i, '')
    .trim();
  return title.slice(0, 80) || 'โน้ตใหม่';
}

function noteBodyFromMessage(message: string) {
  const body = message
    .replace(/^(?:ช่วย)?\s*(?:เพิ่ม|บันทึก|จด|สร้าง)\s*(?:โน้ต|note|บันทึก)?\s*(?:ให้)?\s*(?:หน่อย)?\s*/i, '')
    .replace(/^(?:ว่า|เรื่อง|เมื่อ|สำหรับ)\s*/i, '')
    .trim();
  return body || message.trim();
}

function noteTagFromMessage(message: string): NotePayload['tag'] {
  if (/(ไอเดีย|idea)/i.test(message)) return 'idea';
  if (/(อ่านหนังสือ|ทบทวน|เรียน|วิชา|สอบ)/i.test(message)) return 'class';
  if (/(ทำการบ้าน|ทำงาน|ส่งงาน|โปรเจกต์|project|task)/i.test(message)) return 'task';
  return 'all';
}

async function loadAssistantContextSources(uid: string) {
  const today = rangeFor('day');
  const week = rangeFor('week');
  const month = rangeFor('month');
  const wellbeingStart = new Date(today.start);
  wellbeingStart.setDate(wellbeingStart.getDate() - 6);
  const upcomingEnd = new Date(today.start);
  // Look across a full semester so exam dates are not missed when they are
  // more than two months away.
  upcomingEnd.setDate(upcomingEnd.getDate() + 180);
  const monthQueryEnd = new Date(month.end.getTime() - 1);
  const results = await Promise.allSettled([
    schedules.between(uid, today.start, today.end),
    activities.between(uid, today.start, today.end),
    schedules.between(uid, week.start, week.end),
    activities.between(uid, week.start, week.end),
    schedules.between(uid, today.start, upcomingEnd),
    activities.between(uid, today.start, upcomingEnd),
    activities.listTasks(uid),
    transactions.between(uid, week.start, new Date(week.end.getTime() - 1)),
    transactions.between(uid, month.start, monthQueryEnd),
    notes.list(uid),
    scanLogs.list(uid),
    schedules.between(uid, wellbeingStart, today.end),
    activities.between(uid, wellbeingStart, today.end),
  ]);
  return results;
}

function settledValue<T>(result: PromiseSettledResult<T>): T | [] {
  return result.status === 'fulfilled' ? result.value : [];
}

function sourceAvailability(results: PromiseSettledResult<unknown>[]) {
  const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
  if (fulfilled === results.length) return 'available' as const;
  if (fulfilled === 0) return 'failed' as const;
  return 'partial' as const;
}

export async function loadAssistantContext(uid: string): Promise<AssistantContext> {
  let results = await loadAssistantContextSources(uid);
  const authenticationFailures = results.filter((result) =>
    result.status === 'rejected' && classifyAssistantError(result.reason) === 'authentication',
  );
  if (authenticationFailures.length) {
    if (!auth.currentUser || auth.currentUser.uid !== uid) {
      throw Object.assign(new Error('The authenticated user does not match the requested assistant context.'), {
        code: 'functions/unauthenticated',
      });
    }
    await auth.currentUser.getIdToken(true);
    results = await loadAssistantContextSources(uid);
    const unrecoverableAuthentication = results.find((result) =>
      result.status === 'rejected' && classifyAssistantError(result.reason) === 'authentication',
    );
    if (unrecoverableAuthentication?.status === 'rejected') throw unrecoverableAuthentication.reason;
  }

  const [
    todaySchedulesResult,
    todayActivitiesResult,
    weekSchedulesResult,
    weekActivitiesResult,
    upcomingSchedulesResult,
    upcomingActivitiesResult,
    pendingTasksResult,
    weekTransactionsResult,
    monthTransactionsResult,
    notesResult,
    scanLogsResult,
    wellbeingSchedulesResult,
    wellbeingActivitiesResult,
  ] = results;
  const todaySchedules = settledValue(todaySchedulesResult) as WithId<Schedule>[];
  const todayActivities = settledValue(todayActivitiesResult) as WithId<Activity>[];
  const weekSchedules = settledValue(weekSchedulesResult) as WithId<Schedule>[];
  const weekActivities = settledValue(weekActivitiesResult) as WithId<Activity>[];
  const upcomingSchedules = settledValue(upcomingSchedulesResult) as WithId<Schedule>[];
  const upcomingActivities = settledValue(upcomingActivitiesResult) as WithId<Activity>[];
  const pendingTasks = settledValue(pendingTasksResult) as WithId<Activity>[];
  const weekTransactions = settledValue(weekTransactionsResult) as WithId<Transaction>[];
  const monthTransactions = settledValue(monthTransactionsResult) as WithId<Transaction>[];
  const noteList = settledValue(notesResult) as WithId<Note>[];
  const recentScanLogs = settledValue(scanLogsResult) as WithId<ScanLog>[];
  const wellbeingSchedules = settledValue(wellbeingSchedulesResult) as WithId<Schedule>[];
  const wellbeingActivities = settledValue(wellbeingActivitiesResult) as WithId<Activity>[];
  const monthIncome = monthTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const monthExpense = monthTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
  const monthlyBudget = await loadMonthlyBudget(uid, currentMonthKey());
  // The declared window is loaded separately from the activity queries above,
  // because it is a preference rather than a record and must never join the
  // evidence counts. It reaches the model only as a labelled fallback.
  const sleepBaselineHours = baselineNightHours(await loadSleepBaseline(uid).catch(() => null));
  const financeDynamic = monthlyBudget
    ? calculateFinanceBudgetInsight({dailyBudget: monthlyBudget.dailyAmount, monthlyBudget: monthlyBudget.amount, transactions: monthTransactions, weeklyBudget: monthlyBudget.weeklyAmount})
    : null;
  const dynamic: SmartLifeDynamicInsight = {
    burnout: calculateBurnoutDynamicInsight({
      activities: todayActivities,
      finance: financeDynamic,
      pendingTasks,
      schedules: todaySchedules,
      sleepBaselineHours,
      weekActivities: wellbeingActivities,
      weekSchedules: wellbeingSchedules,
    }),
    ...(financeDynamic ? {finance: financeDynamic} : {}),
  };
  return {
    availability: {
      finance: sourceAvailability([weekTransactionsResult, monthTransactionsResult]),
      notes: sourceAvailability([notesResult]),
      ocr: sourceAvailability([scanLogsResult]),
      schedules: sourceAvailability([
        todaySchedulesResult,
        todayActivitiesResult,
        weekSchedulesResult,
        weekActivitiesResult,
        upcomingSchedulesResult,
        upcomingActivitiesResult,
        wellbeingSchedulesResult,
        wellbeingActivitiesResult,
      ]),
      tasks: sourceAvailability([pendingTasksResult, notesResult]),
    },
    balance: monthIncome - monthExpense,
    dynamic,
    monthExpense,
    monthIncome,
    monthTransactions,
    notes: noteList,
    pendingTasks,
    recentScanLogs,
    todayActivities,
    todaySchedules,
    upcomingActivities,
    upcomingSchedules,
    weekActivities,
    weekSchedules,
    weekTransactions,
  };
}

function checklistItems(message: string) {
  if (/(รายงาน|report)/i.test(message)) return ['รวบรวมข้อมูลและแหล่งอ้างอิง', 'วางโครงร่างหัวข้อ', 'เขียนฉบับร่าง', 'ตรวจคำและจัดรูปแบบ', 'ส่งงาน'];
  if (/(สอบ|quiz|ควิซ)/i.test(message)) return ['เลือกหัวข้อที่จะอ่านก่อน', 'สรุปเนื้อหาสำคัญ', 'ทำแบบฝึกหัดหรือโจทย์เก่า', 'ทบทวนจุดที่ยังไม่มั่นใจ'];
  if (/(โปรเจกต์|project)/i.test(message)) return ['กำหนดสิ่งที่ต้องส่ง', 'แตกงานและจัดลำดับความสำคัญ', 'ทำชิ้นงานหลักรอบแรก', 'ทดสอบและเก็บรายละเอียด', 'ทบทวนก่อนส่ง'];
  return ['กำหนดผลลัพธ์ที่ต้องการ', 'เริ่มงานชิ้นเล็กที่สำคัญที่สุด', 'ทำส่วนหลักให้เสร็จ', 'ตรวจทานและปิดงาน'];
}

function proposeChecklistFromMessage(message: string): AssistantProposedAction | null {
  if (!/(แตกงาน|แบ่งงาน|เช็กลิสต์|checklist|จัดงานเป็นข้อ)/i.test(message)) return null;
  const title = message
    .replace(/^(ช่วย)?\s*(แตกงาน|แบ่งงาน|ทำเช็กลิสต์|เช็กลิสต์|checklist|จัดงานเป็นข้อ)\s*/i, '')
    .replace(/(ให้หน่อย|หน่อย|ที)$/i, '')
    .trim()
    .slice(0, 80) || 'งานที่ต้องทำ';
  const payload: ChecklistPayload = {items: checklistItems(message), startAt: parseStartAt(message).toISOString(), title};
  return {entity: 'checklist', id: actionId(), payload, status: 'pending', summary: `สร้างเช็กลิสต์ "${payload.title}" จำนวน ${payload.items.length} ข้อ`, type: 'create'};
}

function proposePreferenceFromMessage(message: string): AssistantProposedAction | null {
  const amount = parseAmount(message);
  if (!amount) return null;
  const dailyBudget = /(ตั้งงบ|งบวันละ|จำไว้ว่างบ|budget).*?(วัน|daily)|(?:วัน|daily).*?(งบ|budget)/i.test(message);
  if (dailyBudget) {
    const payload: AssistantMemoryPayload = {key: 'dailyBudget', value: amount};
    return {entity: 'memory', id: actionId(), payload, status: 'pending', summary: `ตั้งงบส่วนตัววันละ ${amount.toLocaleString('th-TH')} บาท`, type: 'create'};
  }
  const studyMinutes = /(จำไว้ว่า|ตั้ง).*?(อ่านหนังสือ|โฟกัส|study).*?(นาที|minute)|(?:อ่านหนังสือ|โฟกัส|study).*?(นาที|minute)/i.test(message);
  if (studyMinutes) {
    const payload: AssistantMemoryPayload = {key: 'studyMinutes', value: amount};
    return {entity: 'memory', id: actionId(), payload, status: 'pending', summary: `จำช่วงโฟกัสการเรียน ${amount.toLocaleString('th-TH')} นาที`, type: 'create'};
  }
  return null;
}

export function proposeActionFromMessage(message: string): AssistantProposedAction | null {
  const normalized = message.trim();
  if (!normalized) return null;
  const mutationClause = explicitMutationClause(normalized);
  if (isAdviceOrLookupIntent(normalized) && !mutationClause) return null;
  // Mixed requests may contain a lookup plus one mutation. Parse only the
  // mutation clause so query wording never leaks into the new record.
  const actionMessage = mutationClause ?? normalized;
  if (scheduleCreationClarification(actionMessage)) return null;

  const checklist = proposeChecklistFromMessage(actionMessage);
  if (checklist) return checklist;

  const preference = proposePreferenceFromMessage(actionMessage);
  if (preference) return preference;

  if (isScheduleIntent(actionMessage)) {
    const start = parseStartAt(actionMessage);
    const end = parseEndAt(actionMessage, start);
    const location = actionMessage.match(/(?:ที่|ห้อง)\s*([A-Za-z0-9ก-๙._-]+)/)?.[1] ?? '';
    const type: SchedulePayload['type'] = /(งาน|task|quiz|ควิซ|สอบ)/i.test(actionMessage) ? 'task' : /(เรียน|lab|แล็บ|class)/i.test(actionMessage) ? 'class' : 'appointment';
    const payload: SchedulePayload = {endAt: end.toISOString(), location, startAt: start.toISOString(), title: scheduleTitleFromMessage(actionMessage, type === 'task' ? 'งานจากแชท' : 'นัดหมายจากแชท'), type};
    return {entity: 'schedule', id: actionId(), payload, status: 'pending', summary: `เพิ่ม${type === 'class' ? 'คลาส' : type === 'task' ? 'งาน' : 'นัดหมาย'} "${payload.title}" เวลา ${textDate(start)}`, type: 'create'};
  }

  const amount = parseAmount(actionMessage);
  const financeAction = financeMutationKind(actionMessage, amount);
  if (financeAction === 'income') {
    const payload: FinancePayload = {amount, category: 'รายรับ', date: new Date().toISOString(), note: titleFromMessage(actionMessage, 'รายรับจากแชท'), type: 'income'};
    return {entity: 'finance', id: actionId(), payload, status: 'pending', summary: `บันทึกรายรับ ${amount.toLocaleString('th-TH')} บาท`, type: 'create'};
  }
  if (financeAction === 'expense') {
    const category = /(ข้าว|กิน|อาหาร|กาแฟ)/.test(actionMessage) ? 'อาหาร' : 'อื่น ๆ';
    const payload: FinancePayload = {amount, category, date: new Date().toISOString(), note: titleFromMessage(actionMessage, 'รายจ่ายจากแชท'), type: 'expense'};
    return {entity: 'finance', id: actionId(), payload, status: 'pending', summary: `บันทึกรายจ่าย ${amount.toLocaleString('th-TH')} บาท หมวด ${category}`, type: 'create'};
  }

  if (isExplicitNoteMutation(actionMessage)) {
    const payload: NotePayload = {
      body: noteBodyFromMessage(actionMessage),
      tag: noteTagFromMessage(actionMessage),
      title: noteTitleFromMessage(actionMessage),
    };
    return {entity: 'note', id: actionId(), payload, status: 'pending', summary: `สร้างโน้ต "${payload.title}"`, type: 'create'};
  }

  return null;
}

function dayLabel(date: Date) {
  return new Intl.DateTimeFormat('th-TH', {weekday: 'long', day: 'numeric', month: 'short', timeZone: THAI_TIME_ZONE}).format(date);
}

function buildDailyBriefing(context: AssistantContext, preferences: AssistantPreferences) {
  const now = new Date();
  const all = [
    ...context.todaySchedules,
    ...context.todayActivities.filter((item) => item.type !== 'task' || item.status !== 'completed'),
  ].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  const next = all.find((item) => item.endAt.toDate() >= now) ?? all[0];
  const pendingTasks = context.weekActivities.filter((item) => item.type === 'task' && item.status !== 'completed');
  const lines = [`สรุป ${dayLabel(now)} นะ`];
  if (next) lines.push(`รายการถัดไปคือ ${next.title} เวลา ${textDate(next.startAt.toDate())}`);
  else lines.push('วันนี้ยังไม่มีนัดหรือคลาสที่บันทึกไว้');
  if (pendingTasks.length) lines.push(`ยังมีงานที่วางแผนไว้ ${pendingTasks.length} งาน ลองเริ่มจาก "${pendingTasks[0].title}" ก่อนก็ได้`);
  else lines.push('ยังไม่มีงานค้างในสัปดาห์นี้');
  if (preferences.dailyBudget) lines.push(`งบที่ตั้งไว้วันนี้คือ ${preferences.dailyBudget.toLocaleString('th-TH')} บาท`);
  return lines.join('\n');
}

function sameThailandDay(left: Date, right: Date) {
  const format = new Intl.DateTimeFormat('en-CA', {day: '2-digit', month: '2-digit', timeZone: THAI_TIME_ZONE, year: 'numeric'});
  return format.format(left) === format.format(right);
}

function buildBudgetGuard(context: AssistantContext, _preferences: AssistantPreferences) {
  const finance = context.dynamic.finance;
  const categoryTotals = new Map<string, number>();
  context.weekTransactions.filter((item) => item.type === 'expense').forEach((item) => {
    categoryTotals.set(item.category, (categoryTotals.get(item.category) ?? 0) + item.amount);
  });
  const highestCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!finance) {
    const weekIncome = context.weekTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    const weekExpense = context.weekTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    if (weekIncome <= 0 && weekExpense <= 0) return 'ยังไม่มีงบและรายการการเงินของสัปดาห์นี้ให้วิเคราะห์ครับ ตั้งงบเดือนหนึ่งครั้งก่อน แล้วระบบจะกระจายเป็นกรอบรายสัปดาห์ให้';
    return `สัปดาห์นี้บันทึกรายรับ ${weekIncome.toLocaleString('th-TH')} บาท และรายจ่าย ${weekExpense.toLocaleString('th-TH')} บาท แต่ยังไม่ได้ตั้งวงเงิน จึงยังคำนวณสัดส่วน 80% ไม่ได้ครับ`;
  }
  const headline = `งบสัปดาห์นี้ ${finance.weeklyBudget.toLocaleString('th-TH')} บาท ใช้ไป ${finance.weekSpent.toLocaleString('th-TH')} บาท (${finance.weeklyUsagePercent}%) เหลือ ${Math.max(0, finance.weeklyRemainingBudget).toLocaleString('th-TH')} บาท`;
  if (finance.weeklyStatus === 'exceeded') return `${headline}\nใช้เกินกรอบสัปดาห์แล้ว ${Math.abs(finance.weeklyRemainingBudget).toLocaleString('th-TH')} บาท ลองชะลอรายจ่ายที่ไม่จำเป็นและรักษาค่าอาหารหรือค่าเดินทางที่จำเป็นไว้ก่อน`;
  if (finance.weeklyStatus === 'warning') return `${headline}\nแตะระดับเตือน 80% แล้วครับ ช่วงที่เหลือของสัปดาห์ควรใช้เฉพาะรายการจำเป็นก่อน`;
  if (highestCategory) return `${headline}\nหมวดที่ใช้มากที่สุดคือ ${highestCategory[0]} ${highestCategory[1].toLocaleString('th-TH')} บาท`;
  return `${headline}\nสถานะยังอยู่ในกรอบรายสัปดาห์ครับ`;
}

function isFinanceLookupIntent(message: string) {
  const hasFinanceWord = /(เงิน|รายรับ|รายจ่าย|ยอดคงเหลือ|งบ|ค่าใช้จ่าย|ใช้จ่าย|ซื้อข้าว|ค่าอาหาร|ข้าว|อาหาร|บาท|ออม|เก็บเงิน|เก็บตัง|เงินเก็บ|เป้าหมาย|เงินสำรอง|ลงทุน|หุ้น|กองทุน|ผลตอบแทน|ดอกเบี้ย|ความเสี่ยง|budget|finance|income|expense|saving|investment)/i.test(message);
  const asksForFactOrAdvice = /(เท่าไหร่|เท่าไร|กี่บาท|เหลือ|พอไหม|ควร|แนะนำ|วิเคราะห์|สรุป|แบ่ง|จัดสรร|วางแผน|ใช้|อยู่|เดือนนี้|วันนี้|พรุ่งนี้|ถึงสิ้นเดือน|ถ้ามี|สมมติ|ยังไง|อย่างไร|ทำไง|เริ่ม|ออม|เก็บ|เป้าหมาย|ให้ได้|ให้ถึง)/i.test(message);
  // A short follow-up such as "มี 200 ควรแบ่งใช้ยังไง" is still a money
  // question even when the user does not repeat the word "เงิน" or "งบ".
  // Keep it local so the response always uses the supplied amount instead of
  // falling back to a generic assistant reply.
  const hasBareAmountForAdvice = /(?:มี|เหลือ)\s*[\d,]+(?:\.\d+)?\s*(?:บาท)?\s*(?:ควร|แบ่ง|ใช้|พอ|อยู่)/i.test(message)
    || /[\d,]+(?:\.\d+)?\s*บาท\s*(?:ควร|แบ่ง|ใช้|พอ)/i.test(message);
  const compactBudgetPlan = hasFinanceWord &&
    /[\d,]+(?:\.\d+)?/.test(message) &&
    /(?:\d+\s*วัน|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*วัน/i.test(message);
  const startsWithCompactBudgetPlan =
    /^\s*[\d,]+(?:\.\d+)?\s*(?:บาท)?\s*(?:ควร|แบ่ง|จัดสรร|วางแผน|ใช้|อยู่|พอ)/i.test(message) &&
    /(?:\d+\s*วัน|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*วัน/i.test(message);
  return (hasFinanceWord && asksForFactOrAdvice) ||
    hasBareAmountForAdvice ||
    compactBudgetPlan ||
    startsWithCompactBudgetPlan;
}

function daysUntilMonthEnd(fromTomorrow = false) {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, lastDay - now.getDate() + (fromTomorrow ? 0 : 1));
}

type FinancePeriod = 'day' | 'month' | 'week';

function financePeriod(message: string): FinancePeriod {
  if (/(สัปดาห์|อาทิตย์นี้|week)/i.test(message)) return 'week';
  if (/(วันนี้|รายวัน|ต่อวัน|daily|today)/i.test(message)) return 'day';
  return 'month';
}

function financePeriodSummary(message: string, context: AssistantContext, preferences: AssistantPreferences) {
  const period = financePeriod(message);
  const now = new Date();
  let transactionsForPeriod = context.monthTransactions;
  let label = 'เดือนนี้';
  let daysLeft = daysUntilMonthEnd();

  if (period === 'week') {
    transactionsForPeriod = context.weekTransactions;
    label = 'สัปดาห์นี้';
    const week = rangeFor('week');
    daysLeft = Math.max(1, Math.ceil((week.end.getTime() - now.getTime()) / 86_400_000));
  } else if (period === 'day') {
    transactionsForPeriod = context.monthTransactions.filter(
      (item) => sameThailandDay(item.occurredAt.toDate(), now),
    );
    label = 'วันนี้';
    daysLeft = 1;
  }

  const income = transactionsForPeriod
    .filter((item) => item.type === 'income')
    .reduce((sum, item) => sum + item.amount, 0);
  const expense = transactionsForPeriod
    .filter((item) => item.type === 'expense')
    .reduce((sum, item) => sum + item.amount, 0);
  const recordedBalance = income - expense;
  const balance = period === 'day' && preferences.dailyBudget
    ? Math.max(0, preferences.dailyBudget - expense)
    : recordedBalance;

  return {balance, daysLeft, expense, income, label, period};
}

function financeRecommendation(summary: ReturnType<typeof financePeriodSummary>, message: string) {
  const {balance, daysLeft, expense, income, label} = summary;
  if (balance <= 0) {
    return `${label}มีรายรับ ${income.toLocaleString('th-TH')} บาท รายจ่าย ${expense.toLocaleString('th-TH')} บาท จึงไม่มียอดคงเหลือบวกสำหรับแบ่งใช้ครับ ควรชะลอรายจ่ายที่ไม่จำเป็นและตรวจสอบว่ามีรายรับที่ยังไม่ได้บันทึกหรือไม่`;
  }

  return dailySpendingPlan(balance, daysLeft);
}

function explicitAdviceBudget(message: string) {
  const asksForAdvice = /(ควร|แบ่ง|จัดสรร|วางแผน|ใช้|อยู่|พอ|ซื้อ|กิน|ข้าว|อาหาร)/i.test(message);
  const isCompactPlan = /(เงิน|งบ|บาท)/i.test(message) &&
    /(?:\d+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*วัน/i.test(message);
  if (!asksForAdvice && !isCompactPlan) return null;

  const patterns = [
    /(?:ถ้า|สมมติ)?\s*(?:มี(?:เงิน|งบ)?|เงินเหลือ|งบ(?:เหลือ)?|เหลือ)\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?/i,
    /([\d,]+(?:\.\d+)?)\s*บาท\s*(?:ควร|แบ่ง|จัดสรร|ใช้|พอ|ซื้อ|กิน)/i,
    /(?:เงิน|งบ)\s*([\d,]+(?:\.\d+)?)/i,
    /^\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?\s*(?:ควร|แบ่ง|จัดสรร|วางแผน|ใช้|อยู่|พอ)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

function explicitBudgetDays(message: string) {
  const numeric = /(\d+)\s*วัน/i.exec(message);
  if (numeric) return Math.max(1, Number(numeric[1]));
  const thaiNumberWords: Record<string, number> = {
    หนึ่ง: 1,
    สอง: 2,
    สาม: 3,
    สี่: 4,
    ห้า: 5,
    หก: 6,
    เจ็ด: 7,
    แปด: 8,
    เก้า: 9,
    สิบ: 10,
  };
  const word = /(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*วัน/i.exec(message)?.[1];
  return word ? thaiNumberWords[word] : null;
}

function explicitBudgetRecommendation(message: string, amount: number) {
  const formattedAmount = amount.toLocaleString('th-TH');
  const explicitDays = explicitBudgetDays(message);
  if (explicitDays) return dailySpendingPlan(amount, explicitDays);

  if (/(ถึงสิ้นเดือน|สิ้นเดือน)/i.test(message)) {
    const daysLeft = daysUntilMonthEnd(/พรุ่งนี้/i.test(message));
    return dailySpendingPlan(amount, daysLeft);
  }

  if (/(สัปดาห์|7\s*วัน|เจ็ดวัน)/i.test(message)) {
    return dailySpendingPlan(amount, 7);
  }

  if (/(วันนี้|1\s*วัน|หนึ่งวัน)/i.test(message)) {
    return dailySpendingPlan(amount, 1);
  }

  return `รับงบใหม่ ${formattedAmount} บาทครับ บอกฉันเพิ่มว่าจะต้องใช้กี่วัน เช่น “มี ${formattedAmount} บาท ใช้ 3 วัน” แล้วฉันจะแบ่งงบเช้า กลางวัน เย็น และเงินสำรองให้ โดยไม่ใช้ยอดรายเดือนในระบบมาปน`;
}

function dailySpendingPlan(totalBudget: number, days: number) {
  const safeDays = Math.max(1, Math.floor(days));
  const dailyBudget = totalBudget / safeDays;
  const roundedDaily = Math.floor(dailyBudget);
  const minimumBreakfast = 20;
  const minimumMainMeal = 35;
  const typicalThreeMealMinimum = minimumBreakfast + minimumMainMeal * 2;

  if (roundedDaily < typicalThreeMealMinimum) {
    const afternoon = Math.min(minimumMainMeal, Math.max(0, roundedDaily - minimumBreakfast));
    const remaining = Math.max(0, roundedDaily - minimumBreakfast - afternoon);
    const shortage = typicalThreeMealMinimum - roundedDaily;
    return [
      `สรุปงบประมาณ`,
      `- เงินทั้งหมด ${totalBudget.toLocaleString('th-TH')} บาท สำหรับ ${safeDays} วัน`,
      `- เฉลี่ยวันละ ${dailyBudget.toLocaleString('th-TH', {maximumFractionDigits: 2})} บาท`,
      `- งบนี้ต่ำกว่าค่าอาหารพื้นฐาน 3 มื้อประมาณ ${shortage.toLocaleString('th-TH')} บาทต่อวัน`,
      ``,
      `แผนประคองงบต่อวัน`,
      `1. มื้อเช้า กันไว้ ${Math.min(minimumBreakfast, roundedDaily).toLocaleString('th-TH')} บาท สำหรับอาหารเช้าง่าย ๆ และน้ำเปล่า`,
      `2. มื้อกลางวัน กันไว้ ${afternoon.toLocaleString('th-TH')} บาท เลือกโรงอาหารหรือร้านราคาประหยัด`,
      `3. มื้อเย็น เหลือ ${remaining.toLocaleString('th-TH')} บาท ควรทำอาหารที่หอหรือใช้วัตถุดิบที่ซื้อรวมหลายมื้อ เพราะไม่พอซื้ออาหารทั่วไปหนึ่งมื้อ`,
      `4. งบสำรอง 0 บาท จึงควรงดเครื่องดื่มหวานและของที่ยังไม่จำเป็น`,
      ``,
      `ทริคประหยัด`,
      `- อาหารเช้าควรเผื่ออย่างน้อย 20 บาท และมื้อหลักที่ซื้อทั่วไปควรเผื่ออย่างน้อยมื้อละ 35 บาท`,
      `- พกน้ำและซื้อไข่ ข้าว หรืออาหารแห้งเป็นชุด เพื่อเฉลี่ยต้นทุนหลายมื้อ`,
    ].join('\n');
  }

  const morning = Math.max(minimumBreakfast, Math.floor(roundedDaily * 0.2));
  const afternoon = Math.max(minimumMainMeal, Math.floor(roundedDaily * 0.3));
  const evening = Math.max(minimumMainMeal, Math.floor(roundedDaily * 0.3));
  const buffer = Math.max(0, roundedDaily - morning - afternoon - evening);

  return [
    `สรุปงบประมาณ`,
    `- เงินทั้งหมด ${totalBudget.toLocaleString('th-TH')} บาท สำหรับ ${safeDays} วัน`,
    `- เฉลี่ยวันละ ${dailyBudget.toLocaleString('th-TH', {maximumFractionDigits: 2})} บาท`,
    ``,
    `แผนใช้จ่ายต่อวัน`,
    `1. มื้อเช้า อาหารเช้าง่าย ๆ และน้ำเปล่า ไม่เกิน ${morning.toLocaleString('th-TH')} บาท`,
    `2. มื้อกลางวัน ข้าวโรงอาหารหรืออาหารตามสั่ง ไม่เกิน ${afternoon.toLocaleString('th-TH')} บาท`,
    `3. มื้อเย็น อาหารมื้อหลักและงดเครื่องดื่มราคาแพง ไม่เกิน ${evening.toLocaleString('th-TH')} บาท`,
    `4. เงินสำรอง ${buffer.toLocaleString('th-TH')} บาท เก็บไว้ใช้เมื่อจำเป็น`,
    ``,
    `ทริคประหยัด`,
    `- อาหารเช้าควรเผื่ออย่างน้อย 20 บาท และมื้อหลักทั่วไปควรเผื่ออย่างน้อยมื้อละ 35 บาท`,
    `- พกน้ำเปล่าและตัดของหวานหรือเครื่องดื่มก่อน หากเริ่มใช้เกินงบ`,
  ].join('\n');
}

function numericAmounts(message: string) {
  return [...message.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
}

function savingsGoalAnswer(message: string, context: AssistantContext) {
  const amounts = numericAmounts(message);
  const currentMatch = /(?:ตอนนี้มี|มีเงิน|มีงบ|เงิน)\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?/i.exec(message);
  const targetMatch = /(?:ให้ได้|ให้ถึง|เป้าหมาย(?:คือ)?|เก็บให้ครบ|ครบ)\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?/i.exec(message);
  const statedCurrent = Number((currentMatch?.[1] ?? '').replace(/,/g, ''));
  const statedTarget = Number((targetMatch?.[1] ?? '').replace(/,/g, ''));
  const current = Number.isFinite(statedCurrent) && statedCurrent > 0 ? statedCurrent : amounts[0] ?? 0;
  const target = Number.isFinite(statedTarget) && statedTarget > 0 ? statedTarget : amounts.length >= 2 ? amounts[1] : 0;

  if (current > 0 && target > 0) {
    const gap = Math.max(0, target - current);
    if (!gap) {
      return `ตอนนี้มี ${current.toLocaleString('th-TH')} บาท ซึ่งถึงเป้าหมาย ${target.toLocaleString('th-TH')} บาทแล้วครับ แยกเงินก้อนนี้ไว้ในบัญชีหรือกระเป๋าที่ไม่ใช้จ่ายประจำ จะช่วยรักษาเป้าหมายได้ง่ายขึ้น`;
    }
    const dayAmount = Math.ceil(gap / 30);
    const weekAmount = Math.ceil(gap / 4);
    return [
      `เป้าหมายคือ ${target.toLocaleString('th-TH')} บาท ตอนนี้มี ${current.toLocaleString('th-TH')} บาท จึงต้องเก็บเพิ่มอีก ${gap.toLocaleString('th-TH')} บาท`,
      `1. ถ้าต้องการให้ครบใน 30 วัน เก็บวันละประมาณ ${dayAmount.toLocaleString('th-TH')} บาท`,
      `2. ถ้าต้องการให้ครบใน 4 สัปดาห์ เก็บสัปดาห์ละประมาณ ${weekAmount.toLocaleString('th-TH')} บาท`,
      `3. แยกเงินเก็บออกจากเงินใช้ทันทีเมื่อได้รับเงิน และไม่บันทึก ${current.toLocaleString('th-TH')} บาทนี้เป็นรายจ่าย`,
      `ถ้าบอกวันที่ต้องการให้ครบ ฉันจะคำนวณยอดที่ต้องเก็บต่อวันให้ตรงกว่านี้ครับ`,
    ].join('\n');
  }

  const statedBudget = current || explicitAdviceBudget(message);
  if (statedBudget) {
    const starterSaving = Math.max(1, Math.floor(statedBudget * 0.15));
    return [
      `จากเงินที่ระบุ ${statedBudget.toLocaleString('th-TH')} บาท เริ่มแยกออมประมาณ ${starterSaving.toLocaleString('th-TH')} บาท หรือ 15% ก่อนได้ครับ`,
      `1. กันค่าใช้จ่ายจำเป็นของช่วงนี้ก่อน`,
      `2. โอนเงินออมไปอีกกระเป๋าทันที เพื่อลดโอกาสหยิบใช้`,
      `3. บอกเป้าหมายและวันที่ต้องการใช้เงิน แล้วฉันจะคำนวณยอดออมต่อวันหรือเดือนให้`,
    ].join('\n');
  }

  if (context.balance <= 0) {
    return `จากรายการที่บันทึกไว้ เดือนนี้ยังไม่มียอดคงเหลือบวกสำหรับตั้งแผนออมครับ ควรตรวจรายรับที่ยังไม่ได้บันทึกและลดรายจ่ายไม่จำเป็นก่อน แล้วค่อยตั้งยอดออมที่ทำได้จริง`;
  }
  const suggested = Math.max(1, Math.floor(context.balance * 0.15));
  return `เดือนนี้คงเหลือ ${context.balance.toLocaleString('th-TH')} บาทตามรายการที่บันทึกไว้ ลองเริ่มแยกออม ${suggested.toLocaleString('th-TH')} บาท หรือประมาณ 15% ก่อน และเก็บส่วนที่เหลือไว้สำหรับค่าใช้จ่ายจำเป็นครับ`;
}

function investmentGuidance(message: string) {
  const amount = numericAmounts(message)[0] ?? 0;
  const amountText = amount > 0 ? `สำหรับเงิน ${amount.toLocaleString('th-TH')} บาท ` : '';
  return [
    `${amountText}ควรเริ่มจากเช็กเงินสำรองฉุกเฉินและระยะเวลาที่จะใช้เงินก่อนลงทุนครับ`,
    `1. เงินที่ต้องใช้ภายใน 1-3 ปี ควรเน้นความผันผวนต่ำและสภาพคล่องสูง`,
    `2. เงินระยะยาวค่อยพิจารณากระจายหลายสินทรัพย์ตามความเสี่ยงที่รับได้`,
    `3. เริ่มด้วยจำนวนเล็กที่เสียแล้วไม่กระทบค่าเรียน ค่าอาหาร หรือหนี้ และตรวจค่าธรรมเนียมทุกครั้ง`,
    `การลงทุนมีโอกาสขาดทุนและไม่มีผลตอบแทนรับประกัน ถ้าบอกระยะเวลา เป้าหมาย และระดับความเสี่ยง ฉันจะช่วยทำกรอบจัดสรรเพื่อการศึกษาให้เหมาะขึ้นครับ`,
  ].join('\n');
}

function buildFinanceAnswer(message: string, context: AssistantContext, preferences: AssistantPreferences) {
  if (/(ลงทุน|หุ้น|กองทุน|สินทรัพย์|ผลตอบแทน|พอร์ต|investment)/i.test(message)) {
    return investmentGuidance(message);
  }
  if (isSavingsPlanningRequest(message)) {
    if (context.availability.finance !== 'available' && numericAmounts(message).length === 0) {
      return 'ตอนนี้อ่านยอดการเงินจริงได้ไม่ครบ จึงยังไม่ใช้ยอด 0 บาทมาวางแผนแทนครับ บอกจำนวนเงินและเป้าหมายในคำถามได้เลย แล้วฉันจะคำนวณจากตัวเลขนั้นให้';
    }
    return savingsGoalAnswer(message, context);
  }
  const userProvidedBudget = explicitAdviceBudget(message);
  if (userProvidedBudget) return explicitBudgetRecommendation(message, userProvidedBudget);
  if (context.availability.finance !== 'available') {
    return 'ตอนนี้อ่านรายการการเงินได้ไม่ครบ จึงยังยืนยันยอดคงเหลือหรือรายจ่ายจริงไม่ได้ครับ กรุณาลองใหม่อีกครั้ง';
  }

  const summary = financePeriodSummary(message, context, preferences);
  const asksForRecommendation = /(ควร|แบ่ง|แนะนำ|ใช้ยังไง|ใช้เท่าไหร่|ใช้เท่าไร|ซื้อ|ข้าว|อาหาร|กิน|มื้อ|จัดสรร|วางแผน)/i.test(message);
  if (asksForRecommendation && !/พรุ่งนี้/i.test(message)) {
    return financeRecommendation(summary, message);
  }

  if (/พรุ่งนี้.*(ควร|ใช้)|(?:ควร|ใช้).*พรุ่งนี้/i.test(message)) {
    if (preferences.dailyBudget) {
      return `พรุ่งนี้ควรใช้ไม่เกินงบที่ตั้งไว้ ${preferences.dailyBudget.toLocaleString('th-TH')} บาทครับ`;
    }
    if (context.balance <= 0) {
      return `จากข้อมูลจริงเดือนนี้มีรายรับ ${context.monthIncome.toLocaleString('th-TH')} บาท และรายจ่าย ${context.monthExpense.toLocaleString('th-TH')} บาท จึงยังไม่มียอดคงเหลือบวกสำหรับคำนวณงบพรุ่งนี้ครับ กรุณาตรวจสอบยอดเงินจริงหรือเพิ่มรายรับที่ยังไม่ได้บันทึกก่อน`;
    }
    const daysLeft = daysUntilMonthEnd(true);
    const dailyAllowance = Math.floor(context.balance / daysLeft);
    return `จากยอดคงเหลือจริง ${context.balance.toLocaleString('th-TH')} บาท และเหลืออีก ${daysLeft} วันตั้งแต่พรุ่งนี้ ควรใช้ไม่เกินประมาณ ${dailyAllowance.toLocaleString('th-TH')} บาทต่อวันครับ`;
  }

  if (/รายรับ/i.test(message) && !/รายจ่าย/i.test(message)) {
    return `รายรับที่บันทึกไว้${summary.label}คือ ${summary.income.toLocaleString('th-TH')} บาทครับ`;
  }
  if (/รายจ่าย|ค่าใช้จ่าย/i.test(message) && !/รายรับ/i.test(message)) {
    return `รายจ่ายที่บันทึกไว้${summary.label}คือ ${summary.expense.toLocaleString('th-TH')} บาทครับ`;
  }
  if (/(เหลือ|ยอดคงเหลือ)/i.test(message)) {
    return `${summary.label}มีรายรับ ${summary.income.toLocaleString('th-TH')} บาท รายจ่าย ${summary.expense.toLocaleString('th-TH')} บาท และคงเหลือ ${summary.balance.toLocaleString('th-TH')} บาทตามรายการที่บันทึกไว้ครับ`;
  }
  return financeRecommendation(summary, message);
}

function formatTime(date: Date) {
  return new Intl.DateTimeFormat('th-TH', {hour: '2-digit', hour12: false, minute: '2-digit', timeZone: THAI_TIME_ZONE}).format(date);
}

type TaskDeadlineCandidate = {
  dueAt: Date | null;
  hasTime: boolean;
  id?: string;
  priority?: string;
  source: 'activity' | 'note';
  status?: string;
  title: string;
};

function noteDeadlineCandidate(note: WithId<Note>): TaskDeadlineCandidate | null {
  const text = `${note.title} ${note.content}`;
  if (!/(ส่ง|กำหนดส่ง|เดดไลน์|deadline|due|สอบ)/i.test(text)) return null;
  if (!hasExplicitDate(text)) {
    return /(งาน|การบ้าน|โปรเจกต์|โปรเจค|ต้องทำ)/i.test(text)
      ? {dueAt: null, hasTime: false, source: 'note', title: note.title}
      : null;
  }
  const hasTime = hasExplicitTime(text);
  const dueAt = parseStartAt(text);
  // A deadline with no time given is the end of that day in Bangkok.
  return {dueAt: hasTime ? dueAt : thailandAtHour(dueAt, 23, 59), hasTime, source: 'note', title: note.title};
}

function upcomingTaskCandidates(context: AssistantContext) {
  const activityTasks: TaskDeadlineCandidate[] = context.pendingTasks
    .filter((item) => item.type === 'task' && item.status !== 'completed' && item.status !== 'cancelled')
    .map((item) => ({
      dueAt: item.startAt.toDate(),
      hasTime: true,
      id: item.id,
      priority: item.priority,
      source: 'activity',
      status: item.status,
      title: item.title,
    }));
  const noteTasks = context.notes
    .map(noteDeadlineCandidate)
    .filter((item): item is TaskDeadlineCandidate => Boolean(item));
  const seen = new Set<string>();
  const unique = [...activityTasks, ...noteTasks]
    .filter((item) => {
      const key = `${item.title.trim().toLowerCase()}|${item.dueAt?.toISOString().slice(0, 10) ?? 'no-date'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return rankAssistantTasks(unique);
}

function taskDueText(task: TaskDeadlineCandidate) {
  if (!task.dueAt) return 'ยังไม่ได้ระบุวันกำหนดส่ง';
  if (task.hasTime) return textDate(task.dueAt);
  return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeZone: THAI_TIME_ZONE}).format(task.dueAt);
}

function isTaskLookupIntent(message: string) {
  return /(งานไหน|งานค้าง|งานที่ยังไม่เสร็จ|งานอะไรต้องส่ง|ควรทำอะไรก่อน|งานไหนก่อน|จัดลำดับงาน|วางแผนงาน|สรุปงาน|ดูงาน|เช็กงาน|กำหนดส่ง|เดดไลน์|pending task|upcoming task|priority)/i
    .test(message);
}

function buildUpcomingTasksAnswer(context: AssistantContext) {
  const tasks = upcomingTaskCandidates(context);
  if (!tasks.length && context.availability.tasks !== 'available') {
    return 'ตอนนี้ดึงรายการงานได้ไม่ครบ จึงยังยืนยันไม่ได้ว่าไม่มีงานค้างครับ กรุณาลองใหม่อีกครั้ง';
  }
  if (!tasks.length) return 'ตรวจรายการงานที่เข้าถึงได้ครบแล้ว และยังไม่พบงานค้างหรือกำหนดส่งที่บันทึกไว้ครับ';

  const datedTasks = tasks.filter((task) => task.dueAt);
  const undatedTasks = tasks.filter((task) => !task.dueAt);
  const nearest = datedTasks[0];
  const now = new Date();
  const weekEnd = rangeFor('week').end;
  let opening = 'ยังไม่พบงานที่มีวันกำหนดส่งครับ';

  if (nearest?.dueAt) {
    if (nearest.dueAt.getTime() < now.getTime()) {
      opening = `งานที่เร่งด่วนที่สุดคือ ${nearest.title} ซึ่งถึงกำหนดแล้วครับ`;
    } else if (nearest.dueAt.getTime() < weekEnd.getTime()) {
      opening = `งานที่ใกล้ถึงกำหนดส่งที่สุดคือ ${nearest.title} กำหนด ${taskDueText(nearest)} และเป็นงานเร่งด่วนที่สุดของสัปดาห์นี้ครับ`;
    } else {
      opening = `งานที่ใกล้ถึงกำหนดส่งที่สุดคือ ${nearest.title} กำหนด ${taskDueText(nearest)} ครับ ยังมีเวลาอีกสักพัก และสัปดาห์นี้ยังไม่พบกำหนดส่งเร่งด่วน`;
    }
  }

  const lines = datedTasks.slice(0, 5).map((task, index) =>
    `${index + 1}. ${task.title} - ${taskDueText(task)}`,
  );
  if (undatedTasks.length) {
    lines.push(`งานที่ยังไม่ระบุวันส่ง: ${undatedTasks.slice(0, 3).map((task) => task.title).join(', ')}`);
  }
  return `${opening}\n${lines.join('\n')}`;
}

function pendingTaskShortcuts(context: AssistantContext): AssistantPendingTaskShortcut[] {
  return upcomingTaskCandidates(context)
    .filter((task): task is TaskDeadlineCandidate & {id: string} => task.source === 'activity' && Boolean(task.id))
    .slice(0, 5)
    .map((task) => ({
      dueAt: task.dueAt?.toISOString(),
      id: task.id,
      status: 'pending',
      title: task.title,
    }));
}

function buildPriorityPlan(context: AssistantContext, preferences: AssistantPreferences) {
  const taskAnswer = buildUpcomingTasksAnswer(context);
  if (!upcomingTaskCandidates(context).length) return taskAnswer;
  const focus = preferences.studyMinutes ?? 45;
  return `${taskAnswer}\nเริ่มจากงานรายการแรกก่อนสัก ${focus} นาทีครับ`;
}

function normalizedStudyText(value: string) {
  return value.toLocaleLowerCase('th-TH').replace(/[^a-z0-9ก-๙]+/gi, ' ').trim();
}

function notesRelatedToStudyItem(item: {id: string; title: string}, notesToCheck: WithId<Note>[]) {
  const itemText = normalizedStudyText(item.title);
  const itemWords = itemText.split(/\s+/).filter((word) => word.length >= 3);
  return notesToCheck.filter((note) => {
    if (note.relatedScheduleId && note.relatedScheduleId === item.id) return true;
    const noteText = normalizedStudyText(`${note.title} ${note.content}`);
    return itemWords.some((word) => noteText.includes(word)) ||
      normalizedStudyText(note.title).split(/\s+/).some((word) => word.length >= 3 && itemText.includes(word));
  });
}

function buildStudyPriorityAdvice(context: AssistantContext, preferences: AssistantPreferences) {
  const scheduleCandidates = context.upcomingSchedules
    .filter((item) => EXAM_PATTERN.test(`${item.title} ${item.courseName ?? ''} ${item.courseCode}`))
    .map((item) => ({
      id: item.id,
      priority: '',
      startAt: item.startAt,
      title: item.title || item.courseName || item.courseCode,
    }));
  const activityCandidates = context.upcomingActivities
    .filter((item) => item.status !== 'completed' && item.status !== 'cancelled' && EXAM_PATTERN.test(`${item.title} ${item.note ?? ''}`))
    .map((item) => ({
      id: item.id,
      priority: item.priority ?? '',
      startAt: item.startAt,
      title: item.title,
    }));
  const exams = [...scheduleCandidates, ...activityCandidates]
    .map((item) => ({
      ...item,
      relatedNotes: notesRelatedToStudyItem(item, context.notes),
    }))
    .sort((left, right) => {
      const dateDifference = left.startAt.toMillis() - right.startAt.toMillis();
      if (Math.abs(dateDifference) >= 24 * 60 * 60 * 1000) return dateDifference;
      const priorityScore = (value: string) => /ด่วน|สูง|สำคัญ|high|important|urgent/i.test(value) ? 2 : /กลาง|medium|normal/i.test(value) ? 1 : 0;
      return priorityScore(right.priority) - priorityScore(left.priority) || dateDifference;
    });

  if (!exams.length) {
    const pendingStudyTasks = context.pendingTasks
      .filter((item) => item.type === 'task' && item.status !== 'completed' && item.status !== 'cancelled')
      .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());
    if (pendingStudyTasks.length) {
      const first = pendingStudyTasks[0];
      return `ยังไม่พบกำหนดสอบที่บันทึกไว้ จึงจัดลำดับวิชาแบบชัวร์ ๆ ไม่ได้ครับ แต่ตอนนี้งานที่ถึงก่อนคือ "${first.title}" วันที่ ${textDate(first.startAt.toDate())} ลองเริ่มจากงานนี้ก่อนและตรวจตารางสอบเพิ่มเติมนะ`;
    }
    const studyNotes = context.notes.filter((note) => note.category === 'study');
    if (studyNotes.length) {
      return `ยังไม่พบกำหนดสอบหรืองานส่งที่ใช้จัดลำดับครับ มีโน้ตการเรียนอยู่ ${studyNotes.length} รายการ เช่น "${studyNotes.slice(0, 3).map((note) => note.title).join('", "')}" แต่ควรเพิ่มวันสอบก่อน แล้วฉันจะบอกได้แม่นขึ้นว่าวิชาไหนควรอ่านก่อน`;
    }
    return 'ยังไม่พบตารางสอบ งานส่ง หรือโน้ตการเรียนที่ใช้จัดลำดับครับ เพิ่มวันสอบของแต่ละวิชาก่อน แล้วฉันจะเรียงให้ตามวันสอบและความสำคัญได้แม่นขึ้น';
  }

  const first = exams[0];
  const firstNoteReason = first.relatedNotes.length
    ? ` และมีโน้ตเกี่ยวข้อง ${first.relatedNotes.length} รายการให้ใช้ทบทวน`
    : ' แต่ยังไม่พบโน้ตที่เชื่อมกับวิชานี้';
  const nextItems = exams.slice(1, 3).map((item, index) =>
    `${index + 2}. ${item.title} — ${textDate(item.startAt.toDate())}${item.relatedNotes.length ? ` มีโน้ต ${item.relatedNotes.length} รายการ` : ''}`,
  );
  const focusMinutes = preferences.studyMinutes ?? 45;
  return `ควรอ่าน "${first.title}" ก่อนครับ เพราะมีกำหนดก่อนสุดในวันที่ ${textDate(first.startAt.toDate())}${firstNoteReason}\n${nextItems.length ? `ลำดับถัดไป\n${nextItems.join('\n')}\n` : ''}เริ่มทบทวนรอบแรก ${focusMinutes} นาที แล้วเน้นหัวข้อที่ยังไม่เข้าใจจากโน้ตก่อนนะ`;
}

function isExamScheduleLookupIntent(message: string) {
  const hasExamWord = EXAM_PATTERN.test(message);
  const asksForSavedExamFact = /(วันแรก|วันไหน|เมื่อไหร่|กี่โมง|เริ่มวัน|เริ่มเมื่อ|มีสอบ|สอบ.*บ้าง|ตารางสอบ|วิชาอะไรบ้าง)/i.test(message);
  return hasExamWord && asksForSavedExamFact;
}

function examTypePattern(message: string) {
  if (/(กลางภาค|midterm)/i.test(message)) return /(กลางภาค|midterm)/i;
  if (/(ปลายภาค|final)/i.test(message)) return /(ปลายภาค|final)/i;
  if (/(quiz|ควิซ)/i.test(message)) return /(quiz|ควิซ)/i;
  return EXAM_PATTERN;
}

function bangkokDateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: THAI_TIME_ZONE,
    year: 'numeric',
  }).format(date);
}

function buildExamScheduleAnswer(message: string, context: AssistantContext) {
  const requestedType = examTypePattern(message);
  const requestedLabel = /(กลางภาค|midterm)/i.test(message)
    ? 'สอบกลางภาค'
    : /(ปลายภาค|final)/i.test(message)
      ? 'สอบปลายภาค'
      : /(quiz|ควิซ)/i.test(message)
        ? 'ควิซ'
        : 'สอบ';
  const scheduleCandidates = context.upcomingSchedules
    .filter((item) => {
      const searchableText = `${item.title} ${item.courseName ?? ''} ${item.courseCode}`;
      return EXAM_PATTERN.test(searchableText) && requestedType.test(searchableText);
    })
    .map((item) => ({
      startAt: item.startAt,
      title: item.title || item.courseName || item.courseCode,
    }));
  const activityCandidates = context.upcomingActivities
    .filter((item) => {
      const searchableText = `${item.title} ${item.note ?? ''}`;
      return item.status !== 'completed' &&
        item.status !== 'cancelled' &&
        EXAM_PATTERN.test(searchableText) &&
        requestedType.test(searchableText);
    })
    .map((item) => ({
      startAt: item.startAt,
      title: item.title,
    }));
  const exams = [...scheduleCandidates, ...activityCandidates]
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());

  if (!exams.length) {
    return `ยังไม่พบกำหนด${requestedLabel}ที่บันทึกไว้ในตารางหรือกิจกรรมครับ จึงยังบอกวันแรกแบบแน่นอนไม่ได้ ถ้ามีตารางสอบแล้วให้เพิ่มหรือสแกนเข้าระบบก่อนนะ`;
  }

  const asksForList = /(บ้าง|ทั้งหมด|ตารางสอบ|มีสอบ)/i.test(message) && !/(วันแรก|เริ่มวัน|เริ่มเมื่อ)/i.test(message);
  if (asksForList) {
    const lines = exams.slice(0, 6).map((exam, index) =>
      `${index + 1}. ${exam.title} — ${textDate(exam.startAt.toDate())}`,
    );
    return `พบ${requestedLabel} ${exams.length} รายการครับ\n${lines.join('\n')}`;
  }

  const first = exams[0];
  const firstDayKey = bangkokDateKey(first.startAt.toDate());
  const examsOnFirstDay = exams.filter((exam) => bangkokDateKey(exam.startAt.toDate()) === firstDayKey);
  const firstDaySubjects = examsOnFirstDay.map((exam) => exam.title).join(', ');
  return `${requestedLabel}วันแรกที่บันทึกไว้คือ ${textDate(first.startAt.toDate())} ครับ${firstDaySubjects ? ` มี ${firstDaySubjects}` : ''}`;
}

function isUpcomingClassLookupIntent(message: string) {
  return /(มีเรียน.*(วันไหน|เมื่อไหร่|อะไรบ้าง)|เรียน.*วันไหนบ้าง|วันที่มีเรียน|ตารางเรียน.*(วันไหน|ทั้งหมด)|วิชา.*(ใกล้|ถัดไป)|เรียน.*(ใกล้สุด|ถัดไป|ครั้งต่อไป)|คาบ.*(ใกล้สุด|ถัดไป)|คลาส.*(ใกล้สุด|ถัดไป)|(วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)).*เรียน|เรียน.*(วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์)))/i.test(message);
}

function classTitle(item: WithId<Schedule>) {
  return item.courseName || item.title || item.courseCode || 'ไม่ระบุชื่อวิชา';
}

function weekdayName(date: Date) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: THAI_TIME_ZONE,
    weekday: 'long',
  }).format(date);
}

function requestedWeekdays(message: string) {
  const weekdays: string[] = [];
  const pattern = /(?:วัน)?(จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|พฤหัด(?:บดี)?|ศุกร์|เสาร์)|วัน(อาทิตย์)/gi;
  for (const match of message.matchAll(pattern)) {
    const rawDay = match[1] || match[2];
    const canonicalDay = /^พฤห(?:ัส|ัด)/i.test(rawDay)
      ? 'วันพฤหัสบดี'
      : `วัน${rawDay}`;
    if (!weekdays.includes(canonicalDay)) weekdays.push(canonicalDay);
  }
  return weekdays;
}

function requestedWeekday(message: string) {
  return requestedWeekdays(message)[0] ?? '';
}

type CalendarCategory = 'appointment' | 'personal' | 'study' | 'work';

type CalendarLookupItem = {
  category: CalendarCategory;
  endAt: Timestamp;
  id: string;
  location: string;
  startAt: Timestamp;
  title: string;
};

const CALENDAR_CATEGORY_LABELS: Record<CalendarCategory, string> = {
  appointment: 'นัดหมาย',
  personal: 'กิจกรรมส่วนตัว',
  study: 'เรียน',
  work: 'งาน',
};

function requestedCalendarCategory(message: string): CalendarCategory | null {
  if (/(เรียน|คลาส|วิชา|สอบ|มหาลัย|มหาวิทยาลัย|class|course|exam)/i.test(message)) return 'study';
  if (/(นัดหมาย|นัด|หมอ|เจอเพื่อน|appointment)/i.test(message)) return 'appointment';
  if (/(งาน|โปรเจกต์|ประชุม|ทำงาน|project|meeting)/i.test(message)) return 'work';
  if (/(กิจกรรมส่วนตัว|กิจกรรม|ส่วนตัว|เที่ยว|พักผ่อน|ดูซีรีส์|personal)/i.test(message)) return 'personal';
  return null;
}

function activityCalendarCategory(item: WithId<Activity>): CalendarCategory {
  const text = `${item.category ?? ''} ${item.title} ${item.note ?? ''}`;
  if (/(เรียน|คลาส|วิชา|สอบ|การบ้าน|งานส่ง|มหาลัย|มหาวิทยาลัย|study|class|course|exam|quiz|assignment)/i.test(text)) return 'study';
  if (item.type === 'appointment' || /(นัดหมาย|นัด|หมอ|เจอเพื่อน|appointment)/i.test(text)) return 'appointment';
  if (item.type === 'task' || /(งาน|โปรเจกต์|ประชุม|ทำงาน|work|project|meeting)/i.test(text)) return 'work';
  return 'personal';
}

// A day the user names -- "2026-09-10", "10/9/2569", "10 กันยายน" -- is a day on
// a Thai calendar, so it resolves to Bangkok midnight. `new Date(y, m, d)` gave
// the device's midnight, and `calendarLookupRange` then bucketed that instant
// back into a Bangkok day: off by one whenever the device sits far enough east
// or west, which showed the wrong day's schedule.
function bangkokDay(year: number, monthIndex: number, day: number) {
  return thailandWallClockToDate(`${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, '00:00');
}

function parseExplicitCalendarDate(message: string) {
  const iso = message.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return bangkokDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const numeric = message.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (numeric) {
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    if (year >= 2400) year -= 543;
    return bangkokDay(year, Number(numeric[2]) - 1, Number(numeric[1]));
  }

  const thaiMonths: Record<string, number> = {
    มกราคม: 0,
    กุมภาพันธ์: 1,
    มีนาคม: 2,
    เมษายน: 3,
    พฤษภาคม: 4,
    มิถุนายน: 5,
    กรกฎาคม: 6,
    สิงหาคม: 7,
    กันยายน: 8,
    ตุลาคม: 9,
    พฤศจิกายน: 10,
    ธันวาคม: 11,
  };
  const thaiDate = message.match(/(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)(?:\s*(\d{4}))?/i);
  if (!thaiDate) return null;
  let year = thaiDate[3] ? Number(thaiDate[3]) : Number(thailandDateKey().slice(0, 4));
  if (year >= 2400) year -= 543;
  return bangkokDay(year, thaiMonths[thaiDate[2]], Number(thaiDate[1]));
}

function calendarLookupRange(message: string) {
  const now = new Date();
  const explicitDate = parseExplicitCalendarDate(message);
  if (explicitDate) {
    const range = rangeFor('day', explicitDate);
    return {label: new Intl.DateTimeFormat('th-TH', {dateStyle: 'long', timeZone: THAI_TIME_ZONE}).format(explicitDate), ...range};
  }
  if (/สัปดาห์หน้า|อาทิตย์หน้า|next\s*week/i.test(message)) {
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return {label: 'สัปดาห์หน้า', ...rangeFor('week', nextWeek)};
  }
  if (/เดือนหน้า|next\s*month/i.test(message)) {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return {label: 'เดือนหน้า', ...rangeFor('month', nextMonth)};
  }
  if (/พรุ่งนี้|tomorrow/i.test(message)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {label: 'พรุ่งนี้', ...rangeFor('day', tomorrow)};
  }
  if (/วันนี้|today/i.test(message)) return {label: 'วันนี้', ...rangeFor('day', now)};

  // A weekday without an explicit week always belongs to the current week.
  if (requestedWeekdays(message).length) return {label: 'สัปดาห์นี้', ...rangeFor('week', now)};
  if (/เดือนนี้|this\s*month/i.test(message)) return {label: 'เดือนนี้', ...rangeFor('month', now)};
  return {label: 'สัปดาห์นี้', ...rangeFor('week', now)};
}

function isCalendarTimeLookupIntent(message: string) {
  const asksToWrite = /(เพิ่ม|สร้าง|บันทึก|จด|กำหนด|ลบ|แก้ไข|เลื่อน)/i.test(message);
  if (asksToWrite) return false;
  const hasTimeframe = /(วันนี้|พรุ่งนี้|สัปดาห์นี้|อาทิตย์นี้|สัปดาห์หน้า|อาทิตย์หน้า|เดือนนี้|เดือนหน้า|(?:วัน)?(?:จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|พฤหัด(?:บดี)?|ศุกร์|เสาร์)|วันอาทิตย์|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|\b20\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i.test(message);
  const asksForSchedule = /(มีอะไร|อะไรบ้าง|มี.*ไหม|กี่โมง|ตาราง|เรียน|คลาส|วิชา|สอบ|งาน|โปรเจกต์|ประชุม|นัด|หมอ|เจอเพื่อน|กิจกรรม|เที่ยว|พักผ่อน|ดูซีรีส์)/i.test(message);
  return hasTimeframe && asksForSchedule;
}

function buildCalendarTimeAnswer(message: string, context: AssistantContext) {
  const range = calendarLookupRange(message);
  const weekdays = requestedWeekdays(message);
  const requestedCategory = requestedCalendarCategory(message);
  const scheduleItems: CalendarLookupItem[] = [...context.weekSchedules, ...context.upcomingSchedules]
    .map((item) => ({
      category: 'study',
      endAt: item.endAt,
      id: `schedule:${item.id}`,
      location: item.location,
      startAt: item.startAt,
      title: classTitle(item),
    }));
  const activityItems: CalendarLookupItem[] = [...context.weekActivities, ...context.upcomingActivities]
    .filter((item) => item.status !== 'completed' && item.status !== 'cancelled')
    .map((item) => ({
      category: activityCalendarCategory(item),
      endAt: item.endAt,
      id: `activity:${item.id}`,
      location: item.location,
      startAt: item.startAt,
      title: item.title,
    }));

  const uniqueItems = new Map<string, CalendarLookupItem>();
  [...scheduleItems, ...activityItems].forEach((item) => {
    const key = `${item.id}|${item.startAt.toMillis()}|${item.endAt.toMillis()}`;
    if (!uniqueItems.has(key)) uniqueItems.set(key, item);
  });
  const items = [...uniqueItems.values()]
    .filter((item) =>
      item.endAt.toMillis() >= range.start.getTime() &&
      item.startAt.toMillis() < range.end.getTime() &&
      (!weekdays.length || weekdays.includes(weekdayName(item.startAt.toDate()))) &&
      (!requestedCategory || item.category === requestedCategory) &&
      (!EXAM_PATTERN.test(message) || EXAM_PATTERN.test(item.title)),
    )
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());

  const weekdayLabel = weekdays.length > 1
    ? `${weekdays.slice(0, -1).join(', ')} และ${weekdays.at(-1)}`
    : weekdays[0] ?? '';
  const periodLabel = weekdayLabel ? `${weekdayLabel}ของ${range.label}` : range.label;
  if (!items.length) {
    const categoryLabel = requestedCategory ? CALENDAR_CATEGORY_LABELS[requestedCategory] : 'รายการ';
    return `${periodLabel}ยังไม่พบ${categoryLabel}ที่บันทึกไว้ครับ`;
  }

  const categories: CalendarCategory[] = requestedCategory
    ? [requestedCategory]
    : ['study', 'work', 'appointment', 'personal'];
  if (weekdays.length > 1) {
    const daySections = weekdays.map((day) => {
      const dayItems = items.filter((item) => weekdayName(item.startAt.toDate()) === day);
      if (!dayItems.length) {
        const categoryLabel = requestedCategory ? CALENDAR_CATEGORY_LABELS[requestedCategory] : 'รายการ';
        return `${day}: ไม่พบ${categoryLabel}ที่บันทึกไว้`;
      }
      const categorySections = categories.flatMap((category) => {
        const categoryItems = dayItems.filter((item) => item.category === category);
        if (!categoryItems.length) return [];
        const lines = categoryItems.map((item) =>
          `• ${formatTime(item.startAt.toDate())}-${formatTime(item.endAt.toDate())} ${item.title}${item.location ? ` ที่ ${item.location}` : ''}`,
        );
        return [`${CALENDAR_CATEGORY_LABELS[category]}\n${lines.join('\n')}`];
      });
      const date = dayItems[0].startAt.toDate();
      const dateLabel = new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'long',
        timeZone: THAI_TIME_ZONE,
      }).format(date);
      return `${day}ที่ ${dateLabel}\n${categorySections.join('\n')}`;
    });
    return `${periodLabel}มีทั้งหมด ${items.length} รายการครับ\n${daySections.join('\n\n')}`;
  }

  const spansMultipleDays = weekdays.length > 1 ||
    (range.end.getTime() - range.start.getTime() > 2 * 86_400_000 && !weekdays.length);
  const sections = categories.flatMap((category) => {
    const categoryItems = items.filter((item) => item.category === category);
    if (!categoryItems.length) return [];
    const lines = categoryItems.map((item) => {
      const datePrefix = spansMultipleDays ? `${dayLabel(item.startAt.toDate())} ` : '';
      return `• ${datePrefix}${formatTime(item.startAt.toDate())}-${formatTime(item.endAt.toDate())} ${item.title}${item.location ? ` ที่ ${item.location}` : ''}`;
    });
    return [`${CALENDAR_CATEGORY_LABELS[category]}\n${lines.join('\n')}`];
  });
  return `${periodLabel}มี ${items.length} รายการครับ\n${sections.join('\n\n')}`;
}

function buildUpcomingClassAnswer(message: string, context: AssistantContext) {
  const now = Date.now();
  const allClasses = context.upcomingSchedules
    .filter((item) => item.endAt.toMillis() >= now)
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());
  const weekday = requestedWeekday(message);
  const classes = weekday
    ? allClasses.filter((item) => weekdayName(item.startAt.toDate()) === weekday)
    : allClasses;

  if (!classes.length) {
    return weekday
      ? `ยังไม่พบวิชาที่บันทึกไว้ใน${weekday}ที่กำลังจะมาถึงครับ`
      : 'ยังไม่พบตารางเรียนที่กำลังจะมาถึงในระบบครับ ลองเพิ่มหรือสแกนตารางเรียนก่อน แล้วฉันจะบอกวันเรียนและวิชาที่ใกล้ที่สุดให้ได้';
  }

  const nearest = classes[0];
  const nearestText = `วิชาที่ใกล้ถึงวันเรียนที่สุดคือ "${classTitle(nearest)}" วันที่ ${textDate(nearest.startAt.toDate())}${nearest.location ? ` ที่ ${nearest.location}` : ''}`;
  if (weekday) {
    const nearestDateKey = bangkokDateKey(nearest.startAt.toDate());
    const classesOnNearestDate = classes.filter(
      (item) => bangkokDateKey(item.startAt.toDate()) === nearestDateKey,
    );
    const uniqueClasses = new Map<string, WithId<Schedule>>();
    classesOnNearestDate.forEach((item) => {
      const key = `${classTitle(item)}|${formatTime(item.startAt.toDate())}|${formatTime(item.endAt.toDate())}`;
      if (!uniqueClasses.has(key)) uniqueClasses.set(key, item);
    });
    const lines = [...uniqueClasses.values()].map((item) =>
      `• ${classTitle(item)} เวลา ${formatTime(item.startAt.toDate())}-${formatTime(item.endAt.toDate())}${item.location ? ` ที่ ${item.location}` : ''}`,
    );
    return `${weekday}ที่ใกล้ที่สุดคือวันที่ ${new Intl.DateTimeFormat('th-TH', {
      dateStyle: 'long',
      timeZone: THAI_TIME_ZONE,
    }).format(nearest.startAt.toDate())} มีเรียน ${lines.length} รายการครับ\n${lines.join('\n')}`;
  }
  const asksOnlyForNearest = /(ใกล้สุด|ถัดไป|ครั้งต่อไป)/i.test(message) && !/(วันไหนบ้าง|ทั้งหมด|วันที่มีเรียน)/i.test(message);
  if (asksOnlyForNearest) return `${nearestText} ครับ`;

  const grouped = new Map<string, {
    firstStartAt: number;
    items: Map<string, string>;
  }>();
  classes.forEach((item) => {
    const start = item.startAt.toDate();
    const weekday = weekdayName(start);
    const time = formatTime(start);
    const key = `${classTitle(item)}|${time}`;
    const current = grouped.get(weekday) ?? {
      firstStartAt: item.startAt.toMillis(),
      items: new Map<string, string>(),
    };
    current.firstStartAt = Math.min(current.firstStartAt, item.startAt.toMillis());
    current.items.set(key, `${time} ${classTitle(item)}`);
    grouped.set(weekday, current);
  });

  const weekdayLines = [...grouped.entries()]
    .sort((left, right) => left[1].firstStartAt - right[1].firstStartAt)
    .map(([weekday, value]) => `• ${weekday}: ${[...value.items.values()].join(', ')}`);

  return `${nearestText} ครับ\nวันที่มีเรียนทั้งหมด ${grouped.size} วันต่อสัปดาห์:\n${weekdayLines.join('\n')}`;
}

function isActivityLookupIntent(message: string) {
  const hasActivityWord = /(กิจกรรม|นัดหมาย|งานในตาราง|ตารางกิจกรรม)/i.test(message);
  const asksForFact = /(มี|อะไร|ไหน|เมื่อไหร่|กี่โมง|ช่วงนี้|วันนี้|พรุ่งนี้|สัปดาห์|เดือน|ใกล้|ถัดไป|บ้าง|หรือไม่|ไหม)/i.test(message);
  const asksToWrite = /(เพิ่ม|สร้าง|บันทึก|จด|นัดให้|กำหนด|ลบ|แก้ไข)/i.test(message);
  return hasActivityWord && asksForFact && !asksToWrite;
}

// "วันนี้" and "พรุ่งนี้" mean the Bangkok day, so every boundary here is a
// Bangkok midnight. `setHours(0, 0, 0, 0)` put them on the device's midnight,
// which on a device west of Bangkok answered "what's on today?" with the wrong
// day's schedule.
function activityRange(message: string) {
  const now = new Date();
  let start = now;
  let end = now;
  let label = 'ช่วง 7 วันข้างหน้า';

  if (/พรุ่งนี้/i.test(message)) {
    start = thailandDayStart(now, 1);
    end = thailandDayStart(now, 2);
    label = 'พรุ่งนี้';
  } else if (/วันนี้/i.test(message)) {
    start = thailandDayStart(now);
    end = thailandDayStart(now, 1);
    label = 'วันนี้';
  } else if (/(เดือนนี้|เดือน)/i.test(message)) {
    start = thailandDayStart(now);
    end = thailandDayStart(now, 30);
    label = 'ช่วง 30 วันข้างหน้า';
  } else {
    end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (/(อื่น|อีก)/i.test(message)) {
      start = thailandDayStart(now, 1);
      label = 'ช่วงที่เหลือของ 7 วันข้างหน้า';
    }
  }

  return {end: end.getTime(), label, start: start.getTime()};
}

function buildActivityAnswer(message: string, context: AssistantContext) {
  const range = activityRange(message);
  const savedActivities = context.upcomingActivities
    .filter((item) =>
      item.status !== 'completed' &&
      item.status !== 'cancelled' &&
      item.endAt.toMillis() >= range.start &&
      item.startAt.toMillis() < range.end,
    )
    .map((item) => ({
      endAt: item.endAt,
      kind: item.type === 'task' ? 'งาน' : 'กิจกรรม',
      location: item.location,
      startAt: item.startAt,
      title: item.title,
    }));
  const savedClasses = context.upcomingSchedules
    .filter((item) =>
      item.endAt.toMillis() >= range.start &&
      item.startAt.toMillis() < range.end,
    )
    .map((item) => ({
      endAt: item.endAt,
      kind: 'เรียน',
      location: item.location,
      startAt: item.startAt,
      title: classTitle(item),
    }));
  const activityList = [...savedActivities, ...savedClasses]
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());

  if (!activityList.length) {
    return `${range.label}ยังไม่พบตารางเรียน กิจกรรม งาน หรือนัดหมายที่บันทึกไว้ครับ`;
  }

  const nearest = activityList[0];
  const nearestText = `กิจกรรมที่ใกล้ที่สุดคือ "${nearest.title}" วันที่ ${textDate(nearest.startAt.toDate())}${nearest.location ? ` ที่ ${nearest.location}` : ''}`;
  const asksOnlyForNearest = /(ใกล้สุด|ถัดไป|ต่อไป)/i.test(message) && !/(อะไรบ้าง|ทั้งหมด|มี.*ไหม|ช่วงนี้)/i.test(message);
  if (asksOnlyForNearest) return `${nearestText} ครับ`;

  const lines = activityList.slice(0, 8).map((item) => {
    return `• ${item.kind} ${item.title} — ${textDate(item.startAt.toDate())}${item.location ? ` ที่ ${item.location}` : ''}`;
  });
  const remaining = activityList.length - lines.length;
  return `${range.label}มี ${activityList.length} รายการครับ\n${lines.join('\n')}${remaining > 0 ? `\nและอีก ${remaining} รายการในตาราง` : ''}`;
}

function buildWorkloadSummary(context: AssistantContext) {
  const scheduledHours = [...context.weekSchedules, ...context.weekActivities]
    .filter((item) => !('status' in item) || item.status !== 'cancelled')
    .reduce((sum, item) => sum + Math.max(0, item.endAt.toDate().getTime() - item.startAt.toDate().getTime()) / 3_600_000, 0);
  const pendingTasks = context.weekActivities.filter((item) => item.type === 'task' && item.status !== 'completed' && item.status !== 'cancelled').length;
  const roundedHours = Math.round(scheduledHours * 10) / 10;
  if (scheduledHours >= 35 || pendingTasks >= 8) return `สัปดาห์นี้มีตารางและกิจกรรมประมาณ ${roundedHours} ชั่วโมง และมีงานค้าง ${pendingTasks} งาน ถือว่าค่อนข้างแน่น ลองเลือก 3 งานสำคัญที่สุดก่อนนะ`;
  if (scheduledHours >= 20 || pendingTasks >= 4) return `สัปดาห์นี้มีตารางและกิจกรรมประมาณ ${roundedHours} ชั่วโมง กับงานค้าง ${pendingTasks} งาน ยังจัดการได้ ถ้าแบ่งทำวันละนิดจะไม่หนักเกินไป`;
  return `สัปดาห์นี้มีตารางและกิจกรรมประมาณ ${roundedHours} ชั่วโมง กับงานค้าง ${pendingTasks} งาน จังหวะยังพอดี ลองกันเวลาโฟกัสไว้ล่วงหน้าสักช่วงหนึ่ง`;
}

function requestedStudyDuration(message: string) {
  const hours = /(\d+(?:\.\d+)?)\s*(?:ชั่วโมง|ชม\.?)/i.exec(message);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const minutes = /(\d+)\s*(?:นาที|min(?:ute)?s?)/i.exec(message);
  return minutes ? Number(minutes[1]) : null;
}

function requestedStudyPeriod(message: string) {
  const unavailable = (period: string) => new RegExp(
    `(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา)(?:ใน|ตอน|ช่วง)?\\s*${period}|${period}(?:นี้)?(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา)`,
    'i',
  ).test(message);
  if (/(ช่วงเช้า|ตอนเช้า|เช้านี้)/i.test(message) && !unavailable('เช้า')) {
    return {endHour: 12, label: 'ช่วงเช้า', preferredStartHour: 9, startHour: 8};
  }
  if (/(ช่วงบ่าย|ตอนบ่าย|บ่ายนี้)/i.test(message) && !unavailable('บ่าย')) {
    return {endHour: 17, label: 'ช่วงบ่าย', preferredStartHour: 14, startHour: 13};
  }
  if (/(ช่วงเย็น|ตอนเย็น|เย็นนี้)/i.test(message) && !unavailable('เย็น')) {
    return {endHour: 21, label: 'ช่วงเย็น', preferredStartHour: 18, startHour: 17};
  }
  if (/(ช่วงค่ำ|ตอนค่ำ|คืนนี้)/i.test(message) && !unavailable('ค่ำ')) {
    return {endHour: 22, label: 'ช่วงค่ำ', preferredStartHour: 19, startHour: 18};
  }
  return null;
}

function requestedStudyStart(message: string, targetDate: Date) {
  const numeric = /(?:เริ่ม|ตั้งแต่|ตอน)\s*(\d{1,2})\s*[:.]\s*(\d{2})/i.exec(message);
  const hourOnly = /(?:เริ่ม|ตั้งแต่|ตอน)\s*(\d{1,2})\s*(?:นาฬิกา|น\.|โมง)/i.exec(message);
  if (!numeric && !hourOnly) return null;
  let hour = Number(numeric?.[1] ?? hourOnly?.[1]);
  const minute = Number(numeric?.[2] ?? 0);
  const matchedText = numeric?.[0] ?? hourOnly?.[0] ?? '';
  if (/บ่าย/i.test(matchedText) && hour < 12) hour += 12;
  if (/(เย็น|ค่ำ)/i.test(matchedText) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return thailandAtHour(targetDate, hour, minute);
}

function studyEventsForDate(date: Date, context: AssistantContext) {
  return [
    ...context.upcomingSchedules.filter((item) => sameThailandDay(item.startAt.toDate(), date)),
    ...context.upcomingActivities.filter((item) =>
      item.status !== 'cancelled' && sameThailandDay(item.startAt.toDate(), date),
    ),
  ].sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());
}

function suggestedStudyDate(
  context: AssistantContext,
  now: Date,
  minimumMinutes: number,
  period: ReturnType<typeof requestedStudyPeriod>,
) {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = thailandDayStart(now, offset);
    const windowStart = thailandAtHour(now, period?.startHour ?? 9, 0, offset);
    const windowEnd = thailandAtHour(now, period?.endHour ?? 21, 0, offset);
    let cursor = Math.max(windowStart.getTime(), offset === 0 ? now.getTime() : windowStart.getTime());
    const events = studyEventsForDate(date, context)
      .filter((item) => item.endAt.toMillis() > windowStart.getTime() && item.startAt.toMillis() < windowEnd.getTime());
    for (const event of events) {
      if (event.startAt.toMillis() - cursor >= minimumMinutes * 60_000) return date;
      cursor = Math.max(cursor, event.endAt.toMillis());
    }
    if (windowEnd.getTime() - cursor >= minimumMinutes * 60_000) return date;
  }
  return new Date(now);
}

function buildFreeTime(message: string, context: AssistantContext, preferences: AssistantPreferences) {
  const now = new Date();
  const period = requestedStudyPeriod(message);
  const explicitMinutes = requestedStudyDuration(message);
  const minimumMinutes = explicitMinutes ?? preferences.studyMinutes ?? 45;
  const targetDate = /วันไหน/i.test(message)
    ? suggestedStudyDate(context, now, minimumMinutes, period)
    : new Date(now);
  const searchDate = !/วันไหน/i.test(message) && /พรุ่งนี้/i.test(message)
    ? thailandDayStart(targetDate, 1)
    : targetDate;
  const explicitStart = requestedStudyStart(message, searchDate);
  const dayStart = thailandAtHour(searchDate, period?.startHour ?? 9, 0);
  const dayEnd = thailandAtHour(searchDate, period?.endHour ?? 21, 0);
  const targetsToday = sameThailandDay(searchDate, now);
  let cursor = Math.max(dayStart.getTime(), targetsToday ? now.getTime() : dayStart.getTime());
  const gaps: {end: Date; start: Date}[] = [];
  const scheduleSource = targetsToday ? context.todaySchedules : context.upcomingSchedules;
  const activitySource = targetsToday ? context.todayActivities : context.upcomingActivities;
  const events = [
    ...scheduleSource.filter((item) => sameThailandDay(item.startAt.toDate(), searchDate)),
    ...activitySource.filter((item) => item.status !== 'cancelled' && sameThailandDay(item.startAt.toDate(), searchDate)),
  ]
    .filter((item) => item.endAt.toMillis() > dayStart.getTime() && item.startAt.toMillis() < dayEnd.getTime())
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis());
  events.forEach((item) => {
    const start = item.startAt.toDate();
    const end = item.endAt.toDate();
    if (start.getTime() > cursor) gaps.push({end: start, start: new Date(cursor)});
    cursor = Math.max(cursor, end.getTime());
  });
  if (dayEnd.getTime() > cursor) gaps.push({end: dayEnd, start: new Date(cursor)});

  const nearestExam = context.upcomingSchedules
    .filter((item) => EXAM_PATTERN.test(`${item.title} ${item.courseName ?? ''}`) && item.startAt.toMillis() > now.getTime())
    .sort((left, right) => left.startAt.toMillis() - right.startAt.toMillis())[0];
  const daysToExam = nearestExam
    ? Math.ceil((nearestExam.startAt.toMillis() - now.getTime()) / 86_400_000)
    : null;
  const suggestedMinutes = explicitMinutes ?? preferences.studyMinutes ??
    (daysToExam !== null && daysToExam <= 7 ? 60 : daysToExam !== null && daysToExam <= 21 ? 50 : 45);
  const targetMinutes = explicitMinutes
    ? Math.min(240, Math.max(15, Math.round(suggestedMinutes / 5) * 5))
    : Math.min(90, Math.max(30, Math.round(suggestedMinutes / 5) * 5));

  const slots = gaps.flatMap((gap) => {
    const gapMinutes = Math.floor((gap.end.getTime() - gap.start.getTime()) / 60_000);
    if (gapMinutes < Math.min(30, targetMinutes)) return [];
    const duration = explicitMinutes
      ? targetMinutes
      : Math.min(targetMinutes, Math.floor(gapMinutes / 5) * 5);
    if (gapMinutes < duration) return [];
    let start = new Date(gap.start);
    if (explicitStart) {
      if (
        explicitStart.getTime() < gap.start.getTime() ||
        explicitStart.getTime() + duration * 60_000 > gap.end.getTime()
      ) return [];
      start = explicitStart;
    } else if (period) {
      const preferredStart = thailandAtHour(searchDate, period.preferredStartHour, 0);
      if (
        preferredStart.getTime() >= gap.start.getTime() &&
        preferredStart.getTime() + duration * 60_000 <= gap.end.getTime()
      ) {
        start = preferredStart;
      }
    }
    if (!explicitMinutes && start.getTime() > dayStart.getTime() && gapMinutes >= duration + 15) {
      start = new Date(start.getTime() + 15 * 60_000);
    }
    const roundedMinutes = Math.ceil(start.getMinutes() / 5) * 5;
    start.setMinutes(roundedMinutes, 0, 0);
    const end = new Date(start.getTime() + duration * 60_000);
    if (end.getTime() > gap.end.getTime()) return [];
    return [{duration, end, gapEnd: gap.end, gapMinutes, start}];
  }).slice(0, 3);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayWord = targetsToday
    ? 'วันนี้'
    : sameThailandDay(searchDate, tomorrow)
      ? 'พรุ่งนี้'
      : new Intl.DateTimeFormat('th-TH', {
        day: 'numeric',
        month: 'short',
        timeZone: THAI_TIME_ZONE,
        weekday: 'long',
        year: 'numeric',
      }).format(searchDate);
  if (!slots.length) {
    const requestedText = explicitMinutes ? `${explicitMinutes} นาที` : `${targetMinutes} นาที`;
    return `${dayWord}${period ? `${period.label}` : ''}ยังไม่มีช่วงว่างต่อเนื่อง ${requestedText} ตามตารางที่บันทึกไว้ครับ ลองลดระยะเวลาหรือเลือกช่วงอื่น แล้วฉันจะหาเวลาให้ใหม่`;
  }

  const best = slots[0];
  const wantsSpecificWork = /(อ่าน|ทบทวน|ทำโจทย์|ทำการบ้าน|งาน|โปรเจกต์|โปรเจค|โฟกัส)/i.test(message);
  if (!wantsSpecificWork && /(ว่าง|free time)/i.test(message)) {
    return [
      `${dayWord}มีช่วงว่าง ${formatTime(best.start)}-${formatTime(best.gapEnd)} รวมประมาณ ${best.gapMinutes} นาทีครับ`,
      activityForFreeSlot(best.gapMinutes),
      'ฉันเลือกจากช่องว่างจริงในตาราง และจะไม่สร้างงานให้จนกว่าคุณจะขอและกดยืนยัน',
    ].join('\n');
  }
  const alternatives = slots.slice(1).map((slot) =>
    `${formatTime(slot.start)}-${formatTime(slot.end)} (${slot.duration} นาที)`,
  );
  const plan = best.duration <= 60
    ? [
      `1. ใช้เวลาอ่านหรือทำโจทย์ตามที่กำหนด ${best.duration} นาที`,
      `2. เมื่อจบรอบค่อยพัก 5-10 นาที ไม่หักเวลาพักออกจากเวลาที่ผู้ใช้ต้องการอ่าน`,
    ]
    : best.duration <= 120
      ? [
        `1. อ่านรอบแรก 50 นาที`,
        `2. พัก 10 นาที`,
        `3. ใช้เวลาที่เหลืออ่าน ทำโจทย์ และสรุป โดยให้เวลารวมทั้งช่วงเท่ากับ ${best.duration} นาที`,
      ]
      : [
        `1. แบ่งเป็นรอบละ 50 นาที`,
        `2. พักระหว่างรอบ 10 นาที`,
        `3. ใช้ช่วงท้ายทบทวนสรุป เพื่อไม่ให้อ่านต่อเนื่องนานเกินไป`,
      ];
  return [
    `จากตารางที่บันทึกไว้ แนะนำให้อ่าน${dayWord}เวลา ${formatTime(best.start)}-${formatTime(best.end)} รวม ${best.duration} นาทีครับ`,
    ...plan,
    nearestExam
      ? `${plan.length + 1}. เริ่มจาก ${nearestExam.courseName || nearestExam.title} เพราะมีสอบในอีก ${daysToExam} วัน`
      : `${plan.length + 1}. เลือกวิชาที่ใกล้สอบหรืองานที่กำหนดส่งก่อน`,
    alternatives.length ? `ช่วงสำรอง: ${alternatives.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function isStudyTimeIntent(message: string) {
  const hasStudyAction = /(อ่าน(?:หนังสือ)?|ทบทวน|ทำโจทย์|ทำการบ้าน|study|review)/i.test(message);
  const asksForTime = /(เมื่อไหร่|กี่โมง|ตอนไหน|เวลาไหน|ช่วงไหนดี|ช่วงไหน|วันไหน|ควร.*(?:เวลา|ช่วง|วัน)|(?:เช้า|บ่าย|เย็น|ค่ำ|คืนนี้)|\d+\s*(?:ชั่วโมง|ชม\.?|นาที))/i.test(message);
  return hasStudyAction && asksForTime;
}

type AssistantConversationTurn = Pick<AssistantChatMessage, 'content' | 'role'>;

function recentStudySuggestion(conversation: AssistantConversationTurn[]) {
  const recent = conversation
    .filter((turn) => turn.role === 'assistant' || turn.role === 'user')
    .slice(-12);
  const assistantIndex = recent.findLastIndex((turn) =>
    turn.role === 'assistant' &&
    /(แนะนำให้อ่าน|ช่วงที่เหมาะ.*อ่าน|รวม\s*\d+\s*นาที)/i.test(turn.content) &&
    /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/.test(turn.content),
  );
  if (assistantIndex < 0) return null;
  const assistant = recent[assistantIndex].content;
  const previousUser = recent
    .slice(0, assistantIndex)
    .reverse()
    .find((turn) => turn.role === 'user' && /(อ่าน|ทบทวน|ทำโจทย์|ทำการบ้าน)/i.test(turn.content));
  const duration = Number(/รวม\s*(\d+)\s*นาที/i.exec(assistant)?.[1] ?? 0);
  const subject = /เริ่มจาก\s+(.+?)\s+เพราะ/i.exec(assistant)?.[1]?.trim() ?? '';
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    originalRequest: previousUser?.content ?? 'อ่านหนังสือ',
    subject,
  };
}

function isStudyRescheduleConstraint(message: string) {
  return message.length <= 180 &&
    /(ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา|ขอเป็น|เปลี่ยนเป็น|เลื่อน|ว่าง(?:ตอน|ช่วง)?|แทน|เวลาอื่น|วันอื่น|พรุ่งนี้|มะรืน|ช่วงเช้า|ช่วงบ่าย|ช่วงเย็น|ช่วงค่ำ|ตอนเช้า|ตอนบ่าย|ตอนเย็น|ตอนค่ำ)/i.test(message);
}

function contextualStudyReschedule(
  message: string,
  conversation: AssistantConversationTurn[],
) {
  if (!isStudyRescheduleConstraint(message)) return null;
  const previous = recentStudySuggestion(conversation);
  if (!previous) return null;

  let constraint = message.trim();
  const hasPositivePeriod = requestedStudyPeriod(constraint) !== null;
  if (!hasPositivePeriod && /(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา).*เช้า|เช้า.*(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา)/i.test(constraint)) {
    constraint += ' ช่วงบ่าย';
  } else if (!hasPositivePeriod && /(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา).*บ่าย|บ่าย.*(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา)/i.test(constraint)) {
    constraint += ' ช่วงเย็น';
  } else if (!hasPositivePeriod && /(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา).*เย็น|เย็น.*(?:ไม่ว่าง|ไม่สะดวก|ไม่ได้|ไม่เอา)/i.test(constraint)) {
    constraint += ' พรุ่งนี้ช่วงเช้า';
  } else if (!hasPositivePeriod && /(เวลาอื่น|วันอื่น|เลื่อน)/i.test(constraint)) {
    constraint += ' พรุ่งนี้';
  }

  const duration = requestedStudyDuration(constraint) ?? previous.duration;
  const contextualMessage = [
    'อ่านหนังสือ',
    constraint,
    duration ? `${duration} นาที` : '',
  ].filter(Boolean).join(' ');
  return {
    contextualMessage,
    subject: previous.subject,
  };
}

function isStudyPriorityIntent(message: string) {
  if (isStudyTimeIntent(message)) return false;
  return /((?:อ่าน|ทบทวน).*(?:วิชา|อะไร|เรื่อง|ก่อน)|วิชา.*(?:อ่าน|ทบทวน).*ก่อน|เตรียมสอบ.*ก่อน|สอบ.*(?:อะไร|วิชา).*ก่อน|ควร.*(?:อ่าน|ทบทวน)|จัดลำดับ.*(?:อ่าน|ทบทวน)|จากโน้ต.*(?:อ่าน|ทบทวน|เรื่อง))/i.test(message);
}

function noteCategoryForLookup(message: string): Note['category'] | null {
  if (/(ไอเดีย|idea)/i.test(message)) return 'idea';
  if (/(งาน|โปรเจกต์|โปรเจค|การบ้าน|task)/i.test(message)) return 'work';
  if (/(ส่วนตัว|personal)/i.test(message)) return 'personal';
  if (/(การเรียน|วิชา|บทเรียน|สอบ|study|class)/i.test(message)) return 'study';
  return null;
}

function buildNoteLookupAnswer(message: string, context: AssistantContext) {
  let matchingNotes = context.notes;
  const category = noteCategoryForLookup(message);
  const terms = noteLookupTerms(message);

  if (category) matchingNotes = matchingNotes.filter((note) => note.category === category);
  if (/เมื่อวาน/i.test(message)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    matchingNotes = matchingNotes.filter((note) => sameThailandDay(note.updatedAt.toDate(), yesterday));
  } else if (/วันนี้/i.test(message)) {
    const today = new Date();
    matchingNotes = matchingNotes.filter((note) => sameThailandDay(note.updatedAt.toDate(), today));
  }
  if (terms.length) {
    matchingNotes = matchingNotes.filter((note) => {
      const searchable = `${note.title} ${note.content}`.normalize('NFC').toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  if (!matchingNotes.length) {
    if (context.availability.notes !== 'available') {
      return 'ตอนนี้ดึงโน้ตได้ไม่ครบ จึงยังยืนยันไม่ได้ว่าไม่มีโน้ตที่ตรงกับคำถามครับ กรุณาลองใหม่อีกครั้ง';
    }
    const subject = terms.length ? `ที่ตรงกับคำว่า “${terms.join(' ')}”` : category ? 'ในหมวดที่ถาม' : '';
    return `ไม่พบโน้ต${subject}จากข้อมูลที่บันทึกไว้ครับ`;
  }

  const wantsContent = /(คืออะไร|ว่าอะไร|เขียนว่า|เนื้อหา|ทวน|อ่าน|สรุป)/i.test(message);
  const lines = matchingNotes.slice(0, 5).map((note, index) => {
    const content = note.content.trim();
    if (!wantsContent || !content) return `${index + 1}. ${note.title}`;
    return `${index + 1}. ${note.title}: ${content.slice(0, 220)}`;
  });
  return `พบโน้ต ${matchingNotes.length} รายการครับ\n${lines.join('\n')}`;
}

function ocrYearDescription(value: string) {
  const year = Number(value.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1]);
  if (!Number.isFinite(year)) return '';
  if (year >= 2400 && year <= 2699) {
    return ` เป็นปี พ.ศ. ${year} (ตรงกับ ค.ศ. ${year - 543})`;
  }
  if (year >= 1900 && year <= 2199) {
    return ` เป็นปี ค.ศ. ${year} (ตรงกับ พ.ศ. ${year + 543})`;
  }
  return '';
}

function buildRecentOcrAnswer(context: AssistantContext) {
  if (context.availability.ocr === 'failed') {
    return 'ตอนนี้ดึงประวัติ OCR ไม่สำเร็จ จึงยังยืนยันข้อมูลบนสลิปให้ไม่ได้ครับ กรุณาลองอีกครั้งเมื่อเชื่อมต่อได้';
  }
  const scan = context.recentScanLogs.find((item) =>
    item.kind === 'receipt' && item.status === 'completed',
  );
  if (!scan) return 'ยังไม่พบสลิปหรือใบเสร็จที่ OCR อ่านสำเร็จในประวัติล่าสุดครับ';

  const parsed = {
    ...(scan.parsed ?? {}),
    ...(scan.correctedParsed ?? {}),
  };
  const field = (...values: unknown[]) => values.find((value) =>
    typeof value === 'string' ? Boolean(value.trim()) : value !== null && value !== undefined,
  );
  const merchant = String(field(parsed.merchant, parsed.merchantName, parsed.store, parsed.vendor) ?? 'ไม่พบ');
  const amountValue = field(parsed.amount, parsed.total, parsed.totalAmount);
  const amount = typeof amountValue === 'number'
    ? `${amountValue.toLocaleString('th-TH', {maximumFractionDigits: 2})} บาท`
    : amountValue ? `${String(amountValue)} บาท` : 'ไม่พบ';
  const date = String(field(parsed.date) ?? 'ไม่พบ');
  const time = String(field(parsed.time) ?? 'ไม่พบ');
  const scannedAt = scan.createdAt?.toDate instanceof Function
    ? textDate(scan.createdAt.toDate())
    : 'ไม่ทราบเวลาที่สแกน';
  return [
    `พบใบเสร็จล่าสุดในประวัติ OCR ซึ่งสแกนเมื่อ ${scannedAt} ครับ`,
    `วันที่บนเอกสาร: ${date}${date === 'ไม่พบ' ? '' : ocrYearDescription(date)}`,
    `เวลา: ${time}`,
    `จำนวนเงิน: ${amount}`,
    `ร้านค้า/ผู้รับเงิน: ${merchant}`,
    scan.correctedByUser ? 'ข้อมูลชุดนี้เป็นค่าที่ผู้ใช้ตรวจและแก้ไขแล้ว' : 'ควรเทียบกับรูปต้นฉบับอีกครั้งหากช่องใดมีความมั่นใจต่ำ',
  ].join('\n');
}

function buildDynamicBurnoutAnswer(context: AssistantContext) {
  const insight = context.dynamic.burnout;
  const riskLabel = burnoutRiskBand(insight.riskLevel).label;
  // Three distinct sentences, because the three cases are genuinely different
  // claims: measured nights, a stated habit, and nothing at all. Collapsing the
  // middle one into the first is exactly how a default starts reading as data.
  const sleepLine = insight.sleepEvidenceSource === 'logged'
    ? `ข้อมูลการนอน (บันทึกจริง): มี ${insight.sleepDataDays} คืน${insight.averageSleepHours === null ? '' : ` เฉลี่ย ${insight.averageSleepHours} ชั่วโมง`}${insight.lateSleepStreak >= 2 ? ` และนอนหลังเที่ยงคืนต่อเนื่อง ${insight.lateSleepStreak} คืน` : ''}`
    : insight.sleepEvidenceSource === 'baseline'
      ? `ข้อมูลการนอน: ยังไม่มีบันทึกจริงในช่วงนี้ จึงใช้ช่วงนอนปกติที่ตั้งไว้ ${insight.averageSleepHours} ชั่วโมงเป็นค่าอ้างอิง ซึ่งเป็นค่าที่ตั้งเอง ไม่ใช่การนอนที่วัดได้`
      : 'ข้อมูลการนอน: ยังไม่มีการบันทึก จึงไม่นำเรื่องการนอนมาคาดเดาหรือคิดคะแนน';
  const sleepDebtLine = insight.sleepDebtHours !== null && insight.sleepDebtNights >= 3
    ? [`การนอนขาดสะสมใน ${insight.sleepDebtNights} คืนที่บันทึกไว้: ${insight.sleepDebtHours} ชั่วโมง (เทียบเป้าหมาย ${SLEEP_REFERENCE.targetHours} ชั่วโมงต่อคืน)`]
    : [];
  const reasonLines = insight.reasons.length
    ? insight.reasons.slice(0, 4).map((reason, index) => `${index + 1}. ${reason}`)
    : ['1. จากข้อมูลที่มี ยังไม่พบสัญญาณภาระสูงที่เข้าเกณฑ์เตือน'];
  const evidenceLabel = insight.evidenceCoverage === 'strong' ? 'ค่อนข้างครบ' : insight.evidenceCoverage === 'partial' ? 'บางส่วน' : 'ยังน้อย';
  return [
    `จากข้อมูลจริง 7 วัน ความเสี่ยงสภาวะหมดไฟอยู่ระดับ${riskLabel} (${insight.score}/100) นี่เป็นเพียงสัญญาณเตือน ไม่ใช่การวินิจฉัยครับ`,
    `หลักฐานที่ใช้ (${evidenceLabel})`,
    ...reasonLines,
    `${reasonLines.length + 1}. งานค้าง ${insight.pendingTaskCount} รายการ งานด่วน ${insight.urgentTaskCount} รายการ`,
    `${reasonLines.length + 2}. ${sleepLine}`,
    ...(insight.studyWorkToSleepRatio === null ? [] : [`${reasonLines.length + 3}. สัดส่วนเวลาเรียน/งานเฉลี่ยต่อวันต่อเวลานอนที่บันทึกประมาณ ${insight.studyWorkToSleepRatio}:1`]),
    ...sleepDebtLine,
    `เกณฑ์ชั่วโมงการนอนอ้างอิงจาก ${TRUSTED_COACHING_SOURCES.sleepDuration.label} (แนะนำ ${SLEEP_REFERENCE.recommendedMinHours}-${SLEEP_REFERENCE.recommendedMaxHours} ชั่วโมงต่อคืนสำหรับวัยผู้ใหญ่ตอนต้นและผู้ใหญ่)`,
    `คำแนะนำตอนนี้: ${activityForFreeSlot(insight.longestFreeSlotMinutes)}`,
    `อ้างอิงแนวทางทั่วไปจาก ${TRUSTED_COACHING_SOURCES.wellbeing.label} และไม่ใช้แทนการประเมินโดยผู้เชี่ยวชาญ`,
    WELLBEING_AI_DISCLAIMER,
  ].join('\n');
}

function buildDynamicBudgetAnswer(context: AssistantContext) {
  const finance = context.dynamic.finance;
  if (!finance) return 'ยังไม่มีวงเงินที่ใช้คำนวณครับ ไปที่หน้าการเงินแล้วตั้งงบหนึ่งครั้ง ระบบจะกระจายเป็นกรอบรายสัปดาห์และเตือนเมื่อใช้ถึง 80% ให้';
  const status = finance.weeklyStatus === 'exceeded'
    ? 'เกินกรอบสัปดาห์แล้ว'
    : finance.weeklyStatus === 'warning' ? 'แตะระดับเตือน 80% แล้ว' : 'ยังอยู่ในกรอบ';
  return [
    `งบสัปดาห์นี้ ${finance.weeklyBudget.toLocaleString('th-TH')} บาท ใช้จริง ${finance.weekSpent.toLocaleString('th-TH')} บาท (${finance.weeklyUsagePercent}%)`,
    `เหลือ ${Math.max(0, finance.weeklyRemainingBudget).toLocaleString('th-TH')} บาท สถานะ: ${status}`,
    finance.weeklyStatus === 'safe'
      ? 'ยังไม่ต้องบังคับตัวเองเป็นงบรายวันครับ แค่รักษายอดรวมทั้งสัปดาห์ให้อยู่ในกรอบ'
      : 'ช่วงที่เหลือให้กันค่าอาหาร ค่าเดินทาง และรายการจำเป็นก่อนรายจ่ายอื่นครับ',
    `แนวทางการวางแผนมาจาก ${TRUSTED_COACHING_SOURCES.finance.label}`,
  ].join('\n');
}

function contextAnswer(message: string, context: AssistantContext, preferences: AssistantPreferences) {
  if (/^(?:หวัดดี|สวัสดี|ดีจ้า|hello|hi)(?:ครับ|ค่ะ|คับ|จ้า)?$/i.test(message.trim())) {
    return 'หวัดดีครับ! ฉันช่วยเช็กตาราง งานค้าง เงินคงเหลือ หรือช่วยจดรายการให้ได้เลย วันนี้อยากจัดการเรื่องไหนก่อนครับ?';
  }
  const selfContainedAnswer = selfContainedAssistantFallback(message);
  if (selfContainedAnswer) return selfContainedAnswer;
  if (/(หมดไฟ|burn\s*out|burnout|เครียด|เหนื่อย|ล้า|ไม่ไหว|ท้อ|ข้อมูลการนอน|นอน.*กี่คืน|สุขภาพใจ)/i.test(message)) {
    return buildDynamicBurnoutAnswer(context);
  }
  if (/(ai\s*dynamic|ไดนามิก|งบรายเดือน|งบรายสัปดาห์|งบสัปดาห์|ใช้ไปกี่เปอร์เซ็นต์|เตือน.*80|เงินพอไหม|ใช้เงินได้เท่าไร)/i.test(message)) {
    return buildDynamicBudgetAnswer(context);
  }
  if (
    /(ตารางเรียน|ตาราง|เรียน)/i.test(message) &&
    /(งาน.*(?:ใกล้ส่ง|ค้าง|กำหนดส่ง)|(?:ใกล้ส่ง|ค้าง|กำหนดส่ง).*งาน)/i.test(message) &&
    /(งบ|เงิน.*เหลือ|ยอดคงเหลือ)/i.test(message) &&
    /(พรุ่งนี้|วางแผน)/i.test(message)
  ) {
    return [
      'สรุปเพื่อวางแผนพรุ่งนี้จากข้อมูลที่บันทึกไว้',
      `ตาราง: ${buildCalendarTimeAnswer('พรุ่งนี้', context)}`,
      `งาน: ${buildUpcomingTasksAnswer(context)}`,
      `การเงิน: ${buildFinanceAnswer('ยอดคงเหลือเดือนนี้', context, preferences)}`,
      'ลำดับที่แนะนำคือทำรายการที่มีกำหนดส่งใกล้ที่สุดก่อน แล้วจัดช่วงเรียนตามเวลาในตาราง และใช้งบพรุ่งนี้ไม่เกินกรอบที่คำนวณจากยอดคงเหลือครับ',
    ].join('\n\n');
  }
  if (isReceiptImageLookupRequest(message)) {
    return buildRecentOcrAnswer(context);
  }
  const scheduleLookup = isCalendarTimeLookupIntent(message) || isExamScheduleLookupIntent(message) ||
    isUpcomingClassLookupIntent(message) || isActivityLookupIntent(message) || isStudyTimeIntent(message);
  if (scheduleLookup && context.availability.schedules === 'failed') {
    return 'ตอนนี้ดึงตารางเรียนและกิจกรรมไม่สำเร็จ จึงยังยืนยันวันหรือเวลาให้ไม่ได้ครับ กรุณาลองใหม่อีกครั้ง';
  }
  if (/(สรุปวันนี้|briefing|วันนี้ต้องทำอะไร)/i.test(message)) return buildDailyBriefing(context, preferences);
  if (isCalendarTimeLookupIntent(message)) return buildCalendarTimeAnswer(message, context);
  if (isExamScheduleLookupIntent(message)) return buildExamScheduleAnswer(message, context);
  if (isUpcomingClassLookupIntent(message)) return buildUpcomingClassAnswer(message, context);
  if (isActivityLookupIntent(message)) return buildActivityAnswer(message, context);
  if (isStudyTimeIntent(message)) return buildFreeTime(message, context, preferences);
  if (isStudyPriorityIntent(message)) return buildStudyPriorityAdvice(context, preferences);
  if (isTaskLookupIntent(message)) return buildUpcomingTasksAnswer(context);
  if (isNoteLookupIntent(message)) return buildNoteLookupAnswer(message, context);
  if (/(ว่างเมื่อไร|เวลาว่าง|มีเวลาว่าง|free time)/i.test(message)) return buildFreeTime(message, context, preferences);
  if (/(เรียนหนักไหม|งานเยอะไหม|ภาระงาน|เหนื่อยเกินไปไหม|workload)/i.test(message)) return buildWorkloadSummary(context);
  if (isFinanceLookupIntent(message)) return buildFinanceAnswer(message, context, preferences);
  if (/(งบตึง|budget guard|เงินพอไหม|ควรใช้วันละ|เช็กงบ|วิเคราะห์งบ)/i.test(message)) return buildBudgetGuard(context, preferences);
  if (/(วันนี้|today).*(เรียน|ตาราง|กี่โมง)|เรียน.*(วันนี้|กี่โมง)/i.test(message)) {
    const all = [...context.todaySchedules, ...context.todayActivities].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
    if (!all.length) return 'วันนี้ยังไม่มีตารางเรียนหรืองานที่บันทึกไว้เลยนะ เหมาะกับการเคลียร์โน้ตหรือพักสักหน่อย';
    const lines = all.slice(0, 5).map((item) => `• ${item.title} (${textDate(item.startAt.toDate())})`);
    return `วันนี้มี ${all.length} รายการนะ\n${lines.join('\n')}`;
  }
  if (/(เงิน|งบ|ใช้ไป|เหลือ|budget|finance)/i.test(message)) {
    if (/(วันนี้|today|กินข้าว|อาหาร)/i.test(message)) {
      const today = rangeFor('day');
      const spentToday = context.monthTransactions
        .filter((item) => item.type === 'expense' && item.occurredAt.toMillis() >= today.start.getTime() && item.occurredAt.toMillis() < today.end.getTime())
        .reduce((sum, item) => sum + item.amount, 0);
      const weekly = context.dynamic.finance;
      if (weekly) return `วันนี้ใช้ไป ${spentToday.toLocaleString('th-TH')} บาทครับ ส่วนกรอบสัปดาห์ใช้ไปแล้ว ${weekly.weekSpent.toLocaleString('th-TH')} จาก ${weekly.weeklyBudget.toLocaleString('th-TH')} บาท (${weekly.weeklyUsagePercent}%) เหลือ ${Math.max(0, weekly.weeklyRemainingBudget).toLocaleString('th-TH')} บาท`;
      return `วันนี้ใช้ไปแล้ว ${spentToday.toLocaleString('th-TH')} บาทครับ ตั้งวงเงินในหน้าการเงินก่อน แล้วฉันจะช่วยติดตามเป็นงบรายสัปดาห์ให้`;
    }
    return `เดือนนี้มีรายรับ ${context.monthIncome.toLocaleString('th-TH')} บาท รายจ่าย ${context.monthExpense.toLocaleString('th-TH')} บาท ตอนนี้คงเหลือประมาณ ${context.balance.toLocaleString('th-TH')} บาทนะ`;
  }
  if (/(เครียด|เหนื่อย|หมดไฟ|ไม่ไหว|ท้อ)/i.test(message)) {
    return buildDynamicBurnoutAnswer(context);
  }
  return '';
}

function contextualOfflineAnswer(
  intent: AssistantIntent,
  message: string,
  conversation: AssistantConversationTurn[],
  context: AssistantContext,
  preferences: AssistantPreferences,
) {
  const recentConversation = conversation
    .slice(-6)
    .map((turn) => turn.content)
    .join(' ');
  const asksForMoreAdvice = /^(?:ช่วย)?\s*(?:แนะนำ|แนะนํา|บอก|วางแผน)(?:ให้)?(?:หน่อย)?(?:ครับ|ค่ะ|คับ)?$/i
    .test(message.trim());

  if (
    intent === 'task_note' &&
    asksForMoreAdvice &&
    /(อ่าน|หนังสือ|ทบทวน|สอบ|วิชา)/i.test(recentConversation)
  ) {
    return buildStudyPriorityAdvice(context, preferences);
  }
  if (intent === 'finance') return buildFinanceAnswer(message, context, preferences);
  if (intent === 'schedule') {
    const previousUserMessage = [...conversation]
      .reverse()
      .find((turn) => turn.role === 'user')?.content ?? '';
    return /ว่าง|อ่าน|หนังสือ|ทบทวน/i.test(`${message} ${recentConversation}`)
      ? buildFreeTime(`${previousUserMessage} ${message}`.trim(), context, preferences)
      : buildDailyBriefing(context, preferences);
  }
  if (intent === 'task_note') return buildPriorityPlan(context, preferences);
  return '';
}

async function loadAssistantState(uid: string) {
  return Promise.all([loadAssistantContext(uid), loadAssistantPreferences(uid)]);
}

export async function buildAssistantReply(
  uid: string,
  message: string,
  conversation: AssistantConversationTurn[] = [],
  options: {
    conversationId?: string;
    conversationState?: AssistantConversationState;
  } = {},
): Promise<AssistantReply> {
  const startedAt = Date.now();
  const understoodMessage = normalizeNaturalLanguageInput(message);
  const runtimeConversationState: AssistantConversationState = options.conversationState ?? {
    conversationId: options.conversationId ?? `conversation-ephemeral-${startedAt}`,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const intent = classifyAssistantIntent(
    understoodMessage,
    runtimeConversationState.lastIntent ?? latestConversationIntent(conversation),
  );
  const reply = (
    content: string,
    source: AssistantReplySource,
    options: {
      errorKind?: AssistantErrorKind;
      pendingTaskShortcuts?: AssistantPendingTaskShortcut[];
      proposedAction?: AssistantProposedAction;
      statePatch?: AssistantConversationStatePatch;
      suggestions?: string[];
    } = {},
  ): AssistantReply => ({
    content,
    errorKind: options.errorKind,
    intent,
    latencyMs: Date.now() - startedAt,
    pendingTaskShortcuts: options.pendingTaskShortcuts,
    proposedAction: options.proposedAction,
    source,
    statePatch: options.statePatch ?? {lastIntent: intent},
    suggestions: options.suggestions,
  });
  const financialScenarioIsRelevant = shouldUseDeterministicFinancialScenario(
    understoodMessage,
    runtimeConversationState.financialScenario,
  );
  const financialScenarioAnswer = financialScenarioIsRelevant
    ? deterministicFinancialScenarioAnswer(runtimeConversationState.financialScenario, understoodMessage)
    : '';
  if (financialScenarioAnswer) {
    return reply(financialScenarioAnswer, 'deterministic', {
      statePatch: {financialScenario: runtimeConversationState.financialScenario, lastIntent: 'finance'},
    });
  }
  const creationClarification = scheduleCreationClarification(message);
  if (creationClarification) return reply(creationClarification, 'deterministic');
  const proposedAction = proposeActionFromMessage(message);
  if (proposedAction) {
    const lookupClauses = readOnlyClausesFromMixedMessage(message);
    if (lookupClauses.length) {
      const [context, preferences] = await loadAssistantState(uid);
      const lookupAnswers = lookupClauses
        .map((clause) => contextAnswer(normalizeNaturalLanguageInput(clause), context, preferences))
        .filter(Boolean);
      if (lookupAnswers.length) {
        return reply(
          `${lookupAnswers.join('\n\n')}\n\nฉันเตรียมรายการอีกส่วนไว้แล้ว กรุณาตรวจสอบการ์ดก่อนกดยืนยันบันทึกครับ`,
          'deterministic',
          {proposedAction},
        );
      }
    }
    return reply(
      'ได้เลย ฉันแปลงจากข้อความเป็นรายการให้แล้ว ตรวจดูอีกทีนะ ถ้าถูกก็กดยืนยันได้เลย',
      'deterministic',
      {proposedAction},
    );
  }
  const responseMode = chooseAssistantResponseMode(understoodMessage);
  const executionRoute = chooseAssistantExecutionRoute({hasMutation: false, isDemoMode});
  const loadFallback = async () => {
    const [context, preferences] = await loadAssistantState(uid);
    const studyReschedule = contextualStudyReschedule(understoodMessage, conversation);
    let answer = '';
    if (studyReschedule) {
      const rescheduled = buildFreeTime(studyReschedule.contextualMessage, context, preferences);
      const retainedSubject = studyReschedule.subject && !rescheduled.includes(studyReschedule.subject)
        ? `\nใช้ช่วงใหม่นี้อ่าน ${studyReschedule.subject} ตามที่คุยไว้ได้เลยครับ`
        : '';
      answer = `เข้าใจครับ งั้นปรับเวลาใหม่ตามที่บอกนะ\n${rescheduled}${retainedSubject}`;
    } else {
      answer = contextAnswer(understoodMessage, context, preferences);
    }
    return {answer, context, preferences};
  };
  // Read-only questions and advice are Gemini-first so follow-ups can revise,
  // compare, plan, and answer every part naturally. The client only reads
  // Firestore if a deterministic fallback is actually needed.
  if (executionRoute === 'gemini') {
    try {
      // App Check readiness and the Firestore context read are independent --
      // `loadAssistantState` runs elsewhere in this file without waiting on
      // App Check at all -- so there is no reason to pay for them back to back
      // before the Gemini call can even go out.
      const [, [context]] = await Promise.all([ensureAppCheckReady(), loadAssistantState(uid)]);
      const history = conversation
        .filter((turn): turn is AssistantConversationTurn & {role: 'assistant' | 'user'} =>
          turn.role === 'assistant' || turn.role === 'user',
        )
        .slice(-12)
        .map((turn) => ({content: turn.content.slice(0, 600), role: turn.role}));
      const assistantRequest = {
        clientDynamicContext: context.dynamic,
        conversationId: runtimeConversationState.conversationId,
        // Do not send an old finance scenario into an unrelated turn. History
        // remains available, but the latest message must explicitly continue
        // the scenario before its structured numbers can influence Gemini.
        conversationState: financialScenarioIsRelevant
          ? runtimeConversationState
          : {...runtimeConversationState, financialScenario: undefined},
        history,
        intent,
        message: understoodMessage,
        responseMode,
      };
      const result = await withAssistantAuthRetry(
        () => smartLifeAssistantReply(assistantRequest),
        {
          expectedUid: uid,
          getCurrentUid: () => auth.currentUser?.uid,
          refreshToken: () => auth.currentUser?.getIdToken(true) ?? Promise.reject(new Error('No authenticated user.')),
        },
      );
      const content = result.data.content.trim();
      const suggestions = Array.isArray(result.data.suggestions)
        ? result.data.suggestions
          .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          .map((item) => item.trim().slice(0, 120))
          .slice(0, 3)
        : [];
      if (content) {
        const selectedTask = result.data.selectedTask?.title ? result.data.selectedTask : undefined;
        return reply(content, 'gemini', {
          pendingTaskShortcuts: isTaskLookupIntent(understoodMessage) ? pendingTaskShortcuts(context) : undefined,
          statePatch: selectedTask ? {
            lastIntent: intent,
            selectedTask: {
              dueAt: selectedTask.dueAt,
              title: selectedTask.title,
            },
          } : {lastIntent: intent},
          suggestions,
        });
      }
      throw Object.assign(new Error('SmartLife AI returned an empty response.'), {code: 'functions/data-loss'});
    } catch (error) {
      const errorKind = classifyAssistantError(error);
      try {
        const {answer, context, preferences} = await loadFallback();
        if (answer) return reply(answer, 'fallback', {
          errorKind,
          pendingTaskShortcuts: isTaskLookupIntent(understoodMessage) ? pendingTaskShortcuts(context) : undefined,
        });
        const offlineAnswer = contextualOfflineAnswer(
          intent,
          understoodMessage,
          conversation,
          context,
          preferences,
        );
        if (offlineAnswer) return reply(offlineAnswer, 'fallback', {
          errorKind,
          pendingTaskShortcuts: isTaskLookupIntent(understoodMessage) ? pendingTaskShortcuts(context) : undefined,
        });
      } catch (fallbackError) {
        const fallbackErrorKind = classifyAssistantError(fallbackError);
        if (fallbackErrorKind === 'authentication' || fallbackErrorKind === 'permission') {
          return reply(assistantErrorMessage(fallbackErrorKind), 'fallback', {errorKind: fallbackErrorKind});
        }
      }
      return reply(assistantErrorMessage(errorKind), 'fallback', {errorKind});
    }
  }
  try {
    const {answer, context} = await loadFallback();
    if (answer) return reply(answer, 'deterministic', {
      pendingTaskShortcuts: isTaskLookupIntent(understoodMessage) ? pendingTaskShortcuts(context) : undefined,
    });
  } catch (error) {
    const errorKind = classifyAssistantError(error);
    return reply(assistantErrorMessage(errorKind), 'fallback', {errorKind});
  }
  return reply(
    'ฉันช่วยเช็กตาราง งานค้าง การเงิน และโน้ต หรือช่วยเพิ่มรายการให้ได้ครับ ลองบอกสิ่งที่อยากจัดการมาได้เลย',
    'fallback',
  );
}

export async function confirmAssistantAction(uid: string, action: AssistantProposedAction) {
  if (action.entity === 'memory') {
    await saveAssistantPreference(uid, action.payload.key, action.payload.value);
    return {id: action.payload.key, page: 'smartlife_ai_assistant'};
  }
  if (action.entity === 'checklist') {
    const startAt = new Date(action.payload.startAt);
    const ids = await Promise.all(action.payload.items.map((title, index) => {
      const taskStart = thailandAtHour(startAt, 9, 0, index);
      const taskEnd = new Date(taskStart.getTime() + 60 * 60 * 1000);
      return activities.create(uid, {
        color: '#BB9293',
        endAt: Timestamp.fromDate(taskEnd),
        location: '',
        source: 'ai',
        startAt: Timestamp.fromDate(taskStart),
        status: 'planned',
        title: `${action.payload.title}: ${title}`,
        type: 'task',
      });
    }));
    return {id: ids[0] ?? '', page: 'smartlife_calendar_day'};
  }
  if (action.entity === 'finance') {
    const payload = action.payload;
    const result = await transactions.create(uid, {
      amount: payload.amount,
      category: payload.category,
      merchant: '',
      note: payload.note ?? 'บันทึกผ่าน SmartLife AI',
      occurredAt: Timestamp.fromDate(new Date(payload.date)),
      receiptPath: '',
      type: payload.type,
    });
    return {id: result, page: 'smartlife_finance_month'};
  }
  if (action.entity === 'note') {
    const payload = action.payload;
    const result = await notes.create(uid, {
      category: payload.tag === 'idea' ? 'idea' : payload.tag === 'task' ? 'work' : 'study',
      color: '#BB9293',
      content: payload.body,
      relatedScheduleId: payload.linkedScheduleId ?? '',
      completedAt: null,
      status: 'pending',
      title: payload.title,
    });
    return {id: result, page: 'smartlife_notes'};
  }
  const payload = action.payload;
  const startAt = new Date(payload.startAt);
  const endAt = payload.endAt ? new Date(payload.endAt) : new Date(startAt.getTime() + 60 * 60 * 1000);
  if (!payload.allowOverlap) {
    const conflicts = await findScheduleConflicts(uid, startAt, endAt);
    if (conflicts.length) return {conflicts, id: '', page: 'smartlife_calendar_day', requiresConflictConfirmation: true as const};
  }
  if (payload.type === 'class') {
    const result = await schedules.create(uid, {
      color: '#6F8F6D',
      courseCode: '',
      courseName: '',
      endAt: Timestamp.fromDate(endAt),
      location: payload.location ?? '',
      source: 'manual',
      startAt: Timestamp.fromDate(startAt),
      title: payload.title,
    });
    return {id: result, page: 'smartlife_calendar_day'};
  }
  if (!isDemoMode && payload.type === 'task' && payload.isFlexible && payload.aiScheduled) {
    const result = await adaptiveScheduling.createActivity({
      activityCategory: (payload.category ?? 'other') as Parameters<typeof adaptiveScheduling.createActivity>[0]['activityCategory'],
      allowOverlap: payload.allowOverlap,
      dateLocked: payload.dateLocked,
      deadline: payload.deadline ?? null,
      durationMinutes: payload.estimatedDurationMinutes ?? Math.max(15, Math.round((endAt.getTime() - startAt.getTime()) / 60_000)),
      endAt: endAt.toISOString(),
      generatedForTimeZone: payload.generatedForTimeZone,
      explanation: payload.aiReason ?? 'จัดเวลาจาก SmartLife AI และตรวจสอบตารางก่อนบันทึก',
      startAt: startAt.toISOString(),
      title: payload.title,
      ...(payload.userSelectedTime ? {userSelectedTime: true} : {}),
    }, action.id);
    if (!result.saved) return {conflicts: result.conflicts, id: '', page: 'smartlife_calendar_day', requiresConflictConfirmation: true as const};
    return {conflicts: result.conflicts, id: result.id, page: 'smartlife_calendar_day', requiresConflictConfirmation: false as const};
  }
  const result = await activities.create(uid, {
    ...(payload.aiReason ? {aiReason: payload.aiReason} : {}),
    ...(payload.aiScheduled !== undefined ? {aiScheduled: payload.aiScheduled} : {}),
    ...(payload.allowAiReschedule !== undefined ? {allowAiReschedule: payload.allowAiReschedule} : {}),
    ...(payload.category ? {category: payload.category} : {}),
    color: payload.type === 'task' ? '#BB9293' : '#9297BB',
    ...(payload.deadline ? {deadline: Timestamp.fromDate(new Date(payload.deadline))} : {}),
    endAt: Timestamp.fromDate(endAt),
    ...(payload.estimatedDurationMinutes ? {estimatedDurationMinutes: payload.estimatedDurationMinutes} : {}),
    ...(payload.isFlexible !== undefined ? {isFlexible: payload.isFlexible} : {}),
    location: payload.location ?? '',
    source: 'ai',
    startAt: Timestamp.fromDate(startAt),
    status: 'planned',
    title: payload.title,
    type: payload.type === 'task' ? 'task' : 'appointment',
  });
  return {id: result, page: 'smartlife_calendar_day'};
}
