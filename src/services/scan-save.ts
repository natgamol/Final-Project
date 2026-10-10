import {Timestamp} from 'firebase/firestore';

import {noteFolders, notes, schedules} from '@/services/firestore';
import {documentNoteText} from '@/services/document-note-text';
import {saveReviewedReceipt, type OcrResult} from '@/services/ocr';
import {ensureUserProfile} from '@/services/auth';
import {normalizeExpenseCategory} from '@/config/expense-categories';
import {scheduleCourseLabel, timetableHoursProblem} from '@/lib/timetable-hours';

type ScheduleEntry = {
  buildingName?: string;
  classTime?: string;
  courseCode?: string;
  courseName?: string;
  day?: string;
  endTime?: string;
  finalExam?: string;
  midtermExam?: string;
  room?: string;
  section?: string;
  startTime?: string;
};

export type SavedScan = {
  destination: 'smartlife_calendar_month' | 'smartlife_finance_month' | 'smartlife_planner_notes';
  documentIds: string[];
  duplicate?: boolean;
};

const THAI_WEEKDAYS: [number, string[]][] = [
  [0, ['\u0e2d\u0e32\u0e17\u0e34\u0e15\u0e22\u0e4c', 'sunday', 'sun']],
  [1, ['\u0e08\u0e31\u0e19\u0e17\u0e23\u0e4c', 'monday', 'mon']],
  [2, ['\u0e2d\u0e31\u0e07\u0e04\u0e32\u0e23', 'tuesday', 'tue']],
  [3, ['\u0e1e\u0e38\u0e18', 'wednesday', 'wed']],
  [4, ['\u0e1e\u0e24\u0e2b\u0e31\u0e2a\u0e1a\u0e14\u0e35', 'thursday', 'thu']],
  [5, ['\u0e28\u0e38\u0e01\u0e23\u0e4c', 'friday', 'fri']],
  [6, ['\u0e40\u0e2a\u0e32\u0e23\u0e4c', 'saturday', 'sat']],
];

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

const THAI_DIGITS: Record<string, string> = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
};

const THAI_MONTHS: Record<string, number> = {
  'มค': 1, 'มกราคม': 1,
  'กพ': 2, 'กุมภาพันธ์': 2,
  'มีค': 3, 'มีนาคม': 3,
  'เมย': 4, 'เมษายน': 4,
  'พค': 5, 'พฤษภาคม': 5,
  'มิย': 6, 'มิถุนายน': 6,
  'กค': 7, 'กรกฎาคม': 7,
  'สค': 8, 'สิงหาคม': 8,
  'กย': 9, 'กันยายน': 9,
  'ตค': 10, 'ตุลาคม': 10,
  'พย': 11, 'พฤศจิกายน': 11,
  'ธค': 12, 'ธันวาคม': 12,
};

function normalizeThaiDigits(value: unknown) {
  return text(value).replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit] ?? '');
}

export function parseCurrencyAmount(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let normalized = String(value ?? '')
    .replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit] ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/(?:THB|บาท|฿)/gi, '')
    .replace(/\s+/g, '')
    .replace(/[^\d.,-]/g, '');
  if (!normalized) return null;

  const commaCount = (normalized.match(/,/g) ?? []).length;
  const dotCount = (normalized.match(/\./g) ?? []).length;
  if (commaCount && dotCount) {
    normalized = normalized.replace(/,/g, '');
  } else if (commaCount === 1 && !dotCount) {
    const [, decimals = ''] = normalized.split(',');
    normalized = decimals.length === 1 || decimals.length === 2
      ? normalized.replace(',', '.')
      : normalized.replace(',', '');
  } else if (commaCount > 1) {
    normalized = normalized.replace(/,/g, '');
  }

  if ((normalized.match(/\./g) ?? []).length > 1) {
    const decimalIndex = normalized.lastIndexOf('.');
    normalized = `${normalized.slice(0, decimalIndex).replace(/\./g, '')}${normalized.slice(decimalIndex)}`;
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function firstAmountValue(draft: Record<string, unknown>) {
  return [draft.total, draft.amount, draft.totalAmount].find(
    (value) => String(value ?? '').trim().length > 0,
  );
}

function receiptItemsForStorage(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const name = text(item.name).slice(0, 180);
    const finalPrice = Number(item.totalPrice);
    if (!name || !Number.isFinite(finalPrice)) return [];
    const quantityText = String(item.quantity ?? '').trim();
    const rawQuantity = quantityText ? Number(quantityText) : Number.NaN;
    const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
    const rawUnitPrice = Number(item.unitPrice);
    const unitPrice = Number.isFinite(rawUnitPrice)
      ? Number(rawUnitPrice.toFixed(2))
      : Number((finalPrice / quantity).toFixed(2));
    const rawDiscount = Number(item.discount);
    return [{
      discountAmount: Number.isFinite(rawDiscount) && rawDiscount > 0
        ? Number(rawDiscount.toFixed(2))
        : 0,
      finalPrice: Number(finalPrice.toFixed(2)),
      name,
      quantity,
      unitPrice,
    }];
  }).slice(0, 100);
}

function bangkokDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
  }).formatToParts(value);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {day: get('day'), month: get('month'), year: get('year')};
}

function parseRequiredTime(value: unknown, label: string) {
  const match = text(value).match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (!match) throw new Error(`\u0e01\u0e23\u0e38\u0e13\u0e32\u0e40\u0e25\u0e37\u0e2d\u0e01${label} \u0e43\u0e2b\u0e49\u0e04\u0e23\u0e1a\u0e01\u0e48\u0e2d\u0e19\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01`);
  return {
    hour: Math.min(23, Math.max(0, Number(match[1]))),
    minute: Math.min(59, Math.max(0, Number(match[2]))),
  };
}

/** A parsed time back as `HH:MM`, the form the shared timetable rule reads. */
function clockText(value: {hour: number; minute: number}) {
  return `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`;
}

function parseTime(value: unknown, fallbackHour: number) {
  const match = text(value).match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  return match ? {
    hour: Math.min(23, Math.max(0, Number(match[1]))),
    minute: Math.min(59, Math.max(0, Number(match[2]))),
  } : {hour: fallbackHour, minute: 0};
}

function bangkokDate(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute));
}

function examScheduleTime(value: unknown) {
  const raw = normalizeThaiDigits(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || /^[-–—]+$/.test(raw)) return null;

  let day = 0;
  let month = 0;
  let year = 0;
  const namedDate = raw.match(/(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})/);
  const numericDate = raw.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
  if (namedDate) {
    day = Number(namedDate[1]);
    month = THAI_MONTHS[namedDate[2].replace(/[.\s]/g, '')] ?? 0;
    year = Number(namedDate[3]);
  } else if (numericDate) {
    day = Number(numericDate[1]);
    month = Number(numericDate[2]);
    year = Number(numericDate[3]);
  }
  if (year > 2400) year -= 543;
  if (year < 100) year += 2000;

  const timeRange = raw.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*(?:-|–|—|ถึง)\s*(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (!day || !month || !year || !timeRange) return null;
  const startHour = Number(timeRange[1]);
  const startMinute = Number(timeRange[2]);
  const endHour = Number(timeRange[3]);
  const endMinute = Number(timeRange[4]);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59
  ) return null;

  const startAt = bangkokDate(year, month, day, startHour, startMinute);
  const endAt = bangkokDate(year, month, day, endHour, endMinute);
  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    endAt.getTime() <= startAt.getTime()
  ) return null;

  const location = raw
    .slice((timeRange.index ?? 0) + timeRange[0].length)
    .replace(/^[\s,;:()-]+/, '')
    .trim()
    .slice(0, 120);
  return {endAt, location, raw, startAt};
}

function receiptOccurredAt(dateValue: unknown, timeValue: unknown) {
  const fallback = bangkokDateParts();
  let {day, month, year} = fallback;
  const date = text(dateValue);
  const yearFirst = date.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const dayFirst = date.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);

  if (yearFirst) {
    year = Number(yearFirst[1]);
    month = Number(yearFirst[2]);
    day = Number(yearFirst[3]);
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = Number(dayFirst[2]);
    year = Number(dayFirst[3]);
  }

  if (year > 2400) year -= 543;
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) ({day, month, year} = fallback);
  const {hour, minute} = parseTime(timeValue, 12);
  const parsed = bangkokDate(year, month, day, hour, minute);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function weekdayNumber(value: unknown, fallback: number) {
  const normalized = text(value).toLowerCase();
  return THAI_WEEKDAYS.find(([, labels]) => labels.some((label) => normalized.includes(label)))?.[0] ?? fallback;
}

