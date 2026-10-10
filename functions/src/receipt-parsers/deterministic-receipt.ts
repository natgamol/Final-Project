export type ScanClassification = {
  confidence: number;
  scores: {receipt: number; schedule: number};
  /**
   * True only when the text contained an unmistakable anchor phrase such as
   * "ใบเสร็จรับเงิน" or "ตารางเรียน". Keyword scoring is reliable for those
   * and guesswork for everything else, so the caller uses this to decide
   * whether the verdict is worth a second opinion from a model.
   */
  certain: boolean;
  /**
   * `document` means "readable text, but not a financial or timetable
   * record". It exists because the previous two-way union had no way to say
   * no: `schedule > receipt` is false when both scores are zero, so a page
   * with no evidence at all -- meeting minutes, lecture notes, an exam
   * announcement -- was labelled a receipt and force-fitted into receipt
   * fields with fabricated zero-value line items.
   */
  type: "document" | "receipt" | "schedule";
};

type WeightedSignal = {pattern: RegExp; weight: number};

export type ReceiptLineItem = {
  discount: number | null;
  name: string;
  quantity: number | null;
  totalPrice: number;
  unitPrice: number | null;
};

const RECEIPT_SIGNALS: WeightedSignal[] = [
  {pattern: /(?:RECEIPT\s*\/\s*TAX\s*INVOICE|TAX\s*INVOICE|ใบเสร็จรับเงิน|ใบกำกับภาษี)/gi, weight: 10},
  // Payment-success slips may not use the word "receipt", but their wallet and
  // paid-amount labels are stronger evidence than incidental timetable text.
  // Bank transfer/bill-pay apps (K PLUS and similar) title the slip with the
  // specific action instead of a generic "ทำรายการสำเร็จ", so those headers
  // need their own anchor or the slip scores as plain, unclassified text.
  {pattern: /(?:ทำรายการสำเร็จ|จ่ายบิลสำเร็จ|โอนเงินสำเร็จ|โอนสำเร็จ|รับเงินสำเร็จ|เป๋าตัง|G\s*-?\s*WALLET|จำนวน(?:เงิน)?(?:ที่)?(?:ชำระ|จ่าย)|ยอด(?:เงิน)?ที่ชำระ)/gi, weight: 12},
  {pattern: /(?:GRAND\s*TOTAL|TOTAL\s*(?:INCL\.?\s*VAT|AMOUNT)?|ยอดรวม|ยอดสุทธิ|ยอดชำระ)/gi, weight: 5},
  {pattern: /(?:QR\s*PAYMENT|PROMPT\s*QR|PROMPTPAY|พร้อมเพย์)/gi, weight: 4},
  {pattern: /(?:TAX\s*ID|POS\s*ID|APPROVAL\s*CODE|TRC\s*NUM|BATCH\s*NO)/gi, weight: 3},
  {pattern: /(?:DESCRIPTION\s+QTY\s+PRICE\s+AMOUNT|ITEM\(S\)|QTY\(S\)|สินค้า|จำนวน|ราคา)/gi, weight: 4},
  {pattern: /(?:VATABLE|VAT\s*7|VAT\s*INCLUDED|THB|บาท|\u0e3f)/gi, weight: 2},
  {pattern: /(?:MERCHANT|PAYEE|ร้านค้า|ผู้รับเงิน|ชำระเงิน|รหัสอ้างอิง)/gi, weight: 3},
];

const SCHEDULE_SIGNALS: WeightedSignal[] = [
  {pattern: /(?:ตารางเรียน|ตารางสอบ|ตารางการเรียน|CLASS\s*SCHEDULE|STUDY\s*TIMETABLE|DAY\s*\/\s*TIME)/gi, weight: 9},
  // Academic-year wording is context, not structure: it heads fee notices,
  // calendars and announcements as often as timetables, so it only nudges.
  {pattern: /(?:ปีการศึกษา|ภาคการศึกษา)/gi, weight: 3},
  {pattern: /(?:รหัสวิชา|ชื่อรายวิชา|COURSE\s*CODE|COURSE\s*NAME|SECTION|ห้องเรียน)/gi, weight: 5},
  {pattern: /(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY)/gi, weight: 2},
  {pattern: /\b(?:[01]?\d|2[0-3])[:.]\d{2}\s*(?:-|–|—|ถึง)\s*(?:[01]?\d|2[0-3])[:.]\d{2}\b/g, weight: 2},
  {pattern: /(?:คาบ\s*\d+|PERIOD\s*\d+)/gi, weight: 3},
];

function matchCount(text: string, pattern: RegExp) {
  return Math.min(5, text.match(pattern)?.length ?? 0);
}

function weightedScore(text: string, signals: WeightedSignal[]) {
  return signals.reduce((total, signal) => total + matchCount(text, signal.pattern) * signal.weight, 0);
}

/**
 * How much weighted evidence a document needs before it may be called a
 * receipt or a schedule at all.
 *
 * Calibrated against real documents: a genuine receipt scores in the high
 * tens (37 for a shop receipt with a tax-invoice header) and a real timetable
 * higher still (52), while incidental matches in ordinary prose -- a couple of
 * weekday names, a time range -- top out around 4. Anything under this bar has
 * not shown it is a structured document, so it stays plain text.
 */
const MIN_STRUCTURED_EVIDENCE = 10;

/**
 * Weekday tokens a timetable uses, keyed by day so repeats do not inflate the
 * count: full Thai names, the dotted abbreviations grid headers use (จ. อ. พ.
 * พฤ. ศ. ส. อา.), and English names or their three-letter forms.
 *
 * The Thai abbreviations are bounded on both sides by a non-Thai character,
 * which is what keeps "พ.ศ.", "ส.ค.", "อ.เมือง" and "จ.เชียงใหม่" from reading
 * as days. The English short forms must be capitalised, so ordinary prose
 * ("sat down", "sun") does not count.
 */
