// End-to-end check of saving a scanned timetable whose end times could not be
// read, against the Auth and Firestore emulators with the production rules.
//
// The calendar reader leaves an end time empty -- and flags it -- whenever it
// cannot confirm one from the image: a block cut off by the image edge, a model
// reading that is no printed hour, or no pixels and no model at all. Those
// entries are produced here by the real reader from the real fixtures, then
// put through the real `saveOcrResult`. They must be refused with a message
// that names the course and writes nothing, and must save in full -- every week
// of the term, at the times the user gave -- once the user supplies the end.
// A backwards pair typed by the user is held to the same standard.
import fs from 'node:fs';

import {collection, deleteDoc, doc, getDocs} from 'firebase/firestore';

import {__signIn, db} from '@/lib/firebase';
import {saveOcrResult} from '@/services/scan-save';
import {decodeScanImage} from '../functions/src/schedule-parsers/image-pixels.ts';
import {detectScheduleLayout} from '../functions/src/schedule-parsers/schedule-layout.ts';
import {crossCheckCalendarBlocks, parseCalendarBlocks} from '../functions/src/schedule-parsers/calendar-block-schedule.ts';

const EMAIL = 'timetable-save-test@smartlife.test';
const PASSWORD = 'timetable-save-test-password';
const SEMESTER = {semesterEnd: '2027-03-01', semesterStart: '2026-11-02'};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
};

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const DAY_EN = {จันทร์: 'MON', อังคาร: 'TUE', พุธ: 'WED', พฤหัสบดี: 'THU', ศุกร์: 'FRI', เสาร์: 'SAT', อาทิตย์: 'SUN'};
const PORTAL = [
  {code: '1101041', day: 'จันทร์', start: '09:00', end: '12:00', name: 'ภาษาอังกฤษเพื่อการนำเสนอทางธุรกิจ'},
  {code: '1101913', day: 'จันทร์', start: '16:00', end: '18:00', name: 'ผู้ประกอบการธุรกิจ'},
  {code: 'IST201506', day: 'พุธ', start: '15:00', end: '17:00', name: 'สุขภาพองค์รวม'},
  {code: '1101911', day: 'ศุกร์', start: '09:00', end: '12:00', name: 'โครงงานเทคโนโลยีดิจิทัล 1'},
];
const truthOf = (code) => PORTAL.find((t) => t.code === code);
const modelOf = (truth) => truth.map((t) => ({course_code: t.code, course_name: t.name, day: DAY_EN[t.day], end_time: t.end, start_time: t.start}));

// --- the three flagged cases, from the real reader on the real fixture ------
// Built exactly as test-schedule-calendar.mjs builds them.
const annotation = fixture('vision-cal-portal.json');
const png = fs.readFileSync(new URL('./fixtures/cal-portal.png', import.meta.url));
const pixels = decodeScanImage(`data:image/png;base64,${png.toString('base64')}`, annotation.pages[0].width, annotation.pages[0].height);
const geometry = parseCalendarBlocks(detectScheduleLayout(annotation, pixels), pixels);
const ocr = annotation.text;

const cut = crossCheckCalendarBlocks({
  ...geometry,
  entries: geometry.entries.map((e) => e.courseCode === '1101913' ? {...e, endTime: null} : e),
  evidence: geometry.evidence.map((facts, i) => geometry.entries[i].courseCode === '1101913' ? {...facts, cut: true, measuredEnd: false} : facts),
}, modelOf(PORTAL), ocr);
const blind = parseCalendarBlocks(detectScheduleLayout(annotation, null), null);
const unlabelled = crossCheckCalendarBlocks(blind, modelOf(PORTAL).map((c) => c.course_code === 'IST201506' ? {...c, end_time: '16:55'} : c), ocr);
const alone = crossCheckCalendarBlocks(blind, [], ocr);

const CASES = [
  ['block cut off by the image edge', cut.entries],
  ['model end time that is no printed hour', unlabelled.entries],
  ['no pixels and no model', alone.entries],
];

// --- helpers ----------------------------------------------------------------
const bangkokClock = (timestamp) => new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', hour12: false, minute: '2-digit', timeZone: 'Asia/Bangkok',
}).format(timestamp.toDate());
const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
// Bangkok has no DST, so +7h then the UTC weekday is the Bangkok weekday.
const bangkokWeekday = (timestamp) => THAI_DAYS[new Date(timestamp.toDate().getTime() + 7 * 36e5).getUTCDay()];

/** How many times a weekday falls inside the semester, counted independently of the save code. */
function weeksOf(dayThai) {
  const target = THAI_DAYS.indexOf(dayThai);
  let count = 0;
  const last = new Date(`${SEMESTER.semesterEnd}T12:00:00Z`).getTime();
  for (let d = new Date(`${SEMESTER.semesterStart}T12:00:00Z`); d.getTime() <= last; d = new Date(d.getTime() + 864e5)) {
    if (d.getUTCDay() === target) count += 1;
  }
  return count;
}