function semesterDateParts(value: unknown, label: string) {
  const raw = text(value);
  const yearFirst = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const dayFirst = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!yearFirst && !dayFirst) throw new Error(`${label} \u0e15\u0e49\u0e2d\u0e07\u0e40\u0e1b\u0e47\u0e19\u0e23\u0e39\u0e1b\u0e41\u0e1a\u0e1a YYYY-MM-DD`);
  let year = Number(yearFirst?.[1] ?? dayFirst?.[3]);
  const month = Number(yearFirst?.[2] ?? dayFirst?.[2]);
  const day = Number(yearFirst?.[3] ?? dayFirst?.[1]);
  if (year > 2400) year -= 543;
  const parsed = bangkokDate(year, month, day, 12, 0);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) throw new Error(`${label} \u0e44\u0e21\u0e48\u0e16\u0e39\u0e01\u0e15\u0e49\u0e2d\u0e07`);
  return {day, month, year};
}

function weeklyScheduleTimes(entry: ScheduleEntry, index: number, semesterStart: {day: number; month: number; year: number}, semesterEnd: {day: number; month: number; year: number}) {
  const firstSemesterDay = bangkokDate(semesterStart.year, semesterStart.month, semesterStart.day, 12, 0);
  const finalSemesterDay = bangkokDate(semesterEnd.year, semesterEnd.month, semesterEnd.day, 23, 59);
  const targetWeekday = weekdayNumber(entry.day, -1);
  if (targetWeekday < 0) throw new Error(`\u0e23\u0e32\u0e22\u0e27\u0e34\u0e0a\u0e32\u0e17\u0e35\u0e48 ${index + 1} \u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e23\u0e30\u0e1a\u0e38\u0e27\u0e31\u0e19\u0e40\u0e23\u0e35\u0e22\u0e19`);
  const startTime = parseRequiredTime(entry.startTime, `เวลาเริ่มของ${scheduleCourseLabel(entry, index)}`);
  const endTime = parseRequiredTime(entry.endTime, `เวลาสิ้นสุดของ${scheduleCourseLabel(entry, index)}`);
  // Said out loud rather than corrected. Below, a backwards pair used to become
  // "start plus one hour" for every week of the term, so a misread timetable
  // filled the calendar with a duration nobody chose and nothing said so. The
  // review screen refuses the same pair on the card first; this is the backstop,
  // worded the same way and thrown before anything is written.
  const hoursProblem = timetableHoursProblem(clockText(startTime), clockText(endTime));
  if (hoursProblem) throw new Error(`${scheduleCourseLabel(entry, index)}: ${hoursProblem}`);
  const dayOffset = (targetWeekday - firstSemesterDay.getUTCDay() + 7) % 7;
  let cursor = bangkokDate(semesterStart.year, semesterStart.month, semesterStart.day + dayOffset, 12, 0);
  const occurrences: {endAt: Date; startAt: Date}[] = [];

  while (cursor.getTime() <= finalSemesterDay.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const startAt = bangkokDate(year, month, day, startTime.hour, startTime.minute);
    const endAt = bangkokDate(year, month, day, endTime.hour, endTime.minute);
    occurrences.push({endAt, startAt});
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return occurrences;
}

function scheduleEntries(draft: Record<string, unknown>) {
  return Array.isArray(draft.entries) ? draft.entries as ScheduleEntry[] : [];
}

/**
 * The folder scanned documents land in.
 *
 * Only the general-document path uses it, and deliberately so: a receipt scan
 * becomes a transaction and a timetable scan becomes calendar entries -- those
 * never produce a note to file. If either ever starts producing notes, this is
 * the place to reuse.
 */
const SCANNED_FOLDER_NAME = 'เอกสารสแกน';

/** Finds the scanned-documents folder, creating it the first time. */
async function scannedDocumentsFolderId(uid: string) {
  try {
    const existing = await noteFolders.list(uid);
    const match = existing.find((folder) => String(folder.name ?? '').trim() === SCANNED_FOLDER_NAME);
    if (match) return match.id;
    return await noteFolders.create(uid, {
      color: '#6F8F6D',
      icon: 'document_scanner',
      name: SCANNED_FOLDER_NAME,
      sortOrder: 0,
    });
  } catch (error) {
    // Filing is a convenience. A folder that cannot be read or created must
    // not cost the user the scanned note itself.
    console.warn('[SmartScan] Could not resolve the scanned-documents folder', error);
    return '';
  }
}

/** The first line with real words, used to title a scanned note. */
function firstMeaningfulLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 4 && /[\p{L}]/u.test(line)) ?? '';
}