const WEEKDAY_TOKENS: RegExp[] = [
  /จันทร์|(?<![ก-๙.])จ\.(?![ก-๙])|\b(?:[Mm]onday|MONDAY|MON|Mon)\b/,
  /อังคาร|(?<![ก-๙.])อ\.(?![ก-๙])|\b(?:[Tt]uesday|TUESDAY|TUES?|Tues?)\b/,
  /พุธ|(?<![ก-๙.])พ\.(?![ก-๙])|\b(?:[Ww]ednesday|WEDNESDAY|WED|Wed)\b/,
  /พฤหัสบดี|พฤหัส|(?<![ก-๙.])พฤ\.(?![ก-๙])|\b(?:[Tt]hursday|THURSDAY|THUR?S?|Thur?s?)\b/,
  /ศุกร์|(?<![ก-๙.])ศ\.(?![ก-๙])|\b(?:[Ff]riday|FRIDAY|FRI|Fri)\b/,
  /เสาร์|(?<![ก-๙.])ส\.(?![ก-๙])|\b(?:[Ss]aturday|SATURDAY|SAT)\b/,
  /อาทิตย์|(?<![ก-๙.])อา\.(?![ก-๙])|\b(?:[Ss]unday|SUNDAY|SUN)\b/,
];
const TIMETABLE_ANCHOR = /ตารางเรียน|ตารางสอบ|ตารางการเรียน|CLASS\s*SCHEDULE|STUDY\s*TIMETABLE|EXAM\s*SCHEDULE|DAY\s*\/\s*TIME/i;
const TIME_RANGE = /\b(?:[01]?\d|2[0-3])[:.]\d{2}\s*(?:-|–|—|ถึง)\s*(?:[01]?\d|2[0-3])[:.]\d{2}\b/;
const ALNUM_COURSE_CODE = /\b[A-Z]{2,5}\s?\d{3}(?:\s?-\s?\d{2})?\b/g;
const NUMERIC_COURSE_CODE = /\b\d{6,7}(?:\s*-\s*\d{1,2})?\b/g;

function weekdaysOn(line: string) {
  return WEEKDAY_TOKENS.flatMap((pattern, day) => (pattern.test(line) ? [day] : []));
}

export type ScheduleStructure = {
  /** Distinct weekdays anywhere in the text. */
  dayCount: number;
  courseCodes: number;
  /** Lines that pair a weekday with a time range or a course code. */
  slotLines: number;
  /** Enough structure to call it a timetable without a second opinion. */
  proven: boolean;
};

/**
 * What only a timetable has: weekdays paired with time slots or course codes,
 * line after line.
 *
 * Vocabulary is not enough in either direction. A real grid often has no
 * "ตารางเรียน" header and abbreviates its days, so counting phrases called it a
 * plain document; while "ปีการศึกษา" -- which sat in the old list of
 * unmistakable anchors -- heads fee notices and academic calendars too, and
 * those were being called schedules with certainty, never checked by the
 * model.
 */
export function scheduleStructure(text: string): ScheduleStructure {
  const lines = text.split(/\r?\n/);
  const days = new Set<number>();
  let slotLines = 0;
  for (const line of lines) {
    const onLine = weekdaysOn(line);
    onLine.forEach((day) => days.add(day));
    if (onLine.length && (TIME_RANGE.test(line) || /\b[A-Z]{2,5}\s?\d{3}\b|\b\d{6,7}\b/.test(line))) slotLines += 1;
  }
  const anchor = TIMETABLE_ANCHOR.test(text);
  // A bare six- or seven-digit number is as likely a tax, POS or account
  // number as a course, so those only count beside some weekly structure.
  const numeric = anchor || days.size >= 2 ? text.match(NUMERIC_COURSE_CODE)?.length ?? 0 : 0;
  const courseCodes = (text.match(ALNUM_COURSE_CODE)?.length ?? 0) + numeric;
  const dayCount = days.size;
  // Without a timetable heading it takes several day-and-slot lines, and
  // either course codes or a third such line -- two lines of opening hours
  // ("จันทร์-ศุกร์ 08:00-17:00 / เสาร์ 09:00-12:00") must not be proof.
  const proven = (anchor && (dayCount >= 2 || courseCodes >= 2 || slotLines >= 1)) ||
    (dayCount >= 3 && slotLines >= 2 && (courseCodes >= 2 || slotLines >= 3));
  return {courseCodes, dayCount, proven, slotLines};
}

const STATEMENT_ROW_DATE = /^\s*(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s*(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{2,4}|\d{1,2}\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s*\d{2,4})/i;
const MONEY_AMOUNT = /\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}/g;
const STATEMENT_VOCABULARY = [
  /สมุดบัญชี|บัญชีเงินฝาก/,
  /รายการเดินบัญชี|STATEMENT/i,
  /PASSBOOK/i,
  /คงเหลือ|BALANCE/i,
  /ยอดยกมา|B\/F|BROUGHT\s+FORWARD/i,
  /ถอน|WITHDRAW/i,
  /ฝาก|DEPOSIT/i,
];

const STATEMENT_DATES = [
  /(?<!\d)\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}(?!\d)/g,
  /(?<!\d)\d{1,2}\s*(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{2,4}(?!\d)/g,
  /(?<!\d)\d{1,2}\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s*\d{2,4}(?!\d)/gi,
];

/**
 * True for a passbook page or account statement: many distinct dates and
 * amounts, in bank-statement vocabulary.
 *
 * A receipt is one transaction with one total, and everything downstream --
 * the extractor, the model review, the save -- assumes that. A passbook is a
 * list of them, so it came back with the bank's name as the merchant, the
 * final balance as the total, and the rows as line items. The model
 * classifier made it worse rather than better: its definition of a receipt
 * was any record of a financial transaction, and a passbook is dozens.
 *
 * Deliberately indifferent to layout. Real table OCR puts every cell on its
 * own line -- "01/08/69", "ยอดยกมา", "12,450.00" -- so the first version,
 * which wanted a date and an amount on the same line, never fired on an
 * actual scan. And the counts are of *distinct* values because the receipt
 * path stores up to three transcripts of the same image: a receipt printing
 * one date carries it three times, and must not look like three rows.
 * A row-per-line running-balance column still counts where OCR keeps rows.
 */