async function listSchedules(uid) {
  const snapshot = await getDocs(collection(db, 'users', uid, 'schedules'));
  return snapshot.docs.map((item) => ({id: item.id, ...item.data()}));
}
async function clearSchedules(uid) {
  for (const item of await listSchedules(uid)) await deleteDoc(doc(db, 'users', uid, 'schedules', item.id));
}
const toDraftEntries = (entries) => entries.map((e) => ({
  courseCode: e.courseCode ?? '', courseName: e.courseName ?? '', day: e.day ?? '',
  endTime: e.endTime ?? '', startTime: e.startTime ?? '',
}));
const save = (uid, entries) => saveOcrResult({
  draft: {...SEMESTER, entries},
  result: {logId: 'timetable-save-test', parsed: {}, rawText: '', scanType: 'schedule'},
  uid,
});

async function expectRefused(uid, entries, label, pattern) {
  const before = (await listSchedules(uid)).length;
  let message = '';
  try { await save(uid, entries); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  const after = (await listSchedules(uid)).length;
  check(`${label}: refused before writing`, Boolean(message) && after === before, `${after - before} written, "${message}"`);
  check(`${label}: the message names the course`, pattern.test(message), message);
}

// --- run --------------------------------------------------------------------
async function main() {
  const credential = await __signIn(EMAIL, PASSWORD);
  const uid = credential.user.uid;
  await clearSchedules(uid);

  for (const [name, parsed] of CASES) {
    const missing = parsed.filter((e) => !e.endTime);
    check(`${name}: the reader left the end time empty and flagged it`,
      missing.length > 0 && missing.every((e) => e.reviewFields.includes('endTime')),
      parsed.map((e) => `${e.courseCode} ${e.startTime}-${e.endTime ?? '?'}`).join('; '));

    // Saving as read: refused, naming the first course without an end time.
    const asRead = toDraftEntries(parsed);
    const firstMissing = asRead.findIndex((e) => !e.endTime);
    await expectRefused(uid, asRead, `${name}, saved as read`,
      new RegExp(`รายวิชาที่ ${firstMissing + 1} \\(${asRead[firstMissing].courseCode}\\)`));

    // The user supplies each missing end time (the one printed on the page).
    const supplied = asRead.map((e) => e.endTime ? e : {...e, endTime: truthOf(e.courseCode).end});
    const saved = await save(uid, supplied);
    const stored = await listSchedules(uid);
    check(`${name}, after the user supplies the end: saved`, saved.documentIds.length === stored.length && stored.length > 0,
      `${saved.documentIds.length} ids, ${stored.length} stored`);
    for (const entry of supplied) {
      const rows = stored.filter((row) => row.courseCode === entry.courseCode.toUpperCase());
      const expectedWeeks = weeksOf(entry.day);
      const timesRight = rows.every((row) => bangkokClock(row.startAt) === entry.startTime && bangkokClock(row.endAt) === entry.endTime);
      const dayRight = rows.every((row) => bangkokWeekday(row.startAt) === entry.day);
      check(`${name}: ${entry.courseCode} every week at ${entry.startTime}-${entry.endTime} on ${entry.day}`,
        rows.length === expectedWeeks && timesRight && dayRight,
        `${rows.length}/${expectedWeeks} weeks, first ${rows[0] ? `${bangkokWeekday(rows[0].startAt)} ${bangkokClock(rows[0].startAt)}-${bangkokClock(rows[0].endAt)}` : '-'}`);
    }
    await clearSchedules(uid);
  }

  // --- a backwards pair the user typed: refused by name, then saved once fixed
  const typed = PORTAL.map((t) => ({courseCode: t.code, courseName: t.name, day: t.day, endTime: t.end, startTime: t.start}));
  const backwards = typed.map((e) => e.courseCode === 'IST201506' ? {...e, endTime: '13:00'} : e);
  await expectRefused(uid, backwards, 'end typed before start',
    /รายวิชาที่ 3 \(IST201506\): เวลาสิ้นสุด 13:00 ต้องอยู่หลังเวลาเริ่ม 15:00/);
  const fixed = await save(uid, typed);
  const stored = await listSchedules(uid);
  const ist = stored.filter((row) => row.courseCode === 'IST201506');
  check('end typed before start, corrected: saved, nothing rewritten to "start plus one hour"',
    fixed.documentIds.length === stored.length && ist.length === weeksOf('พุธ') &&
    ist.every((row) => bangkokClock(row.startAt) === '15:00' && bangkokClock(row.endAt) === '17:00'),
    `${ist.length} weeks, ${ist[0] ? `${bangkokClock(ist[0].startAt)}-${bangkokClock(ist[0].endAt)}` : '-'}`);

  // Leave nothing behind for the next run, or for anyone reading the emulator.
  await clearSchedules(uid);
  check('test data cleaned up', (await listSchedules(uid)).length === 0);

  console.log(failures ? `\n${failures} timetable save check(s) FAILED` :
    '\ntimetable save passed: unreadable end times are refused by name and save in full once supplied');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