export async function saveOcrResult({
  draft,
  result,
  uid,
}: {
  draft: Record<string, unknown>;
  result: OcrResult;
  uid: string;
}): Promise<SavedScan> {
  await ensureUserProfile();

  // A general document has no financial or timetable schema to fill, but it is
  // still worth keeping: it becomes a note holding the extracted text. Saving
  // it as a *transaction* is the failure this category was added to prevent --
  // saving it at all is not.
  if (result.scanType === 'document') {
    const scanned = documentNoteText(draft, result.parsed?.documentText, result.rawText);
    if (!scanned) throw new Error('ไม่พบข้อความในเอกสารนี้ จึงบันทึกเป็นโน้ตไม่ได้');
    const title = String(draft.title ?? '').trim() || firstMeaningfulLine(scanned) ||
      `สแกนเมื่อ ${new Date().toLocaleDateString('th-TH')}`;
    const folderId = await scannedDocumentsFolderId(uid);
    const id = await notes.create(uid, {
      category: 'study',
      color: '#6F8F6D',
      content: scanned.slice(0, 20000),
      folderId,
      priority: 'normal',
      relatedScheduleId: '',
      scanLogId: typeof result.logId === 'string' ? result.logId : '',
      status: 'pending',
      title: title.slice(0, 160),
    });
    return {destination: 'smartlife_planner_notes', documentIds: [id]};
  }

  if (result.scanType === 'receipt') {
    const amount = parseCurrencyAmount(firstAmountValue(draft));
    if (amount === null) throw new Error('\u0e01\u0e23\u0e38\u0e13\u0e32\u0e01\u0e23\u0e2d\u0e01\u0e22\u0e2d\u0e14\u0e40\u0e07\u0e34\u0e19\u0e40\u0e1b\u0e47\u0e19\u0e15\u0e31\u0e27\u0e40\u0e25\u0e02 \u0e40\u0e0a\u0e48\u0e19 90 \u0e2b\u0e23\u0e37\u0e2d 1,250.00');
    const rawConfidence = Number(draft.confidenceScore ?? result.classification.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Number(Math.min(1, Math.max(0, rawConfidence)).toFixed(2))
      : 0;

    const saved = await saveReviewedReceipt({
      amount,
      // Normalised so a scanned row lands in the same bucket as a manual one;
      // the parser emits English ("Food", "Others") and the app speaks Thai.
      category: normalizeExpenseCategory(text(draft.category)),
      confidence,
      items: receiptItemsForStorage(draft.items),
      merchant: text(draft.merchant) || text(draft.merchantName) || text(draft.store) || text(draft.vendor) || '\u0e44\u0e21\u0e48\u0e23\u0e30\u0e1a\u0e38\u0e23\u0e49\u0e32\u0e19\u0e04\u0e49\u0e32',
      occurredAt: receiptOccurredAt(draft.date, draft.time).toISOString(),
      reference: text(draft.reference),
      scanId: result.logId,
      storagePath: text(result.storagePath),
    });
    return {
      destination: 'smartlife_finance_month',
      documentIds: [saved.transactionId],
      duplicate: saved.duplicate,
    };
  }

  const entries = scheduleEntries(draft);
  if (!entries.length) throw new Error('\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e1e\u0e1a\u0e23\u0e32\u0e22\u0e27\u0e34\u0e0a\u0e32\u0e17\u0e35\u0e48\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01');
  const semesterStart = semesterDateParts(draft.semesterStart, '\u0e27\u0e31\u0e19\u0e40\u0e1b\u0e34\u0e14\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19');
  const semesterEnd = semesterDateParts(draft.semesterEnd, '\u0e27\u0e31\u0e19\u0e1b\u0e34\u0e14\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19');
  const startBoundary = bangkokDate(semesterStart.year, semesterStart.month, semesterStart.day, 0, 0);
  const endBoundary = bangkokDate(semesterEnd.year, semesterEnd.month, semesterEnd.day, 23, 59);
  const durationDays = Math.ceil((endBoundary.getTime() - startBoundary.getTime()) / (24 * 60 * 60 * 1000));
  if (durationDays < 0) throw new Error('\u0e27\u0e31\u0e19\u0e1b\u0e34\u0e14\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19\u0e15\u0e49\u0e2d\u0e07\u0e2d\u0e22\u0e39\u0e48\u0e2b\u0e25\u0e31\u0e07\u0e27\u0e31\u0e19\u0e40\u0e1b\u0e34\u0e14\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19');
  if (durationDays > 224) throw new Error('\u0e0a\u0e48\u0e27\u0e07\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19\u0e15\u0e49\u0e2d\u0e07\u0e44\u0e21\u0e48\u0e40\u0e01\u0e34\u0e19 32 \u0e2a\u0e31\u0e1b\u0e14\u0e32\u0e2b\u0e4c');

  const importBatchId = `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const scheduleItems = entries.flatMap((entry, index) => {
    const courseCode = text(entry.courseCode).replace(/\s+/g, '').toUpperCase();
    const courseName = text(entry.courseName).slice(0, 120);
    const location = [text(entry.buildingName ?? entry.room), text(entry.section) ? `Section ${text(entry.section)}` : ''].filter(Boolean).join(' - ');
    const seriesId = `${importBatchId}-${index}-${courseCode || 'course'}`.slice(0, 128);
    return weeklyScheduleTimes(entry, index, semesterStart, semesterEnd).map(({endAt, startAt}) => ({
      color: '#6F8F6D',
      courseCode,
      courseName,
      endAt: Timestamp.fromDate(endAt),
      location,
      seriesId,
      source: 'ocr' as const,
      startAt: Timestamp.fromDate(startAt),
      title: ([courseCode, courseName].filter(Boolean).join(' ') || `\u0e23\u0e32\u0e22\u0e27\u0e34\u0e0a\u0e32\u0e08\u0e32\u0e01 OCR ${index + 1}`).slice(0, 120),
    }));
  });
  const examItemsByKey = new Map<string, (typeof scheduleItems)[number]>();
  entries.forEach((entry, index) => {
    const courseCode = text(entry.courseCode).replace(/\s+/g, '').toUpperCase();
    const courseName = text(entry.courseName).slice(0, 120);
    const section = text(entry.section);
    const exams = [
      {label: 'สอบกลางภาค', type: 'midterm', value: entry.midtermExam},
      {label: 'สอบปลายภาค', type: 'final', value: entry.finalExam},
    ];
    exams.forEach((exam) => {
      const parsed = examScheduleTime(exam.value);
      if (!parsed) return;
      const title = `${exam.label} ${[courseCode, courseName].filter(Boolean).join(' ') || `รายวิชา ${index + 1}`}`.slice(0, 120);
      const location = [
        parsed.location,
        section ? `Section ${section}` : '',
      ].filter(Boolean).join(' - ');
      const key = `${exam.type}|${courseCode}|${parsed.startAt.toISOString()}`;
      if (examItemsByKey.has(key)) return;
      examItemsByKey.set(key, {
        color: '#C08282',
        courseCode,
        courseName,
        endAt: Timestamp.fromDate(parsed.endAt),
        location,
        seriesId: `${importBatchId}-exam-${exam.type}-${courseCode || index}`.slice(0, 128),
        source: 'ocr' as const,
        startAt: Timestamp.fromDate(parsed.startAt),
        title,
      });
    });
  });
  const allScheduleItems = [...scheduleItems, ...examItemsByKey.values()];
  if (!scheduleItems.length) throw new Error('\u0e44\u0e21\u0e48\u0e1e\u0e1a\u0e27\u0e31\u0e19\u0e40\u0e23\u0e35\u0e22\u0e19\u0e43\u0e19\u0e0a\u0e48\u0e27\u0e07\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19\u0e17\u0e35\u0e48\u0e40\u0e25\u0e37\u0e2d\u0e01');
  if (allScheduleItems.length > 500) throw new Error('\u0e08\u0e33\u0e19\u0e27\u0e19\u0e04\u0e25\u0e32\u0e2a\u0e40\u0e01\u0e34\u0e19 500 \u0e23\u0e32\u0e22\u0e01\u0e32\u0e23 \u0e01\u0e23\u0e38\u0e13\u0e32\u0e25\u0e14\u0e0a\u0e48\u0e27\u0e07\u0e20\u0e32\u0e04\u0e40\u0e23\u0e35\u0e22\u0e19');
  const documentIds = await schedules.createMany(uid, allScheduleItems);
  return {destination: 'smartlife_calendar_month', documentIds};
}