export function detectAccountStatement(text: string) {
  const dates = new Set(STATEMENT_DATES.flatMap((pattern) => text.match(pattern) ?? [])
    .map((date) => date.replace(/\s+/g, "").toUpperCase()));
  const amounts = new Set(text.match(MONEY_AMOUNT) ?? []);
  const vocabulary = STATEMENT_VOCABULARY.filter((pattern) => pattern.test(text)).length;
  let balanceRows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (STATEMENT_ROW_DATE.test(line) && (line.match(MONEY_AMOUNT)?.length ?? 0) >= 2) balanceRows += 1;
  }
  return dates.size >= 3 && amounts.size >= 3 && (vocabulary >= 2 || balanceRows >= 3);
}

export function classifyScanText(rawText: string): ScanClassification {
  const text = rawText.replace(/\u00a0/g, " ");
  let receipt = weightedScore(text, RECEIPT_SIGNALS);
  let schedule = weightedScore(text, SCHEDULE_SIGNALS);
  // Settled before anything else: a statement carries amounts, dates and
  // bank vocabulary, so every signal below would argue it is a receipt, and
  // it is decided with certainty so the model -- which agrees with them --
  // is not asked.
  if (detectAccountStatement(text)) {
    return {certain: true, confidence: 0.95, scores: {receipt, schedule}, type: "document"};
  }
  // Bank-app status headers ("โอนเงินสำเร็จ" and friends) are deliberately not
  // here. They score through RECEIPT_SIGNALS, which is enough to claim the
  // slip as a receipt, but an anchor in this list also makes the claim
  // `certain` and skips the Gemini review -- and a transfer slip is exactly
  // the document that review exists for.
  const hardReceipt = matchCount(text, /(?:RECEIPT\s*\/\s*TAX\s*INVOICE|TAX\s*INVOICE|ใบเสร็จรับเงิน|ใบกำกับภาษี|ทำรายการสำเร็จ|เป๋าตัง|G\s*-?\s*WALLET|จำนวน(?:เงิน)?(?:ที่)?(?:ชำระ|จ่าย)|ยอด(?:เงิน)?ที่ชำระ)/gi);
  const structure = scheduleStructure(text);
  // Financial documents can contain dates, times, and long numeric IDs. Two
  // receipt anchors are enough to distinguish them from timetable evidence.
  const receiptAnchors = matchCount(
    text,
    /(?:RECEIPT(?:\s*\/\s*TAX\s*INVOICE)?|TAX\s*ID|POS\s*ID|QR\s*PAYMENT|PROMPT\s*QR|APPROVAL\s*CODE|VAT(?:ABLE|\s*7|\s*INCLUDED)|GRAND\s*TOTAL|TOTAL\s*(?:INCL\.?\s*VAT|AMOUNT)?|\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35|\u0e0a\u0e33\u0e23\u0e30\u0e40\u0e07\u0e34\u0e19\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08|\u0e08\u0e33\u0e19\u0e27\u0e19(?:\u0e40\u0e07\u0e34\u0e19)?(?:\u0e17\u0e35\u0e48)?(?:\u0e0a\u0e33\u0e23\u0e30|\u0e08\u0e48\u0e32\u0e22))/gi,
  );
  // Course codes count only beside weekly structure; on their own they are
  // indistinguishable from tax, POS and account numbers.
  if (structure.proven || structure.slotLines > 0) schedule += Math.min(4, structure.courseCodes) * 2;

  // A category has to earn its claim, either through an unmistakable anchor
  // phrase or through enough accumulated evidence. Without this gate the
  // comparison below always picks a structured type, however little evidence
  // there is.
  const receiptClaimed = hardReceipt > 0 || receiptAnchors >= 2 || receipt >= MIN_STRUCTURED_EVIDENCE;
  const scheduleClaimed = structure.proven || structure.slotLines >= 2 ||
    (structure.dayCount >= 3 && structure.courseCodes >= 2);

  if (!receiptClaimed && !scheduleClaimed) {
    // Neither shape fits. Confidence here is confidence that this is *not* a
    // receipt or a schedule, so it falls as the losing evidence approaches the
    // bar rather than being pinned at a floor.
    const strongest = Math.max(receipt, schedule);
    const confidence = 0.55 + 0.44 * (1 - Math.min(1, strongest / MIN_STRUCTURED_EVIDENCE));
    return {
      certain: false,
      confidence: Number(confidence.toFixed(2)),
      scores: {receipt, schedule},
      type: "document",
    };
  }

  let type: ScanClassification["type"] = schedule > receipt ? "schedule" : "receipt";
  if (!scheduleClaimed) type = "receipt";
  if (!receiptClaimed) type = "schedule";
  if (receiptClaimed && hardReceipt > 0 && !structure.proven) type = "receipt";
  if (receiptClaimed && receiptAnchors >= 2 && !structure.proven) type = "receipt";
  if (structure.proven && hardReceipt === 0) type = "schedule";

  const winner = type === "receipt" ? receipt : schedule;
  const loser = type === "receipt" ? schedule : receipt;
  // Confidence blends the margin over the other category with how much
  // absolute evidence was found. Margin alone reported 0.99 for a document
  // scoring 4 against 0, which read as near-certainty on almost no evidence.
  const margin = (winner - loser) / Math.max(1, winner + loser);
  const strength = Math.min(1, winner / (MIN_STRUCTURED_EVIDENCE * 2));
  const confidence = Math.min(0.99, Math.max(0.55, 0.55 + margin * strength * 0.44));
  return {
    certain: type === "receipt" ? hardReceipt > 0 : structure.proven,
    confidence: Number(confidence.toFixed(2)),
    scores: {receipt, schedule},
    type,
  };
}

function cleanText(text: string) {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
}

function amountsOnLine(line: string) {
  return [...line.matchAll(/(?:THB|\u0e3f)?\s*([0-9][0-9,]*\.\d{2})(?!\d)/gi)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
}

function moneyValuesOnLine(line: string) {
  return [...line.matchAll(/(?:THB|\u0e3f)?\s*(-?\d[\d,]*(?:\.\d{1,2})?)\s*(?:THB|\u0e1a\u0e32\u0e17|\u0e3f)?/gi)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
}

function normalizedAmount(value: string | undefined) {
  if (!value) return null;
  const amount = Number(value.replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? Number(amount.toFixed(2)) : null;
}

const NON_PRODUCT_TEXT = /(?:\b(?:TOTAL|SUBTOTAL|NET|VAT|VATABLE|QR\s*PAYMENT|PROMPT\s*QR|TRUE\s*MONEY|TRUEMONEY|PAYMENT|APPROVAL|TAX|POS\s*ID|TRC\s*NUM|BATCH\s*NO|HOST\s*NUM|OPERATOR|CASHIER|CHANGE|DISCOUNT|BRANCH|TEL\.?|RECEIPT|INVOICE|QUESTIONNAIRE|SURVEY|DOWNLOAD|EXCHANGE|REFUND|CASH|CREDIT\s*CARD|DEBIT\s*CARD)\b|ITEM\s*\(\s*S\s*\)|QTY\s*\(\s*S\s*\)|\u0e22\u0e2d\u0e14\u0e23\u0e27\u0e21|\u0e22\u0e2d\u0e14\u0e2a\u0e38\u0e17\u0e18\u0e34|\u0e22\u0e2d\u0e14\u0e0a\u0e33\u0e23\u0e30|\u0e08\u0e33\u0e19\u0e27\u0e19\u0e40\u0e07\u0e34\u0e19\u0e17\u0e35\u0e48\u0e0a\u0e33\u0e23\u0e30|\u0e17\u0e23\u0e39\u0e21\u0e31\u0e19\u0e19\u0e35\u0e48|\u0e27\u0e34\u0e18\u0e35\u0e01\u0e32\u0e23\u0e0a\u0e33\u0e23\u0e30|\u0e0a\u0e33\u0e23\u0e30\u0e14\u0e49\u0e27\u0e22|\u0e40\u0e07\u0e34\u0e19\u0e2a\u0e14|\u0e1a\u0e31\u0e15\u0e23\u0e40\u0e04\u0e23\u0e14\u0e34\u0e15|\u0e2a\u0e48\u0e27\u0e19\u0e25\u0e14|\u0e40\u0e07\u0e34\u0e19\u0e17\u0e2d\u0e19|\u0e41\u0e1a\u0e1a\u0e2a\u0e2d\u0e1a\u0e16\u0e32\u0e21|\u0e23\u0e48\u0e27\u0e21\u0e15\u0e2d\u0e1a|\u0e14\u0e32\u0e27\u0e19\u0e4c\u0e42\u0e2b\u0e25\u0e14|\u0e43\u0e1a\u0e01\u0e33\u0e01\u0e31\u0e1a\u0e20\u0e32\u0e29\u0e35|\u0e40\u0e1b\u0e25\u0e35\u0e48\u0e22\u0e19\s*\/\s*\u0e04\u0e37\u0e19)/i;
const QUANTITY_BREAKDOWN_ONLY = /^(?:\d{5,14}\s+)?\d+(?:\.\d+)?\s+\d[\d,]*(?:\.\d{1,4})?\s*\/?\s*(?:PCS?|EA|UNIT|\u0e0a\u0e34\u0e49\u0e19)\s*$/i;
const RECEIPT_FOOTER_TEXT = /(?:^\s*\*|\u0e40\u0e07\u0e37\u0e48\u0e2d\u0e19\u0e44\u0e02|\u0e44\u0e21\u0e48\u0e23\u0e31\u0e1a\u0e40\u0e1b\u0e25\u0e35\u0e48\u0e22\u0e19|\u0e40\u0e1b\u0e25\u0e35\u0e48\u0e22\u0e19(?:\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32)?\u0e04\u0e37\u0e19|\u0e02\u0e2d\u0e1a\u0e04\u0e38\u0e13|\u0e01\u0e23\u0e38\u0e13\u0e32|\u0e17\u0e38\u0e01\u0e27\u0e31\u0e19|\u0e25\u0e38\u0e49\u0e19\u0e0a\u0e34\u0e07\u0e42\u0e0a\u0e04|\u0e0a\u0e34\u0e07\u0e42\u0e0a\u0e04|EXCHANGE\s+(?:ARE|IS)|RETURN\s+POLICY|THANK\s+YOU)/i;
const RECEIPT_ITEM_HEADER = /^(?:#?\s*(?:\u0e22\u0e01\u0e40\u0e27\u0e49\u0e19|\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32|\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32\u0e21\u0e35\u0e20\u0e32\u0e29\u0e35|\u0e23\u0e32\u0e04\u0e32\u0e23\u0e27\u0e21\u0e20\u0e32\u0e29\u0e35(?:\u0e21\u0e39\u0e25\u0e04\u0e48\u0e32\u0e40\u0e1e\u0e34\u0e48\u0e21)?\u0e41\u0e25\u0e49\u0e27|\u0e20\.?\u0e1e\.?|EXEMPT|DESCRIPTION|QTY|PRICE|AMOUNT|ITEMS?))\s*$/i;
const RECEIPT_ITEM_END = /^(?:(?:ยอดสุทธิ|ยอดรวม|ยอดชำระ|จำนวนเงินที่ชำระ)(?:\s|[:：])|(?:GRAND\s*TOTAL|TOTAL(?:\s*INCL\.?\s*VAT)?|QR\s*PAYMENT|NET)\b)/i;

function cleanPurchasedItemName(value: string) {
  return value
    .replace(/\b\d{8,14}\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ML|MEB|L|G|KG|PCS?)\b/gi, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:\u0e21\u0e25\.?|\u0e01\.?|\u0e01\u0e01\.?|\u0e0a\u0e34\u0e49\u0e19)\b/gi, " ")
    .replace(/\s*[\[({]?\s*[xX@]\s*\d+(?:\.\d+)?\s*[\])}]?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedItemName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("th-TH")
    .replace(/^(?:\u0e25\u0e14|\u0e2a\u0e48\u0e27\u0e19\u0e25\u0e14|disc(?:ount)?|promo(?:tion)?)\s*/i, "")
    .replace(/[^a-z0-9\u0e00-\u0e7f]+/gi, "")
    .trim();
}

function bigramScore(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  const pairs = (value: string) => {
    const result: string[] = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      result.push(value.slice(index, index + 2));
    }
    return result;
  };
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  if (!leftPairs.length || !rightPairs.length) return 0;
  const remaining = [...rightPairs];
  let matches = 0;
  for (const pair of leftPairs) {
    const matchIndex = remaining.indexOf(pair);
    if (matchIndex < 0) continue;
    matches += 1;
    remaining.splice(matchIndex, 1);
  }
  return (2 * matches) / (leftPairs.length + rightPairs.length);
}

function isPurchasedProductName(value: string) {
  const name = value.replace(/\s+/g, " ").trim();
  return Boolean(
    name &&
    /[A-Za-z\u0e00-\u0e7f]{2,}/u.test(name) &&
    !NON_PRODUCT_TEXT.test(name) &&
    !RECEIPT_ITEM_HEADER.test(name) &&
    !QUANTITY_BREAKDOWN_ONLY.test(name) &&
    !/^(?:(?:\u0e25\u0e14|\u0e2a\u0e48\u0e27\u0e19\u0e25\u0e14)\s*|(?:disc(?:ount)?|promo(?:tion)?)\b)/i.test(name),
  );
}

function receiptItems(lines: string[]): ReceiptLineItem[] {
  const items: ReceiptLineItem[] = [];
  const startIndex = lines.findIndex((line) =>
    /(?:DESCRIPTION\s+QTY\s+PRICE\s+AMOUNT|RECEIPT\s*\/\s*TAX\s*INVOICE|TAX\s*INVOICE)/i.test(line),
  );
  const candidates = lines.slice(startIndex >= 0 ? startIndex + 1 : 0);
  let pending: ReceiptLineItem | null = null;
  const metadata = NON_PRODUCT_TEXT;
  const codeOnly = /^(?:[A-Z0-9_-]{4,}\s*(?:[-/]\s*\d+\/\d+)?)$/i;
  let ignoreDiscountBreakdown = false;
  let footerStarted = false;

  const flushPending = () => {
    if (!pending) return;
    pending.name = cleanPurchasedItemName(pending.name).slice(0, 180);
    if (pending.quantity === null) pending.quantity = 1;
    if (
      pending.totalPrice <= 0 &&
      pending.quantity !== null &&
      pending.unitPrice !== null
    ) {
      pending.totalPrice = Number((pending.quantity * pending.unitPrice).toFixed(2));
    }
    if (isPurchasedProductName(pending.name) && pending.totalPrice > 0) items.push(pending);
    pending = null;
  };

  const applyDiscount = (rawName: string, rawDiscount: string) => {
    const discount = Math.abs(Number(rawDiscount.replace(/,/g, "")));
    if (!Number.isFinite(discount) || discount <= 0) return;
    const target = normalizedItemName(rawName);
    const candidates = [...items, ...(pending ? [pending] : [])];
    let best: ReceiptLineItem | null = null;
    let bestScore = 0;
    for (const item of candidates) {
      const score = bigramScore(target, normalizedItemName(item.name));
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    if (!best || bestScore < 0.34) return;
    best.discount = Number(((best.discount ?? 0) + discount).toFixed(2));
    best.totalPrice = Number(Math.max(0, best.totalPrice - discount).toFixed(2));
    if (best.quantity !== null && best.quantity > 0) {
      best.unitPrice = Number((best.totalPrice / best.quantity).toFixed(2));
    }
  };

  for (const rawLine of candidates) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (footerStarted) continue;
    // Policy, survey, and thank-you text appears after the purchase section.
    // It is never a product, even when OCR associates a nearby total with it.
    if (RECEIPT_FOOTER_TEXT.test(line)) {
      footerStarted = true;
      continue;
    }
    // A printed total closes the product section. Never parse totals or a
    // following payment method (for example TrueMoney) as products.
    if (RECEIPT_ITEM_END.test(line)) {
      flushPending();
      footerStarted = true;
      continue;
    }
    if (QUANTITY_BREAKDOWN_ONLY.test(line)) continue;
    const discountLine = line.match(
      /^(?:\u0e25\u0e14|\u0e2a\u0e48\u0e27\u0e19\u0e25\u0e14|disc(?:ount)?|promo(?:tion)?)\s+(.+?)\s+-\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:THB|\u0e3f|\u0e1a\u0e32\u0e17)?$/i,
    );
    if (discountLine) {
      applyDiscount(discountLine[1], discountLine[2]);
      ignoreDiscountBreakdown = true;
      continue;
    }

    const quantityRow = line.match(
      /^(?:\d{5,14}\s+)?(\d+(?:\.\d+)?)\s*[Xx@]\s*(\d[\d,]*\.\d{2})(?:\s*(?:\/\s*PCS)?)?(?:\s+(\d[\d,]*\.\d{2}))?$/i,
    );
    if (ignoreDiscountBreakdown && quantityRow) {
      ignoreDiscountBreakdown = false;
      continue;
    }
    // A printed quantity breakdown belongs to a discount only when it is the
    // immediately following line. Do not suppress later real products.
    ignoreDiscountBreakdown = false;

    if (metadata.test(line)) continue;
    if (/^(?:\u0e25\u0e14|DISC(?:OUNT)?)\b/i.test(line) || /-\s*\d[\d,]*\.\d{2}\s*$/.test(line)) {
      ignoreDiscountBreakdown = true;
      continue;
    }

    if (quantityRow) {
      const quantity = normalizedAmount(quantityRow[1]);
      const unitPrice = normalizedAmount(quantityRow[2]);
      const explicitTotal = normalizedAmount(quantityRow[3]);
      if (!pending && items.length && explicitTotal === null) {
        const previous = items[items.length - 1];
        previous.quantity = quantity;
        previous.unitPrice = unitPrice;
        continue;
      }
      if (pending && quantity !== null && unitPrice !== null) {
        pending.quantity = quantity;
        pending.unitPrice = unitPrice;
        pending.totalPrice = explicitTotal ?? Number((quantity * unitPrice).toFixed(2));
      }
      continue;
    }

    const quantityOnly = line.match(/^(\d+(?:\.\d+)?)\s*[Xx@]\s*$/);
    if (quantityOnly && pending) {
      pending.quantity = normalizedAmount(quantityOnly[1]);
      continue;
    }

    // Some Thai tax invoices print a product name, a barcode, then one dense
    // quantity/price row (for example "1.0 ... @x48.00 ... 48.00"). Keep the
    // preceding product name instead of replacing it with that technical row.
    const pendingPriceValues = amountsOnLine(line);
    const pendingQuantity = line.match(/^(\d+(?:\.\d+)?)\s+/)?.[1];
    if (
      pending &&
      pendingQuantity &&
      pendingPriceValues.length &&
      /(?:@|[xX]|\/\s*(?:PCS?|EA|UNIT))/i.test(line)
    ) {
      const quantity = normalizedAmount(pendingQuantity);
      const totalPrice = pendingPriceValues.at(-1) ?? null;
      const unitPrice = pendingPriceValues.length > 1
        ? pendingPriceValues.at(-2) ?? totalPrice
        : totalPrice;
      if (quantity !== null && totalPrice !== null && totalPrice > 0) {
        pending.quantity = quantity;
        pending.unitPrice = unitPrice;
        pending.totalPrice = totalPrice;
        continue;
      }
    }

    // Vision commonly returns a product name and its amount as two separate
    // lines. Bind the amount-only row to the closest pending product name.
    const amountOnly = line.match(/^(?:THB|\u0e3f)?\s*(\d[\d,]*\.\d{2})\s*$/i);
    if (amountOnly) {
      const amount = normalizedAmount(amountOnly[1]);
      if (pending && amount !== null && amount > 0) {
        if (pending.quantity !== null && pending.unitPrice === null) {
          pending.unitPrice = amount;
        } else if (pending.totalPrice <= 0) {
          pending.totalPrice = amount;
        }
      }
      continue;
    }

    const directItem = line.match(/^(?:(\d+(?:\.\d+)?)\s+)?(.+?)\s+(-?\d[\d,]*\.\d{2})\s*$/);
    if (directItem) {
      const parsedQuantity = normalizedAmount(directItem[1]);
      const quantity = parsedQuantity !== null && parsedQuantity > 0 ? parsedQuantity : 1;
      const name = directItem[2].trim();
      const totalPrice = normalizedAmount(directItem[3]);
      if (
        totalPrice !== null && totalPrice > 0 &&
        /[A-Za-z\u0e00-\u0e7f]{2,}/.test(name) &&
        isPurchasedProductName(name) && !codeOnly.test(name)
      ) {
        flushPending();
        pending = {
          discount: null,
          name,
          quantity,
          totalPrice,
          unitPrice: Number((totalPrice / quantity).toFixed(2)),
        };
      }
      continue;
    }

    if (
      isPurchasedProductName(line) && !codeOnly.test(line) &&
      !/^\d[\d\s.,:/-]+$/.test(line)
    ) {
      flushPending();
      pending = {
        discount: null,
        name: line.slice(0, 180),
        quantity: null,
        totalPrice: 0,
        unitPrice: null,
      };
    }
  }

  flushPending();
  return items.slice(0, 200);
}

function receiptTotal(lines: string[]) {
  const footerIndex = lines.findIndex((line) => RECEIPT_FOOTER_TEXT.test(line));
  const contentLines = footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
  // A bank transfer/bill-pay slip (K PLUS and similar apps) labels the paid
  // amount with the bare word "จำนวน:" on its own line, not "จำนวนเงินที่ชำระ".
  // That line has to be anchored to nothing else on it, or this would also
  // fire on an itemised receipt's "รายการ จำนวน ราคา" column header and steal
  // the quantity column as the total.
  const paidLabel = /(?:จำนวนเงินที่ชำระ|ยอดสุทธิ|ยอดชำระ|^จำนวน\s*[:：]\s*$)/i;
  // A payment confirmation is authoritative. OCR can misread decorative
  // characters next to Total (for example "(4)********54.00").
  const paymentLabel = /QR\s*PAYMENT/i;
  const totalLabel = /(?:\bTOTAL\s*INCL\.?\s*VAT\b|\bTOTAL\b|\bNET\b|ยอดรวม)/i;
  const excluded = /(?:SUBTOTAL|VATABLE|VAT\s*7|CHANGE|DISCOUNT|ค่าสินค้า|สิทธิ|ส่วนลด|เงินทอน)/i;

  for (const label of [paidLabel, paymentLabel, totalLabel]) {
    for (const [index, line] of contentLines.entries()) {
      // A final paid-amount label remains authoritative even when OCR merged
      // it with the preceding discount line (for example, "-24 บาท ... 16 บาท").
      if (!label.test(line) || (label !== paidLabel && excluded.test(line))) continue;
      const direct = moneyValuesOnLine(line).at(-1);
      if (direct !== undefined) return direct;

      const following = contentLines.slice(index + 1, index + (label === paidLabel ? 4 : 8));
      const amountWithCurrency = following
        .filter((nearby) => /(?:THB|\u0e3f|\u0e1a\u0e32\u0e17)/i.test(nearby) && !excluded.test(nearby))
        .flatMap((nearby) => moneyValuesOnLine(nearby))
        .at(0);
      if (amountWithCurrency !== undefined) return amountWithCurrency;

      const amountOnly = following
        .filter((nearby) => !excluded.test(nearby) && /^\s*(?:THB|\u0e3f)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:THB|\u0e1a\u0e32\u0e17|\u0e3f)?\s*$/i.test(nearby))
        .flatMap((nearby) => moneyValuesOnLine(nearby))
        .at(0);
      if (amountOnly !== undefined) return amountOnly;
    }
  }

  // Never guess from the last/largest currency number. Without an approved
  // anchor the correct result is unknown and must remain empty for review.
  return null;
}

export function extractAnchoredReceiptTotal(rawText: string) {
  const text = cleanText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return receiptTotal(lines);
}

function knownMerchant(lines: string[], text: string) {
  const findLine = (pattern: RegExp) => lines.find((line) => pattern.test(line));
  const mrDiy = findLine(/\bMR\.?\s*D\.?\s*I\.?\s*Y\.?\b/i);
  if (mrDiy) return mrDiy.replace(/\s+/g, " ").trim();
  const bigC = findLine(/\bBIG\s*C\b/i);
  if (bigC) return bigC.replace(/\s+/g, " ").trim();
  if (/\bBCM\b/i.test(text)) return "Big C Market";

  const brands = /(?:McDonald'?s|KFC|Starbucks|Cafe Amazon|7[ -]?Eleven|Lotus'?s?|Makro|Tops|Foodland|CJ Express|PTT|Bangchak|Shell|Grab|Shopee|Lazada|Uniqlo)/i;
  const brandLine = findLine(brands);
  if (brandLine) return brandLine.replace(/\s+/g, " ").trim();

  const thaiShop = lines.find((line) => /^ร้าน(?!ค้า\s*$)[^:：]{2,100}$/u.test(line.trim()));
  if (thaiShop) return thaiShop.replace(/\s+/g, " ").trim();

  // K PLUS labels an informal-market vendor's wallet as "ถุงเงิน (shop name)"
  // instead of naming the shop directly. The wallet label itself is not the
  // payee, so unwrap it rather than let the fallback below use "ถุงเงิน".
  const thungNgern = lines.find((line) => /^ถุงเงิน\s*\(.+\)\s*$/u.test(line.trim()));
  if (thungNgern) {
    return thungNgern.trim().replace(/^ถุงเงิน\s*\(/u, "").replace(/\)\s*$/, "").replace(/\s+/g, " ").trim();
  }

  const labeledMerchant = text.match(/(?:ผู้รับเงิน|ร้านค้า|ชำระให้|ไปยัง)\s*[:：-]?\s*([^\n]{2,100})/iu)?.[1]?.trim();
  if (labeledMerchant && /[A-Za-z\u0e00-\u0e7f]{2,}/u.test(labeledMerchant)) {
    return labeledMerchant.replace(/\s+/g, " ");
  }

  // Bank-app status headers ("bill payment successful", "transfer successful")
  // describe the app action, not a party in the transaction, so the fallback
  // below must not mistake one for the payee name.
  const ignored = /(?:RECEIPT|INVOICE|TAX|VAT|POS\s*ID|DESCRIPTION|QTY|PRICE|AMOUNT|TOTAL|PAYMENT|APPROVAL|BRANCH|TEL\.?|ITEM|CASHIER|CHANGE|DISCOUNT|ทำรายการสำเร็จ|จ่ายบิลสำเร็จ|โอนเงินสำเร็จ|โอนสำเร็จ|รับเงินสำเร็จ|ชำระเงินสำเร็จ|รหัสอ้างอิง|จำนวนเงิน|ค่าสินค้า|สิทธิ|วันที่|เวลา)/i;
  return lines.slice(0, 18).find((line) =>
    /[A-Za-z\u0e00-\u0e7f]{2,}/u.test(line) &&
    !ignored.test(line) &&
    !/^\d[\d\s.,:/-]+$/.test(line) &&
    !/[!@#$%^&*()_+={}\[\]<>?]{3,}/.test(line),
  ) ?? null;
}

function receiptCategory(text: string, merchant = "") {
  if (/(?:BIG\s*C|\bBCM\b|7[ -]?ELEVEN|LOTUS|MAKRO|TOPS|FOODLAND|CJ\s*EXPRESS|MAXVALU|SUPERMARKET|CONVENIENCE)/i.test(text)) return "Groceries";
  if (/(?:MCDONALD|KFC|STARBUCKS|CAFE|COFFEE|RESTAURANT|PIZZA|BURGER|SUSHI|FOOD\s*COURT|ร้านอาหาร|กาแฟ|ข้าว|ก๋วยเตี๋ยว)/i.test(text)) return "Food";
  if (/(?:MR\.?\s*D\.?\s*I\.?\s*Y|SHOPEE|LAZADA|UNIQLO|ADVICE|ELECTRONIC|DEPARTMENT\s*STORE)/i.test(text)) return "Shopping";
  // A payment footer (e.g. TrueMoney) is not evidence that the purchase was a utility bill.
  if (/\b(?:PEA|MEA|ELECTRIC|WATER\s*BILL|INTERNET|AIS|TRUE|DTAC|UTILITY)\b/i.test(merchant) || /ค่าไฟ|ค่าน้ำ|\b(?:ELECTRIC|WATER)\s*BILL\b/i.test(text)) return "Utilities";
  if (/(?:PTT|BANGCHAK|SHELL|ESSO|GRAB|BOLT|BTS|MRT|TOLL|PARKING|FUEL)/i.test(text)) return "Transport";
  if (/(?:NETFLIX|SPOTIFY|STEAM|CINEMA|MAJOR\s*CINEPLEX|GAME|เติมเกม|บัตรเกม)/i.test(text)) return "Entertainment";
  return "Others";
}

function receiptDate(text: string) {
  const match = [...text.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/g)].at(-1);
  const thaiMonthMatch = text.match(/\b(\d{1,2})\s*(ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?)\s*(\d{2}|\d{4})\b/u);
  if (!match && !thaiMonthMatch) return null;
  const thaiMonths: Record<string, number> = {
    "มค": 1, "กพ": 2, "มีค": 3, "เมย": 4, "พค": 5, "มิย": 6,
    "กค": 7, "สค": 8, "กย": 9, "ตค": 10, "พย": 11, "ธค": 12,
  };
  const day = Number(match?.[1] ?? thaiMonthMatch?.[1]);
  const month = match
    ? Number(match[2])
    : thaiMonths[String(thaiMonthMatch?.[2] ?? "").replace(/\./g, "")];
  const yearText = String(match?.[3] ?? thaiMonthMatch?.[3] ?? "");
  let year = Number(yearText);
  if (yearText.length === 2) year = year <= 39 ? 2000 + year : 1957 + year;
  if (year > 2400) year -= 543;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function receiptTime(text: string) {
  // Receipt totals frequently contain decimals such as "3.14" (VAT). A
  // colon is the normal printed time separator, so it must win over decimal
  // numbers. Accept a dot only when OCR also read a time label beside it.
  const colonTime = [...text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].at(-1);
  if (colonTime) return `${colonTime[1].padStart(2, "0")}:${colonTime[2]}`;

  const labelledDotTime = [...text.matchAll(
    /(?:\u0e40\u0e27\u0e25\u0e32|TIME)\D{0,12}([01]?\d|2[0-3])\.([0-5]\d)\b/gi,
  )].at(-1);
  return labelledDotTime
    ? `${labelledDotTime[1].padStart(2, "0")}:${labelledDotTime[2]}`
    : null;
}

export type ReceiptTimestampEvidence = {
  calendarEra: "AD" | "BE" | "UNKNOWN";
  confidence: number;
  date: string | null;
  evidence: string | null;
  printedYear: number | null;
  time: string | null;
};

export function extractReceiptTimestampEvidence(
  rawText: string,
): ReceiptTimestampEvidence {
  const text = cleanText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const contextPattern = /(?:ทำรายการสำเร็จ|รหัสอ้างอิง|เลขที่รายการ|ชำระ|ธุรกรรม|วันที่|เวลา|TRANSACTION|REFERENCE|PAYMENT|DATE|TIME)/iu;
  const candidates = lines.flatMap((line, index) => {
    const date = receiptDate(line);
    let time = receiptTime(line);
    let evidence = line;
    if (date && !time) {
      const adjacent = [lines[index - 1], lines[index + 1]].filter(Boolean);
      const timeLine = adjacent.find((value) => receiptTime(value));
      if (timeLine) {
        time = receiptTime(timeLine);
        evidence = `${line} ${timeLine}`;
      }
    }
    const context = lines.slice(Math.max(0, index - 2), index + 2).join(" ");
    const anchored = contextPattern.test(context);
    if (!date && (!time || !anchored)) return [];
    const score = Number(Boolean(date)) * 6 +
      Number(Boolean(time)) * 3 +
      Number(Boolean(date && time)) * 5 +
      Number(anchored) * 4;
    return [{anchored, date, evidence, index, score, time}];
  }).sort((first, second) => second.score - first.score || second.index - first.index);

  const best = candidates[0];
  if (!best) {
    return {
      calendarEra: "UNKNOWN",
      confidence: 0,
      date: null,
      evidence: null,
      printedYear: null,
      time: null,
    };
  }

  const fourDigitYear = best.evidence.match(/\b((?:19|20|24|25|26)\d{2})\b/)?.[1];
  const shortYear = best.evidence.match(
    /\b\d{1,2}\s*[\/-]\s*\d{1,2}\s*[\/-]\s*(\d{2})\b/,
  )?.[1];
  const printedYear = fourDigitYear ? Number(fourDigitYear) :
    shortYear ? Number(shortYear) : null;
  const explicitBe = /(?:พ\.?\s*ศ\.?|B\.?E\.?)/iu.test(best.evidence);
  const explicitAd = /(?:ค\.?\s*ศ\.?|A\.?D\.?|C\.?E\.?)/iu.test(best.evidence);
  const calendarEra = explicitBe || (printedYear !== null && printedYear >= 2400) ?
    "BE" :
    explicitAd || (printedYear !== null && printedYear >= 1900) ? "AD" : "UNKNOWN";

  return {
    calendarEra,
    confidence: best.date && best.time ? (best.anchored ? 0.99 : 0.96) : 0.9,
    date: best.date,
    evidence: best.evidence.replace(/\s+/g, " ").trim().slice(0, 240),
    printedYear,
    time: best.time,
  };
}

function receiptReference(text: string) {
  return text.match(/\bR\d{8,}[A-Z0-9]*\b/i)?.[0] ??
    text.match(/(?:TRC\s*NUM|REFERENCE|TRANSACTION\s*ID|รหัสอ้างอิง)\s*[:#-]?\s*([A-Z0-9-]{5,})/i)?.[1] ??
    text.match(/(?:APPROVAL\s*CODE)\s*[:#-]?\s*([A-Z0-9-]{5,})/i)?.[1] ??
    null;
}

export function parseReceiptDeterministic(rawText: string) {
  const text = cleanText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const items = receiptItems(lines);
  const merchant = knownMerchant(lines, text);
  const detectedTotal = receiptTotal(lines);
  // Copy only an explicitly anchored amount. Never manufacture a grand total
  // by summing or multiplying product rows.
  const total = detectedTotal;
  const timestamp = extractReceiptTimestampEvidence(text);
  const date = timestamp.date;
  const time = timestamp.time;
  const reference = receiptReference(text);
  const category = receiptCategory(`${merchant ?? ""}\n${text}`, merchant ?? "");
  const populated = [merchant, total, date, time].filter((value) => value !== null).length;
  return {
    category,
    confidenceScore: Number(Math.min(0.97, 0.48 + populated * 0.12).toFixed(2)),
    currency: "THB",
    date,
    items,
    merchant,
    merchantName: merchant,
    parserSource: "deterministic-receipt-v5",
    reference,
    timestampCalendarEra: timestamp.calendarEra,
    timestampConfidence: timestamp.confidence,
    timestampEvidence: timestamp.evidence,
    timestampPrintedYear: timestamp.printedYear,
    timestampSource: "deterministic-ocr",
    time,
    total,
    totalAmount: total,
  };
}
