import {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import Animated, {useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming} from 'react-native-reanimated';
import {LinearGradient} from 'expo-linear-gradient';
import NativeDateTimePicker from '@/components/date-time-picker';
import ScheduleConflictDialog from '@/components/schedule-conflict-dialog';
import ConfirmDialog from '@/components/confirm-dialog';

import {runLegacyDataAction} from '@/services/legacy-data';
import {findScheduleConflicts, type ScheduleConflict} from '@/services/firestore';
import {exceedsAvailableFunds, monthFundsFor} from '@/services/transaction-funds';
import {INCOME_SOURCES} from '@/config/income-sources';
import {futureSuggestion} from '@/lib/ux-time';
import {getActivitySuggestions, recommendationLevel, type ActivitySuggestion} from '@/services/smartlife-recommendations';
import {shiftDateKey, thailandDateKey, thailandTimeKey, thailandWallClockToDate} from '@/lib/thailand-time';
import {showToast, toastMessage} from '@/components/app-toast';
import {Card, MaterialIcon, PrimaryButton, UserHeader, UserShell, type UserNavigate, userStyles} from './user-ui';

type FormPage = 'smartlife_add_activity' | 'smartlife_add_task' | 'smartlife_add_appointment' | 'smartlife_add_income' | 'smartlife_add_expense' | 'smartlife_save_activity' | 'smartlife_save_task' | 'smartlife_save_appointment';
type ActivityKind = 'activity' | 'task' | 'appointment';
type FormMode = 'manual' | 'ai';
type EntryMode = 'event' | 'reminder';
type TransactionKind = 'income' | 'expense';
type PriorityValue = 'normal' | 'important' | 'urgent';
/** What the funds check needs to explain itself, held while the user decides. */
type FundsWarning = {amount: number; available: number; income: number; payload: Record<string, unknown>; spent: number};

function baht(value: number) { return `฿${Math.round(Math.abs(value)).toLocaleString('th-TH')}`; }

const colors = ['#5f875f', '#9297bb', '#d06d62', '#d9a844', '#6c9db6', '#ad7cae'];
const activityTypes: {icon: string; label: string; value: ActivityKind}[] = [
  {icon: 'calendar_month', label: 'คลาสเรียน', value: 'activity'},
  {icon: 'check_box', label: 'งาน', value: 'task'},
  {icon: 'location_on', label: 'นัดหมาย', value: 'appointment'},
];
const activityCopy: Record<ActivityKind, {details: string; due: string; location: string; reminder: string; save: string; title: string}> = {
  activity: {details: 'โน้ต', due: 'วันที่', location: 'สถานที่', reminder: 'แจ้งเตือน', save: 'บันทึกกิจกรรม', title: 'เพิ่มกิจกรรม'},
  task: {details: 'รายละเอียดงาน', due: 'กำหนดส่ง', location: 'วิชา / หมวดหมู่', reminder: 'ความสำคัญ', save: 'บันทึกงาน', title: 'เพิ่มงาน'},
  appointment: {details: 'โน้ตนัดหมาย', due: 'วันที่', location: 'สถานที่นัด', reminder: 'ผู้เกี่ยวข้อง', save: 'บันทึกนัดหมาย', title: 'เพิ่มนัดหมาย'},
};
const priorityOptions = [
  {description: 'รายการทั่วไป', icon: 'radio_button_checked', label: 'ทั่วไป', value: 'normal'},
  {description: 'ควรจัดไว้ก่อน', icon: 'priority_high', label: 'สำคัญ', value: 'important'},
  {description: 'ต้องทำก่อนรายการอื่น', icon: 'warning', label: 'เร่งด่วน', value: 'urgent'},
] as const;
const reminderOptions = [
  {icon: 'notifications_off', label: 'ไม่เตือน', value: ''},
  {icon: 'notifications_active', label: 'ตรงเวลา', value: 'ตรงเวลา'},
  {icon: 'timer', label: '10 นาทีก่อน', value: '10 นาทีก่อน'},
  {icon: 'schedule', label: '30 นาทีก่อน', value: '30 นาทีก่อน'},
  {icon: 'hourglass_top', label: '1 ชั่วโมงก่อน', value: '1 ชั่วโมงก่อน'},
  {icon: 'event_upcoming', label: '1 วันก่อน', value: '1 วันก่อน'},
] as const;
const durationOptions = [30, 60, 90, 120] as const;
// One-tap shortcuts for the two values that previously always cost three taps
// (open picker, choose, confirm). They are additive: the picker rows above them
// still open the full picker for anything these do not cover.
const dateShortcuts = [{days: 0, label: 'วันนี้'}, {days: 1, label: 'พรุ่งนี้'}, {days: 7, label: '+7 วัน'}] as const;
const timeShortcuts = ['08:00', '12:00', '17:00', '20:00'] as const;
const recurrenceOptions = ['ไม่ทำซ้ำ', 'ทุกวัน', 'ทุกสัปดาห์', 'ทุกเดือน'] as const;

function config(page: FormPage) {
  if (page.includes('income')) return {action: 'create-transaction', title: 'เพิ่มรายการการเงิน', type: 'income', target: 'smartlife_finance_day'};
  if (page.includes('expense')) return {action: 'create-transaction', title: 'เพิ่มรายการการเงิน', type: 'expense', target: 'smartlife_finance_day'};
  if (page.includes('task')) return {action: 'create-activity', title: 'เพิ่มงาน', type: 'task' as ActivityKind, target: 'smartlife_calendar_day'};
  if (page.includes('appointment')) return {action: 'create-activity', title: 'เพิ่มนัดหมาย', type: 'appointment' as ActivityKind, target: 'smartlife_calendar_day'};
  return {action: 'create-activity', title: 'เพิ่มกิจกรรม', type: 'activity' as ActivityKind, target: 'smartlife_calendar_day'};
}

function padTimePart(value: number) { return String(value).padStart(2, '0'); }
// `date` and `time` are Bangkok wall clock, matching what every screen renders
// with `timeZone: 'Asia/Bangkok'`. They only become an instant in `save`.
function dateValue() { return thailandDateKey(); }
function timeValue() { return thailandTimeKey(); }

/**
 * `parseDateText`/`parseTimeText` and `formatDateText`/`formatTimeText` shuttle
 * the two strings in and out of the platform picker, which shows and reports a
 * `Date` using the device's own clock. They are deliberately device-local and
 * exactly symmetric: the picker is only editing digits, so whatever zone it
 * renders in cancels out on the way back. The zone that matters is applied once,
 * in `save`, by `thailandWallClockToDate`.
 */
function parseDateText(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseTimeText(value: string) {
  const [hourText, minuteText] = value.split(':');
  const date = new Date();
  date.setHours(Number(hourText) || 0, Number(minuteText) || 0, 0, 0);
  return date;
}

function formatDateText(value: Date) {
  return `${value.getFullYear()}-${padTimePart(value.getMonth() + 1)}-${padTimePart(value.getDate())}`;
}

function formatTimeText(value: Date) {
  return `${padTimePart(value.getHours())}:${padTimePart(value.getMinutes())}`;
}

function thaiDateText(value: string) {
  return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeZone: 'Asia/Bangkok'}).format(new Date(`${value}T12:00:00+07:00`));
}

function SaveButton({disabled, label, onPress, saving}: {disabled: boolean; label: string; onPress: () => void; saving: boolean}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({transform: [{scale: scale.value}]}));
  const hasSavedOnce = useRef(false);
  const handlePress = () => {
    if (disabled) return;
    // Spring-pop to give tactile "confirmed" feedback (~180ms settle)
    scale.value = withSequence(
      withSpring(1.04, {damping: 5, stiffness: 320}),
      withSpring(1, {damping: 10, stiffness: 180}),
    );
    hasSavedOnce.current = true;
    onPress();
  };
  return (
    <Animated.View style={[styles.saveShell, disabled && styles.disabled, animStyle]}>
      <Touchable disabled={disabled} onPress={handlePress} style={styles.saveShell}>
        <LinearGradient colors={['#6f966f', '#476d43']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.save}>
          {saving ? <ActivityIndicator color="#fff" /> : <MaterialIcon color="#fff" name="check" size={19} />}
          <Text style={styles.saveText}>{label}</Text>
        </LinearGradient>
      </Touchable>
    </Animated.View>
  );
}

export default function ActivityFormScreen({page, uid, onNavigate}: {page: FormPage; uid: string; onNavigate: UserNavigate}) {
  const form = useMemo(() => config(page), [page]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(form.type === 'income' ? '\u0e40\u0e07\u0e34\u0e19\u0e42\u0e2d\u0e19' : form.type === 'expense' ? 'อาหาร' : '');
  const [transactionType, setTransactionType] = useState<TransactionKind>(form.type === 'income' ? 'income' : 'expense');
  const [activityType, setActivityType] = useState<ActivityKind>(form.type === 'income' || form.type === 'expense' ? 'activity' : form.type as ActivityKind);
  const [entryMode, setEntryMode] = useState<EntryMode>('event');
  const [formMode, setFormMode] = useState<FormMode>('manual');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState(dateValue);
  const [time, setTime] = useState(timeValue);
  const [pickerTarget, setPickerTarget] = useState<'date' | 'time' | null>(null);
  const [reminder, setReminder] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [recurrence, setRecurrence] = useState<(typeof recurrenceOptions)[number]>('ไม่ทำซ้ำ');
  const [note, setNote] = useState('');
  const [attendees, setAttendees] = useState('');
  const [priority, setPriority] = useState<PriorityValue>('normal');
  const [color, setColor] = useState(colors[0]);
  const [usedAiSuggestion, setUsedAiSuggestion] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<ActivitySuggestion[]>([]);
  const [loadingAiSuggestions, setLoadingAiSuggestions] = useState(false);
  const [pendingConflictSave, setPendingConflictSave] = useState<{conflicts: ScheduleConflict[]; endAt: string; payload: Record<string, unknown>; startAt: string} | null>(null);
  const [saving, setSaving] = useState(false);
  const [fundsWarning, setFundsWarning] = useState<FundsWarning | null>(null);
  const isTransaction = form.action === 'create-transaction';
  const copy = activityCopy[isTransaction ? 'activity' : activityType];

  useEffect(() => {
    if (isTransaction || formMode !== 'ai') return undefined;
    let active = true;
    getActivitySuggestions(uid)
      .then((items) => {
        if (active) setAiSuggestions(items);
      })
      .catch((error) => {
        console.error('[ActivityForm] Load AI suggestions failed', error);
        if (active) setAiSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingAiSuggestions(false);
      });
    return () => {
      active = false;
    };
  }, [formMode, isTransaction, uid]);

  const commitPayload = async (payload: Record<string, unknown>) => {
    if (usedAiSuggestion && !isTransaction && Date.parse(String(payload.startAt)) <= Date.now()) {
      setPendingConflictSave(null);
      return showToast('คำแนะนำหมดอายุระหว่างยืนยัน', 'เลือกเวลาเริ่มใหม่ก่อนบันทึกกิจกรรม');
    }
    setSaving(true);
    try {
      await runLegacyDataAction(uid, `user/${page}`, {action: form.action, payload});
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', toastMessage(error, 'ลองใหม่อีกครั้ง'));
      setSaving(false);
      return;
    }
    setSaving(false);
    setPendingConflictSave(null);
    // A toast rather than `Alert.alert`: the alert cost a tap to dismiss on
    // native and did nothing at all on web, so the same save reported itself
    // two different ways. This one appears on both and clears itself while the
    // screen behind it is already showing the saved item.
    showToast(
      'บันทึกสำเร็จ',
      isTransaction
        ? `เพิ่ม${transactionType === 'income' ? 'รายรับ' : 'รายจ่าย'} ${Number(amount.replace(/,/g, '').trim()).toLocaleString('th-TH')} บาทเรียบร้อยแล้ว`
        : `เพิ่ม${copy.title.replace('เพิ่ม', '')}ลงตารางเวลาแล้ว`,
      'success',
    );
    onNavigate(form.target);
  };

  const save = async () => {
    if (!title.trim()) return showToast('กรอกชื่อรายการก่อนบันทึก');
    const parsedAmount = Number(amount.replace(/,/g, '').trim());
    if (isTransaction && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      return showToast('กรอกจำนวนเงินให้ถูกต้อง');
    }
    // `transactionType` defaults to 'expense' for every form that is not the
    // income one, tasks and activities included, and those forms have no
    // category field to fill in -- so without the isTransaction guard this
    // rejected every activity, task and appointment the user tried to save.
    if (isTransaction && transactionType === 'expense' && !category.trim()) {
      return showToast('เลือกหรือกรอกหมวดรายจ่ายก่อนบันทึก');
    }
    const startDate = thailandWallClockToDate(date, time);
    if (usedAiSuggestion && !isTransaction && startDate.getTime() <= Date.now()) return showToast('เวลาเริ่มผ่านไปแล้ว', 'เลือกเวลาใหม่ก่อนบันทึก');
    if (Number.isNaN(startDate.getTime())) return showToast('ตรวจสอบวันที่และเวลาอีกครั้ง');
    const payload: Record<string, unknown> = isTransaction
      ? {type: transactionType, amount: parsedAmount, merchant: title.trim(), category, note, occurredAt: startDate.toISOString()}
      : {
           title,
          type: entryMode === 'reminder' ? 'task' : activityType,
          location,
          color,
          note: recurrence === 'ไม่ทำซ้ำ' ? note : `${note}${note.trim() ? '\n\n' : ''}ทำซ้ำ: ${recurrence}`,
          reminder: entryMode === 'reminder' && !reminder ? 'ตรงเวลา' : reminder,
          category: entryMode === 'reminder' ? 'reminder' : category,
          priority,
          attendees,
          startAt: startDate.toISOString(),
          endAt: new Date(startDate.getTime() + durationMinutes * 60 * 1000).toISOString(),
        };
    if (!isTransaction) {
      const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
      setSaving(true);
      try {
        const conflicts = await findScheduleConflicts(uid, startDate, endDate);
        if (conflicts.length) {
          setPendingConflictSave({conflicts, endAt: endDate.toISOString(), payload, startAt: startDate.toISOString()});
          setSaving(false);
          return;
        }
      } catch (error) {
        showToast('ตรวจสอบตารางไม่สำเร็จ', toastMessage(error));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    // An expense bigger than the money actually taken in this month is worth a
    // second look before it lands. The reported case was a mistyped ฿700,000
    // against ฿100,500 of income, which no budget alert could catch because no
    // budget had been set at all. The notification feed now carries the same
    // check after the fact; this one is here so the typo can be fixed while the
    // form is still open, rather than found on a later visit to the bell.
    if (isTransaction && transactionType === 'expense') {
      setSaving(true);
      try {
        const funds = await monthFundsFor(uid, startDate);
        setSaving(false);
        if (exceedsAvailableFunds(parsedAmount, funds)) {
          setFundsWarning({amount: parsedAmount, available: funds.available, income: funds.income, payload, spent: funds.spent});
          return;
        }
      } catch {
        // A lookup that fails must not block a save the user asked for. The
        // feed still raises the alert once the transaction is written.
        setSaving(false);
      }
    }
    await commitPayload(payload);
  };

  const useSuggestion = (suggestion: ActivitySuggestion) => {
    if (!futureSuggestion(suggestion)) return showToast('คำแนะนำหมดอายุ', 'เปิด AI แนะนำอีกครั้งเพื่อหาช่วงใหม่');
    setUsedAiSuggestion(true);
    const startAt = new Date(suggestion.startAt);
    setEntryMode('event');
    setActivityType(suggestion.type);
    setTitle(suggestion.title);
    setLocation(suggestion.location);
    setDate(thailandDateKey(startAt));
    setTime(thailandTimeKey(startAt));
    setPriority(suggestion.priority === 'urgent' ? 'urgent' : suggestion.priority === 'high' || suggestion.priority === 'important' ? 'important' : 'normal');
    setDurationMinutes(Math.max(30, Math.round((new Date(suggestion.endAt).getTime() - startAt.getTime()) / 60000)) || 60);
    setNote(`${suggestion.note}\n\nเหตุผลที่ AI เลือก: ${suggestion.reasons.join(', ')}`);
    setFormMode('manual');
  };
  const selectFormDateTime = (selectedDate?: Date | null) => {
    if (!selectedDate || !pickerTarget) return;
    if (pickerTarget === 'date') setDate(formatDateText(selectedDate));
    else setTime(formatTimeText(selectedDate));
    setPickerTarget(null);
  };

  if (isTransaction && transactionType === 'income') return <IncomeForm amount={amount} category={category} date={date} note={note} onBack={() => onNavigate('smartlife_finance_day')} onNavigate={onNavigate} onSave={save} saving={saving} setAmount={setAmount} setCategory={setCategory} setDate={setDate} setNote={setNote} setTime={setTime} setTitle={setTitle} time={time} title={title} />;
  if (isTransaction) return <>
    <ExpenseForm amount={amount} category={category} date={date} note={note} onBack={() => onNavigate('smartlife_finance_day')} onNavigate={onNavigate} onSave={save} saving={saving} setAmount={setAmount} setCategory={setCategory} setDate={setDate} setNote={setNote} setTime={setTime} setTitle={setTitle} time={time} title={title} />
    <ConfirmDialog
      cancelLabel="กลับไปแก้"
      confirmLabel="บันทึกต่อ"
      icon="account_balance_wallet"
      message={fundsWarning ? `เดือนนี้รับเข้ามา ${baht(fundsWarning.income)} ใช้ไปแล้ว ${baht(fundsWarning.spent)} ${fundsWarning.available > 0 ? `เหลือใช้ได้ ${baht(fundsWarning.available)}` : 'ไม่เหลือให้ใช้แล้ว'} แต่รายการนี้ ${baht(fundsWarning.amount)} ตรวจจำนวนเงินอีกครั้งก่อนบันทึกไหม?` : undefined}
      onCancel={() => setFundsWarning(null)}
      onConfirm={() => { const pending = fundsWarning; setFundsWarning(null); if (pending) void commitPayload(pending.payload); }}
      title="รายจ่ายเกินเงินที่มี"
      visible={Boolean(fundsWarning)}
    />
  </>;

  if (false && isTransaction) return <UserShell active="smartlife_finance_day" onNavigate={onNavigate}>
    <UserHeader onNavigate={onNavigate} subtitle="บันทึกข้อมูลลง Firebase" title={form.title} />
    <Card><View style={userStyles.segmented}>{(['expense', 'income'] as TransactionKind[]).map((type) => <Touchable key={type} onPress={() => setTransactionType(type)} style={[userStyles.segment, transactionType === type && userStyles.segmentActive]}><Text style={[userStyles.segmentText, transactionType === type && userStyles.segmentTextActive]}>{type === 'expense' ? 'รายจ่าย' : 'รายรับ'}</Text></Touchable>)}</View>
      <Text style={userStyles.label}>ชื่อร้านหรือแหล่งเงิน</Text><TextInput onChangeText={setTitle} placeholder="พิมพ์ชื่อรายการ" placeholderTextColor="#a0a79e" style={userStyles.field} value={title} />
      <Text style={userStyles.label}>จำนวนเงิน</Text><TextInput keyboardType="numeric" onChangeText={setAmount} placeholder="0" placeholderTextColor="#a0a79e" style={userStyles.field} value={amount} />
      <Text style={userStyles.label}>หมวดหมู่</Text><TextInput onChangeText={setCategory} placeholderTextColor="#a0a79e" style={userStyles.field} value={category} />
      <Text style={userStyles.label}>วันที่</Text><TextInput onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor="#a0a79e" style={userStyles.field} value={date} />
      <Text style={userStyles.label}>เวลา</Text><TextInput onChangeText={setTime} placeholder="HH:MM" placeholderTextColor="#a0a79e" style={userStyles.field} value={time} /><PrimaryButton disabled={saving} label={saving ? 'กำลังบันทึก...' : 'บันทึกรายการ'} onPress={save} />
    </Card>
  </UserShell>;

  return <UserShell active="smartlife_planner" onNavigate={onNavigate}>
    <View style={styles.modernPage}>
      <View style={styles.modernHeader}>
        <Touchable accessibilityLabel="ปิด" onPress={() => onNavigate('smartlife_planner')} style={styles.roundButton}><MaterialIcon color="#354133" name="close" size={24} /></Touchable>
        <View style={styles.modernHeaderCopy}><Text style={styles.eyebrow}>SMARTLIFE PLANNER</Text><Text style={styles.modernTitle}>{formMode === 'ai' ? 'AI แนะนำ' : 'รายการใหม่'}</Text></View>
        <Touchable accessibilityLabel="บันทึก" disabled={saving || !title.trim()} onPress={save} style={[styles.doneButton, (saving || !title.trim()) && styles.doneButtonDisabled]}>{saving ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={24} />}</Touchable>
      </View>

      <View style={styles.entryToggle}>
        <Touchable onPress={() => { setEntryMode('event'); setFormMode('manual'); }} style={[styles.entryMode, entryMode === 'event' && formMode === 'manual' && styles.entryModeActive]}><MaterialIcon color={entryMode === 'event' && formMode === 'manual' ? '#fff' : '#718071'} name="calendar_month" size={17} /><Text style={[styles.entryModeText, entryMode === 'event' && formMode === 'manual' && styles.entryModeTextActive]}>กิจกรรม</Text></Touchable>
        <Touchable onPress={() => { setEntryMode('reminder'); setFormMode('manual'); setReminder((value) => value || 'ตรงเวลา'); }} style={[styles.entryMode, entryMode === 'reminder' && formMode === 'manual' && styles.entryModeActive]}><MaterialIcon color={entryMode === 'reminder' && formMode === 'manual' ? '#fff' : '#718071'} name="notifications_active" size={17} /><Text style={[styles.entryModeText, entryMode === 'reminder' && formMode === 'manual' && styles.entryModeTextActive]}>เตือนความจำ</Text></Touchable>
      </View>

      <Touchable onPress={() => { setLoadingAiSuggestions(true); setFormMode((value) => value === 'ai' ? 'manual' : 'ai'); }} style={styles.aiModeButton}>
        <View style={styles.aiModeIcon}><MaterialIcon color="#5f875f" name="auto_awesome" size={18} /></View><View style={{flex: 1}}><Text style={styles.aiModeTitle}>AI ช่วยแนะนำช่วงเวลาที่เหมาะ</Text><Text style={styles.aiModeText}>ตรวจช่วงว่าง งาน และตารางเรียนก่อนเพิ่ม</Text></View><MaterialIcon color="#658064" name={formMode === 'ai' ? 'expand_less' : 'chevron_right'} size={20} />
      </Touchable>

      {formMode === 'ai' ? <AiSuggestions loading={loadingAiSuggestions} onUse={useSuggestion} suggestions={aiSuggestions} /> : <>
        {entryMode === 'event' ? <View style={styles.typeRow}>{activityTypes.map((item) => <Touchable key={item.value} onPress={() => setActivityType(item.value)} style={[styles.typeCard, activityType === item.value && styles.typeCardActive]}><MaterialIcon color={activityType === item.value ? '#ffffff' : '#778477'} name={item.icon} size={20} /><Text style={[styles.typeText, activityType === item.value && styles.typeTextActive]}>{item.label}</Text></Touchable>)}</View> : null}

        <View style={styles.identityCard}>
          <TextInput onChangeText={setTitle} placeholder={entryMode === 'reminder' ? 'ชื่อการเตือน' : activityType === 'task' ? 'ชื่องาน' : activityType === 'appointment' ? 'ชื่อนัดหมาย' : 'ชื่อกิจกรรม'} placeholderTextColor="#9ba49a" style={styles.titleInput} value={title} />
          <View style={styles.cardDivider} />
          <View style={styles.inlineInput}><MaterialIcon color="#6f826e" name={entryMode === 'reminder' ? 'notes' : 'location_on'} size={18} /><TextInput onChangeText={entryMode === 'reminder' ? setNote : setLocation} placeholder={entryMode === 'reminder' ? 'เพิ่มโน้ตสั้น ๆ' : 'สถานที่หรือห้องเรียน (ไม่บังคับ)'} placeholderTextColor="#9ba49a" style={styles.inlineTextInput} value={entryMode === 'reminder' ? note : location} /></View>
        </View>

        <Text style={styles.sectionTitle}>วันที่และเวลา</Text>
        <View style={styles.modernCard}>
          <View style={styles.dateTimeRow}><View style={styles.rowIcon}><MaterialIcon color="#5f875f" name="event" size={20} /></View><View style={{flex: 1}}><Text style={styles.rowLabel}>วันที่</Text><Touchable accessibilityLabel="เลือกวันที่" onPress={() => setPickerTarget('date')}><Text style={styles.rowValue}>{thaiDateText(date)}</Text></Touchable></View></View>
          <View style={styles.compactChips}>{dateShortcuts.map((shortcut) => { const value = shiftDateKey(thailandDateKey(), shortcut.days); return <Touchable accessibilityLabel={`ตั้งวันที่ ${shortcut.label}`} accessibilityRole="button" accessibilityState={{selected: date === value}} key={shortcut.label} onPress={() => setDate(value)} style={[styles.compactChip, date === value && styles.compactChipActive]}><Text style={[styles.compactChipText, date === value && styles.compactChipTextActive]}>{shortcut.label}</Text></Touchable>; })}</View>
          <View style={styles.cardDivider} />
          <View style={styles.dateTimeRow}><View style={styles.rowIcon}><MaterialIcon color="#5f875f" name="schedule" size={20} /></View><View style={{flex: 1}}><Text style={styles.rowLabel}>{entryMode === 'reminder' ? 'เวลาเตือน' : 'เวลาเริ่ม'}</Text><Touchable accessibilityLabel="เลือกเวลา" onPress={() => setPickerTarget('time')}><Text style={styles.rowValue}>{time}</Text></Touchable></View></View>
          <View style={styles.compactChips}>{timeShortcuts.map((shortcut) => <Touchable accessibilityLabel={`ตั้งเวลา ${shortcut}`} accessibilityRole="button" accessibilityState={{selected: time === shortcut}} key={shortcut} onPress={() => setTime(shortcut)} style={[styles.compactChip, time === shortcut && styles.compactChipActive]}><Text style={[styles.compactChipText, time === shortcut && styles.compactChipTextActive]}>{shortcut}</Text></Touchable>)}</View>
          <View style={styles.cardDivider} />
          <Text style={styles.rowLabel}>ระยะเวลา</Text><Text style={styles.rowHint}>เวลาสิ้นสุดจะคำนวณให้อัตโนมัติ</Text><View style={styles.compactChips}>{durationOptions.map((minutes) => <Touchable key={minutes} onPress={() => setDurationMinutes(minutes)} style={[styles.compactChip, durationMinutes === minutes && styles.compactChipActive]}><Text style={[styles.compactChipText, durationMinutes === minutes && styles.compactChipTextActive]}>{minutes < 60 ? `${minutes} นาที` : `${minutes / 60} ชม.`}</Text></Touchable>)}</View>
          {pickerTarget ? <NativeDateTimePicker accentColor="#638363" is24Hour mode={pickerTarget ?? 'date'} onDismiss={() => setPickerTarget(null)} onValueChange={(_, selectedDate) => selectFormDateTime(selectedDate)} presentation="dialog" value={pickerTarget === 'date' ? parseDateText(date) : parseTimeText(time)} /> : null}
        </View>

        <Text style={styles.sectionTitle}>ความสำคัญ</Text>
        <View style={styles.modernCard}><View style={styles.priorityQuickRow}>{priorityOptions.map((item) => <Touchable accessibilityLabel={`เลือกความสำคัญ ${item.label}`} accessibilityRole="button" accessibilityState={{selected: priority === item.value}} key={item.value} onPress={() => setPriority(item.value)} style={[styles.priorityQuickOption, priority === item.value && styles.priorityQuickOptionActive]}><MaterialIcon color={priority === item.value ? '#fff' : '#5f875f'} name={item.icon} size={17} /><Text style={[styles.priorityQuickText, priority === item.value && styles.priorityQuickTextActive]}>{item.label}</Text></Touchable>)}</View></View>

        <Text style={styles.sectionTitle}>การแจ้งเตือน</Text>
        <View style={styles.modernCard}><View style={styles.reminderGrid}>{reminderOptions.map((item) => <Touchable key={item.value || 'none'} onPress={() => setReminder(item.value)} style={[styles.reminderOption, reminder === item.value && styles.reminderOptionActive]}><View style={[styles.reminderIcon, reminder === item.value && styles.reminderIconActive]}><MaterialIcon color={reminder === item.value ? '#fff' : '#5f875f'} name={item.icon} size={17} /></View><Text style={[styles.reminderText, reminder === item.value && styles.reminderTextActive]}>{item.label}</Text></Touchable>)}</View></View>

        <Text style={styles.sectionTitle}>ตัวเลือกเพิ่มเติม</Text>
        <View style={styles.modernCard}>
          <Text style={styles.rowLabel}>ทำซ้ำ</Text><View style={styles.recurrenceRow}>{recurrenceOptions.map((item) => <Touchable key={item} onPress={() => setRecurrence(item)} style={[styles.recurrenceChip, recurrence === item && styles.recurrenceChipActive]}><Text style={[styles.recurrenceText, recurrence === item && styles.recurrenceTextActive]}>{item}</Text></Touchable>)}</View>
          {entryMode === 'event' ? <><View style={styles.cardDivider} /><Text style={styles.rowLabel}>รายละเอียด</Text><TextInput multiline onChangeText={setNote} placeholder="เพิ่มรายละเอียด สิ่งที่ต้องเตรียม หรือลิงก์ที่เกี่ยวข้อง" placeholderTextColor="#879186" style={styles.noteInput} textAlignVertical="top" value={note} /></> : null}
          {activityType === 'appointment' && entryMode === 'event' ? <><View style={styles.cardDivider} /><Input icon="person_outline" onChangeText={setAttendees} placeholder="เพิ่มผู้เกี่ยวข้อง" value={attendees} /></> : null}
          <View style={styles.cardDivider} /><Text style={styles.colorLabel}>สีของรายการ</Text><View style={styles.colorRow}>{colors.map((item) => <Touchable accessibilityLabel={`เลือกสี ${item}`} key={item} onPress={() => setColor(item)} style={[styles.color, {backgroundColor: item}, color === item && styles.colorSelected]} />)}</View>
        </View>

        <SaveButton disabled={saving || !title.trim()} label={saving ? 'กำลังบันทึก...' : entryMode === 'reminder' ? 'บันทึกการเตือน' : copy.save} onPress={save} saving={saving} />
      </>}
    </View>
    <ScheduleConflictDialog
      conflicts={pendingConflictSave?.conflicts ?? []}
      onConfirm={() => pendingConflictSave ? void commitPayload(pendingConflictSave.payload) : undefined}
      onEdit={() => setPendingConflictSave(null)}
      proposedEndAt={pendingConflictSave?.endAt ?? new Date().toISOString()}
      proposedStartAt={pendingConflictSave?.startAt ?? new Date().toISOString()}
      saving={saving}
      visible={Boolean(pendingConflictSave)}
    />
  </UserShell>;

  /* Kept temporarily unreachable while the redesigned form is validated against the same save pipeline. */
  // eslint-disable-next-line no-unreachable
  if (false) return <UserShell active="smartlife_planner" onNavigate={onNavigate}>
    <View style={styles.page}>
      {/* Refactored UI: activity, task, appointment, and AI suggestion layouts share one existing save pipeline. */}
      <View style={styles.header}><Text style={styles.title}>{formMode === 'ai' ? 'AI แนะนำ' : copy.title}</Text><Touchable accessibilityLabel="ปิด" onPress={() => onNavigate('smartlife_planner')} style={styles.close}><MaterialIcon color="#354133" name="close" size={21} /></Touchable></View>
      <View style={styles.modeToggle}><Touchable onPress={() => setFormMode('manual')} style={[styles.mode, formMode === 'manual' && styles.modeActive]}><Text style={[styles.modeText, formMode === 'manual' && styles.modeTextActive]}>เพิ่มเอง</Text></Touchable><Touchable onPress={() => { setLoadingAiSuggestions(true); setFormMode('ai'); }} style={[styles.mode, formMode === 'ai' && styles.modeActive]}><Text style={[styles.modeText, formMode === 'ai' && styles.modeTextActive]}>AI แนะนำ</Text></Touchable></View>
      {formMode === 'ai' ? <AiSuggestions loading={loadingAiSuggestions} onUse={useSuggestion} suggestions={aiSuggestions} /> : <>
        <View style={styles.typeRow}>{activityTypes.map((item) => <Touchable key={item.value} onPress={() => setActivityType(item.value)} style={[styles.typeCard, activityType === item.value && styles.typeCardActive]}><MaterialIcon color={activityType === item.value ? '#ffffff' : '#778477'} name={item.icon} size={20} /><Text style={[styles.typeText, activityType === item.value && styles.typeTextActive]}>{item.label}</Text></Touchable>)}</View>
        <View style={styles.formCard}>
          <FieldLabel label={activityType === 'task' ? 'ชื่องาน' : activityType === 'appointment' ? 'ชื่อนัดหมาย' : 'ชื่อกิจกรรม'} /><Input icon="format_align_left" onChangeText={setTitle} placeholder={activityType === 'task' ? 'แตะเพื่อพิมพ์ชื่องาน' : activityType === 'appointment' ? 'แตะเพื่อพิมพ์ชื่อนัดหมาย' : 'แตะเพื่อพิมพ์ชื่อกิจกรรม'} value={title} />
          <View style={styles.twoColumn}><View style={styles.column}><FieldLabel label={copy.due} /><PickerButton icon="event" label="วันที่" onPress={() => setPickerTarget('date')} value={thaiDateText(date)} /></View><View style={styles.column}><FieldLabel label={activityType === 'appointment' ? 'ช่วงเวลา' : activityType === 'task' ? 'เวลาเตือน' : 'เวลา'} /><PickerButton icon="schedule" label="เวลา" onPress={() => setPickerTarget('time')} value={time} /></View></View>
          {pickerTarget ? <NativeDateTimePicker accentColor="#638363" is24Hour mode={pickerTarget ?? 'date'} onDismiss={() => setPickerTarget(null)} onValueChange={(_, selectedDate) => selectFormDateTime(selectedDate)} presentation="dialog" value={pickerTarget === 'date' ? parseDateText(date) : parseTimeText(time)} /> : null}
          <FieldLabel label={copy.location} /><Input icon="location_on" onChangeText={setLocation} placeholder={activityType === 'task' ? 'เลือกวิชาหรือหมวดงาน' : activityType === 'appointment' ? 'เพิ่มสถานที่นัด' : 'เพิ่มสถานที่'} value={location} />
          {activityType === 'task' ? <><FieldLabel label="ความสำคัญ" /><View style={styles.priorityGrid}>{priorityOptions.map((item) => <Touchable accessibilityLabel={`เลือกความสำคัญ${item.label}`} key={item.value} onPress={() => setPriority(item.value)} style={({pressed}) => [styles.priorityOption, priority === item.value && styles.priorityOptionActive, pressed && styles.pressed]}><View style={[styles.priorityIcon, priority === item.value && styles.priorityIconActive]}><MaterialIcon color={priority === item.value ? '#fff' : '#638363'} name={item.icon} size={17} /></View><View style={{flex: 1}}><Text style={[styles.priorityLabel, priority === item.value && styles.priorityLabelActive]}>{item.label}</Text><Text style={[styles.priorityDescription, priority === item.value && styles.priorityDescriptionActive]}>{item.description}</Text></View></Touchable>)}</View></> : activityType === 'appointment' ? <><FieldLabel label="ผู้เกี่ยวข้อง" /><Input icon="person_outline" onChangeText={setAttendees} placeholder="เพิ่มชื่อเพื่อนหรือกลุ่ม" value={attendees} /></> : <><FieldLabel label="แจ้งเตือน" /><Input icon="notifications_none" onChangeText={setReminder} placeholder="เลือกเวลาแจ้งเตือน" value={reminder} /></>}
          <FieldLabel label={copy.details} /><TextInput multiline onChangeText={setNote} placeholder={activityType === 'task' ? 'เพิ่มรายละเอียด เช่น rubric ไฟล์แนบ หรือสิ่งที่ต้องส่ง' : activityType === 'appointment' ? 'เพิ่มรายละเอียด เช่น จุดนัดพบ สิ่งที่ต้องเตรียม หรือหัวข้อที่จะคุย' : 'เพิ่มรายละเอียด เช่น สิ่งที่ต้องเตรียม หรือไฟล์ที่ต้องส่ง'} placeholderTextColor="#879186" style={styles.noteInput} textAlignVertical="top" value={note} />
          <Text style={styles.colorLabel}>สีของรายการ</Text><View style={styles.colorRow}>{colors.map((item) => <Touchable accessibilityLabel={`เลือกสี ${item}`} key={item} onPress={() => setColor(item)} style={[styles.color, {backgroundColor: item}, color === item && styles.colorSelected]} />)}</View>
          <Touchable disabled={saving} onPress={save} style={[styles.saveShell, saving && styles.disabled]}><LinearGradient colors={['#6f966f', '#476d43']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.save}><Text style={styles.saveText}>{saving ? 'กำลังบันทึก...' : copy.save}</Text></LinearGradient></Touchable>
        </View>
        <View style={styles.aiCard}><Text style={styles.aiTitle}>{activityType === 'task' ? 'AI ช่วยแตกงานย่อย' : 'AI ช่วยแนะนำช่วงว่าง'}</Text><Text style={styles.aiText}>{activityType === 'task' ? 'ให้ระบบช่วยแยกงานเป็น checklist และแนะนำช่วงเวลาทำงานที่ไม่ชนตารางเรียนได้' : 'ระบบจะช่วยดูช่วงเวลาว่างและแนะนำกิจกรรมให้เหมาะกับตารางของคุณ'}</Text><View style={styles.aiActions}><Touchable onPress={() => setFormMode('ai')} style={styles.aiPrimary}><Text style={styles.aiPrimaryText}>ใช้คำแนะนำ</Text></Touchable><Touchable onPress={() => setFormMode('ai')} style={styles.aiSecondary}><Text style={styles.aiSecondaryText}>ดูตัวอย่าง</Text></Touchable></View></View>
      </>}
    </View>
  </UserShell>;
}

function IncomeForm({amount, category, date, note, onBack, onNavigate, onSave, saving, setAmount, setCategory, setDate, setNote, setTime, setTitle, time, title}: {amount: string; category: string; date: string; note: string; onBack: () => void; onNavigate: UserNavigate; onSave: () => void; saving: boolean; setAmount: (value: string) => void; setCategory: (value: string) => void; setDate: (value: string) => void; setNote: (value: string) => void; setTime: (value: string) => void; setTitle: (value: string) => void; time: string; title: string}) {
  const sources = INCOME_SOURCES;
  const selected = sources.find((source) => source.value === category)?.value ?? sources[0].value;
  const [pickerTarget, setPickerTarget] = useState<'date' | 'time' | null>(null);
  const selectDateTime = (selectedDate?: Date | null) => {
    if (!selectedDate || !pickerTarget) return;
    if (pickerTarget === 'date') setDate(formatDateText(selectedDate));
    else setTime(formatTimeText(selectedDate));
    setPickerTarget(null);
  };
  return <UserShell active="smartlife_finance_day" onNavigate={onNavigate}>
    <View style={incomeStyles.page}>
      {/* Refactored UI: dedicated income form preserves the existing transaction save flow. */}
      <View style={incomeStyles.header}><Touchable onPress={onBack} style={incomeStyles.back}><MaterialIcon color="#344035" name="chevron_left" size={25} /></Touchable><View style={{flex: 1}}><Text style={incomeStyles.eyebrow}>รายรับใหม่</Text><Text style={incomeStyles.title}>เพิ่มรายรับเอง</Text></View><Touchable disabled={saving} onPress={onSave} style={[incomeStyles.done, saving && incomeStyles.disabled]}><MaterialIcon color="#fff" name="check" size={22} /></Touchable></View>
      <LinearGradient colors={['#6270aa', '#9199c2']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={incomeStyles.amountCard}><Text style={incomeStyles.amountLabel}>จำนวนเงิน</Text><View style={incomeStyles.amountRow}><Text style={incomeStyles.currency}>฿</Text><TextInput keyboardType="numeric" onChangeText={setAmount} placeholder="0" placeholderTextColor="rgba(255,255,255,.68)" style={incomeStyles.amountInput} value={amount} /></View></LinearGradient>
      <View style={incomeStyles.formCard}><Text style={incomeStyles.label}>แหล่งที่มา</Text><View style={incomeStyles.sourceGrid}>{sources.map((source) => <Touchable key={source.value} onPress={() => setCategory(source.value)} style={[incomeStyles.source, selected === source.value && incomeStyles.sourceActive]}><View style={[incomeStyles.sourceIcon, selected === source.value && incomeStyles.sourceIconActive]}><MaterialIcon color={selected === source.value ? '#fff' : '#6b8a68'} name={source.icon} size={18} /></View><View><Text style={incomeStyles.sourceTitle}>{source.label}</Text><Text style={incomeStyles.sourceSub}>{source.value}</Text></View></Touchable>)}</View>
        <Text style={incomeStyles.label}>ชื่อรายการ</Text><TextInput onChangeText={setTitle} placeholder="เงินโอนจากบ้าน" placeholderTextColor="#879087" style={incomeStyles.input} value={title} />
        <Text style={incomeStyles.label}>วันที่</Text><View style={incomeStyles.dateRow}><Touchable accessibilityLabel="เลือกรายรับวันที่" onPress={() => setPickerTarget('date')} style={({pressed}) => [incomeStyles.pickerButton, {flex: 1}, pressed && incomeStyles.pressed]}><MaterialIcon color="#6b8a68" name="event" size={18} /><View style={{flex: 1}}><Text style={incomeStyles.pickerLabel}>วันที่</Text><Text style={incomeStyles.pickerValue}>{thaiDateText(date)}</Text></View></Touchable><Touchable accessibilityLabel="เลือกรายรับเวลา" onPress={() => setPickerTarget('time')} style={({pressed}) => [incomeStyles.pickerButton, {flex: .7}, pressed && incomeStyles.pressed]}><MaterialIcon color="#6b8a68" name="schedule" size={18} /><View style={{flex: 1}}><Text style={incomeStyles.pickerLabel}>เวลา</Text><Text style={incomeStyles.pickerValue}>{time}</Text></View></Touchable></View>
        {pickerTarget ? <NativeDateTimePicker accentColor="#6b8a68" is24Hour mode={pickerTarget} onDismiss={() => setPickerTarget(null)} onValueChange={(_, selectedDate) => selectDateTime(selectedDate)} presentation="dialog" value={pickerTarget === 'date' ? parseDateText(date) : parseTimeText(time)} /> : null}
        <Text style={incomeStyles.label}>หมายเหตุ</Text><TextInput multiline onChangeText={setNote} placeholder="เงินสำหรับค่าอาหารและเดินทางสัปดาห์นี้" placeholderTextColor="#879087" style={incomeStyles.note} textAlignVertical="top" value={note} />
      </View><View style={incomeStyles.statRow}><IncomeStat label="หลังบันทึก" value={`รายรับ +฿${Number(amount || 0).toLocaleString('th-TH')}`} /><IncomeStat label="ยอดวันนี้" value={`฿${Number(amount || 0).toLocaleString('th-TH')}`} /></View><Touchable disabled={saving} onPress={onSave} style={[incomeStyles.saveShell, saving && incomeStyles.disabled]}><LinearGradient colors={['#2b3916', '#1e2b0f']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={incomeStyles.save}><MaterialIcon color="#fff" name="check" size={18} /><Text style={incomeStyles.saveText}>{saving ? 'กำลังบันทึก...' : 'บันทึกรายรับ'}</Text></LinearGradient></Touchable>
    </View>
  </UserShell>;
}

function ExpenseForm({amount, category, date, note, onBack, onNavigate, onSave, saving, setAmount, setCategory, setDate, setNote, setTime, setTitle, time, title}: {amount: string; category: string; date: string; note: string; onBack: () => void; onNavigate: UserNavigate; onSave: () => void; saving: boolean; setAmount: (value: string) => void; setCategory: (value: string) => void; setDate: (value: string) => void; setNote: (value: string) => void; setTime: (value: string) => void; setTitle: (value: string) => void; time: string; title: string}) {
  const categories = [
    {icon: 'restaurant', label: 'อาหาร', value: 'อาหาร'},
    {icon: 'shopping_bag', label: 'ช้อปปิ้ง', value: 'ช้อปปิ้ง'},
    {icon: 'directions_bus', label: 'เดินทาง', value: 'เดินทาง'},
    {icon: 'receipt_long', label: 'บิลและบริการ', value: 'บิลและบริการ'},
  ];
  const initialCustomCategory = categories.some((item) => item.value === category) ? '' : category;
  const [customMode, setCustomMode] = useState(Boolean(initialCustomCategory));
  const [customCategory, setCustomCategory] = useState(initialCustomCategory);
  const [pickerTarget, setPickerTarget] = useState<'date' | 'time' | null>(null);
  const selected = customMode ? 'other' : categories.find((item) => item.value === category)?.value;
  const selectCategory = (value: string) => {
    setCustomMode(false);
    setCategory(value);
  };
  const selectCustomCategory = () => {
    setCustomMode(true);
    setCategory(customCategory);
  };
  const updateCustomCategory = (value: string) => {
    setCustomCategory(value);
    setCategory(value);
  };
  const selectDateTime = (selectedDate?: Date | null) => {
    if (!selectedDate || !pickerTarget) return;
    if (pickerTarget === 'date') setDate(formatDateText(selectedDate));
    else setTime(formatTimeText(selectedDate));
    setPickerTarget(null);
  };

  return <UserShell active="smartlife_finance_day" onNavigate={onNavigate}>
    <View style={incomeStyles.page}>
      {/* Added for manual expenses: quick categories plus a user-defined category. */}
      <View style={incomeStyles.header}><Touchable accessibilityLabel="กลับหน้าการเงิน" onPress={onBack} style={incomeStyles.back}><MaterialIcon color="#344035" name="chevron_left" size={25} /></Touchable><View style={{flex: 1}}><Text style={incomeStyles.expenseEyebrow}>รายจ่ายใหม่</Text><Text style={incomeStyles.title}>เพิ่มรายจ่ายเอง</Text></View><Touchable disabled={saving} onPress={onSave} style={[incomeStyles.done, incomeStyles.expenseDone, saving && incomeStyles.disabled]}><MaterialIcon color="#fff" name="check" size={22} /></Touchable></View>
      <LinearGradient colors={['#d77b70', '#bd6064']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={incomeStyles.amountCard}><Text style={incomeStyles.amountLabel}>จำนวนเงิน</Text><View style={incomeStyles.amountRow}><Text style={incomeStyles.currency}>฿</Text><TextInput keyboardType="numeric" onChangeText={setAmount} placeholder="0" placeholderTextColor="rgba(255,255,255,.68)" style={incomeStyles.amountInput} value={amount} /></View></LinearGradient>
      <View style={incomeStyles.formCard}>
        <Text style={incomeStyles.label}>หมวดรายจ่าย</Text>
        <View style={incomeStyles.sourceGrid}>
          {categories.map((item) => <Touchable accessibilityLabel={`เลือกหมวดรายจ่าย ${item.label}`} key={item.value} onPress={() => selectCategory(item.value)} style={[incomeStyles.source, selected === item.value && incomeStyles.expenseSourceActive]}><View style={[incomeStyles.sourceIcon, incomeStyles.expenseSourceIcon, selected === item.value && incomeStyles.expenseSourceIconActive]}><MaterialIcon color={selected === item.value ? '#fff' : '#b96561'} name={item.icon} size={18} /></View><View style={incomeStyles.sourceCopy}><Text style={incomeStyles.sourceTitle}>{item.label}</Text><Text style={incomeStyles.sourceSub}>แตะเพื่อเลือก</Text></View></Touchable>)}
          <Touchable accessibilityLabel="เพิ่มหมวดรายจ่ายอื่น ๆ" onPress={selectCustomCategory} style={[incomeStyles.source, selected === 'other' && incomeStyles.expenseSourceActive]}><View style={[incomeStyles.sourceIcon, incomeStyles.expenseSourceIcon, selected === 'other' && incomeStyles.expenseSourceIconActive]}><MaterialIcon color={selected === 'other' ? '#fff' : '#b96561'} name="add" size={18} /></View><View style={incomeStyles.sourceCopy}><Text style={incomeStyles.sourceTitle}>อื่น ๆ</Text><Text style={incomeStyles.sourceSub}>ตั้งหมวดเอง</Text></View></Touchable>
        </View>
        {customMode ? <View style={incomeStyles.expenseCustomCategoryBlock}><Text style={incomeStyles.expenseCustomCategoryHint}>ตั้งชื่อหมวดรายจ่ายของคุณ</Text><TextInput autoFocus maxLength={40} onChangeText={updateCustomCategory} placeholder="เช่น สุขภาพ, สัตว์เลี้ยง, ค่าเรียน" placeholderTextColor="#879087" style={incomeStyles.input} value={customCategory} /></View> : null}
        <Text style={incomeStyles.label}>ชื่อรายการหรือร้านค้า</Text><TextInput onChangeText={setTitle} placeholder="เช่น ข้าวกลางวัน, ร้านหนังสือ" placeholderTextColor="#879087" style={incomeStyles.input} value={title} />
        <Text style={incomeStyles.label}>วันที่</Text><View style={incomeStyles.dateRow}><Touchable accessibilityLabel="เลือกรายจ่ายวันที่" onPress={() => setPickerTarget('date')} style={({pressed}) => [incomeStyles.pickerButton, {flex: 1}, pressed && incomeStyles.pressed]}><MaterialIcon color="#b96561" name="event" size={18} /><View style={{flex: 1}}><Text style={incomeStyles.pickerLabel}>วันที่</Text><Text style={incomeStyles.pickerValue}>{thaiDateText(date)}</Text></View></Touchable><Touchable accessibilityLabel="เลือกรายจ่ายเวลา" onPress={() => setPickerTarget('time')} style={({pressed}) => [incomeStyles.pickerButton, {flex: .7}, pressed && incomeStyles.pressed]}><MaterialIcon color="#b96561" name="schedule" size={18} /><View style={{flex: 1}}><Text style={incomeStyles.pickerLabel}>เวลา</Text><Text style={incomeStyles.pickerValue}>{time}</Text></View></Touchable></View>
        {pickerTarget ? <NativeDateTimePicker accentColor="#b96561" is24Hour mode={pickerTarget} onDismiss={() => setPickerTarget(null)} onValueChange={(_, selectedDate) => selectDateTime(selectedDate)} presentation="dialog" value={pickerTarget === 'date' ? parseDateText(date) : parseTimeText(time)} /> : null}
        <Text style={incomeStyles.label}>หมายเหตุ</Text><TextInput multiline onChangeText={setNote} placeholder="เพิ่มรายละเอียด (ไม่บังคับ)" placeholderTextColor="#879087" style={incomeStyles.note} textAlignVertical="top" value={note} />
      </View>
      <View style={incomeStyles.statRow}><IncomeStat label="หลังบันทึก" value={`รายจ่าย -฿${Number(amount || 0).toLocaleString('th-TH')}`} /><IncomeStat label="ยอดรายการนี้" value={`฿${Number(amount || 0).toLocaleString('th-TH')}`} /></View>
      <Touchable disabled={saving} onPress={onSave} style={[incomeStyles.saveShell, saving && incomeStyles.disabled]}><LinearGradient colors={['#b96561', '#934b50']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={incomeStyles.save}><MaterialIcon color="#fff" name="check" size={18} /><Text style={incomeStyles.saveText}>{saving ? 'กำลังบันทึก...' : 'บันทึกรายจ่าย'}</Text></LinearGradient></Touchable>
    </View>
  </UserShell>;
}
function IncomeStat({label, value}: {label: string; value: string}) { return <View style={incomeStyles.stat}><Text style={incomeStyles.statLabel}>{label}</Text><Text style={incomeStyles.statValue}>{value}</Text></View>; }
function AiSuggestions({loading, onUse, suggestions}: {loading: boolean; onUse: (suggestion: ActivitySuggestion) => void; suggestions: ActivitySuggestion[]}) {
  return <View style={styles.suggestionArea}>
    <LinearGradient colors={['#6f966f', '#9ab0a0']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.suggestionHero}>
      <Text style={styles.suggestionHeroTitle}>พบช่วงว่างที่เหมาะกับกิจกรรม</Text>
      <Text style={styles.suggestionHeroText}>AI ดูจากตารางเรียน งานที่ต้องส่ง ความสำคัญที่เลือก และช่องว่างจริง แล้วให้คะแนน 0-100 ก่อนเสนอรายการ</Text>
    </LinearGradient>
    {loading ? <View style={styles.emptyAi}><ActivityIndicator color="#5f875f" /><Text style={styles.emptyAiText}>กำลังวิเคราะห์ข้อมูลจาก Firebase...</Text></View> : null}
    {!loading && suggestions.length === 0 ? <View style={styles.emptyAi}><MaterialIcon color="#7f8c7d" name="info" size={20} /><Text style={styles.emptyAiText}>ยังไม่มีคำแนะนำพอให้สร้างอัตโนมัติ ลองเพิ่มตารางเรียน งาน หรือกำหนดความสำคัญก่อน</Text></View> : null}
    {!loading && suggestions.map((suggestion) => <View key={`${suggestion.title}-${suggestion.startAt}`} style={styles.suggestionCard}>
      <View style={styles.suggestionCardHead}><Text style={styles.suggestionTitle}>{suggestion.title}</Text><View style={styles.scoreBadge}><Text style={styles.scoreBadgeText}>{recommendationLevel(suggestion.score)}</Text></View></View>
      <Text style={styles.suggestionText}>{suggestion.detail}</Text>
      <View style={styles.tagRow}><Tag label="วันนี้" /><Tag label={suggestion.time} /><Tag label={suggestion.location} /></View>
      <View style={styles.reasonRow}>{suggestion.reasons.slice(0, 3).map((reason) => <Tag key={reason} label={reason} />)}</View>
      <Touchable onPress={() => onUse(suggestion)} style={styles.useSuggestion}><Text style={styles.useSuggestionText}>ใช้กิจกรรมนี้</Text></Touchable>
    </View>)}
  </View>;
}
function Tag({label}: {label: string}) { return <View style={styles.tag}><Text style={styles.tagText}>{label}</Text></View>; }
function FieldLabel({label}: {label: string}) { return <Text style={styles.label}>{label}</Text>; }
function Input({icon, ...props}: {icon?: string} & React.ComponentProps<typeof TextInput>) { return <View style={styles.inputShell}>{icon ? <MaterialIcon color="#638363" name={icon} size={18} /> : null}<TextInput placeholderTextColor="#879186" style={styles.input} {...props} /></View>; }
function PickerButton({icon, label, onPress, value}: {icon: string; label: string; onPress: () => void; value: string}) { return <Touchable onPress={onPress} style={({pressed}) => [styles.pickerButton, pressed && styles.pressed]}><MaterialIcon color="#638363" name={icon} size={18} /><View style={{flex: 1}}><Text style={styles.pickerLabel}>{label}</Text><Text style={styles.pickerValue}>{value}</Text></View></Touchable>; }

const incomeStyles = StyleSheet.create({
  amountCard: {borderRadius: 20, marginTop: 14, padding: 16}, amountInput: {color: '#fff', flex: 1, fontFamily: 'Prompt_800ExtraBold', fontSize: 34, padding: 0}, amountLabel: {color: 'rgba(255,255,255,.88)', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, amountRow: {alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 10}, back: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, height: 43, justifyContent: 'center', width: 43}, currency: {color: '#fff', fontFamily: 'Prompt_800ExtraBold', fontSize: 31}, dateRow: {flexDirection: 'row', gap: 8}, disabled: {opacity: .55}, done: {alignItems: 'center', backgroundColor: '#6270aa', borderRadius: 17, height: 43, justifyContent: 'center', width: 43}, expenseCustomCategoryBlock: {backgroundColor: '#fdf2f0', borderColor: '#f0d7d3', borderRadius: 16, borderWidth: 1, marginTop: 10, padding: 10}, expenseCustomCategoryHint: {color: '#9a605d', fontFamily: 'Prompt_600SemiBold', fontSize: 12, marginBottom: 6}, expenseDone: {backgroundColor: '#b96561'}, expenseEyebrow: {color: '#b96561', fontFamily: 'Prompt_700Bold', fontSize: 12}, expenseSourceActive: {backgroundColor: '#fff0ed', borderColor: '#dfa6a0'}, expenseSourceIcon: {backgroundColor: '#f8e4e0'}, expenseSourceIconActive: {backgroundColor: '#c76d68'}, eyebrow: {color: '#698668', fontFamily: 'Prompt_700Bold', fontSize: 12}, formCard: {backgroundColor: '#fff', borderRadius: 21, boxShadow: '0 8px 19px rgba(43,57,41,.08)', marginTop: 14, padding: 14}, header: {alignItems: 'center', flexDirection: 'row', gap: 10}, input: {backgroundColor: '#f8faf6', borderColor: '#e0e6dd', borderRadius: 14, borderWidth: 1, color: '#344035', fontFamily: 'Prompt_700Bold', fontSize: 12, minHeight: 44, paddingHorizontal: 12}, label: {color: '#788178', fontFamily: 'Prompt_700Bold', fontSize: 12, marginBottom: 6, marginTop: 13}, note: {backgroundColor: '#f8faf6', borderColor: '#e0e6dd', borderRadius: 14, borderWidth: 1, color: '#344035', fontFamily: 'Prompt_500Medium', fontSize: 12, minHeight: 78, padding: 12}, page: {paddingBottom: 5}, pickerButton: {alignItems: 'center', backgroundColor: '#f8faf6', borderColor: '#e0e6dd', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 58, paddingHorizontal: 12}, pickerLabel: {color: '#879087', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, pickerValue: {color: '#344035', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 1}, pressed: {opacity: .78, transform: [{scale: .987}]}, save: {alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 50}, saveShell: {borderRadius: 16, marginTop: 14, overflow: 'hidden'}, saveText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 14}, source: {alignItems: 'center', backgroundColor: '#f8faf6', borderColor: '#e0e6dd', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, padding: 9, width: '48.5%'}, sourceActive: {backgroundColor: '#eff1fb', borderColor: '#aeb8df'}, sourceCopy: {flex: 1, minWidth: 0}, sourceGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8}, sourceIcon: {alignItems: 'center', backgroundColor: '#e7f0e4', borderRadius: 12, height: 32, justifyContent: 'center', width: 32}, sourceIconActive: {backgroundColor: '#8792c2'}, sourceSub: {color: '#8c948b', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1}, sourceTitle: {color: '#374136', fontFamily: 'Prompt_700Bold', fontSize: 12}, stat: {backgroundColor: '#fff', borderRadius: 17, flex: 1, padding: 12}, statLabel: {color: '#8a9389', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, statRow: {flexDirection: 'row', gap: 10, marginTop: 14}, statValue: {color: '#31402e', fontFamily: 'Prompt_800ExtraBold', fontSize: 13, marginTop: 3}, title: {color: '#344035', fontFamily: 'Prompt_800ExtraBold', fontSize: 20},
});

const styles = StyleSheet.create({
  aiModeButton: {alignItems: 'center', backgroundColor: '#eef4ea', borderColor: '#dce8d7', borderRadius: 19, borderWidth: 1, flexDirection: 'row', gap: 10, marginTop: 11, minHeight: 64, paddingHorizontal: 13},
  aiModeIcon: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 13, height: 38, justifyContent: 'center', width: 38},
  aiModeText: {color: '#7b8879', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1},
  aiModeTitle: {color: '#354433', fontFamily: 'Prompt_700Bold', fontSize: 12},
  aiActions: {flexDirection: 'row', gap: 9, marginTop: 12}, aiCard: {backgroundColor: '#edf4eb', borderRadius: 20, marginTop: 16, padding: 15}, aiPrimary: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 11, flex: 1, minHeight: 35, justifyContent: 'center'}, aiPrimaryText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12}, aiSecondary: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 11, flex: 1, justifyContent: 'center', minHeight: 35}, aiSecondaryText: {color: '#5a7759', fontFamily: 'Prompt_700Bold', fontSize: 12}, aiText: {color: '#70806f', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 3}, aiTitle: {color: '#2e3c2e', fontFamily: 'Prompt_700Bold', fontSize: 12}, close: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 20, height: 40, justifyContent: 'center', width: 40}, color: {borderColor: '#fff', borderRadius: 15, borderWidth: 3, height: 30, width: 30}, colorLabel: {color: '#344235', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 15}, colorRow: {flexDirection: 'row', gap: 7, marginTop: 7}, colorSelected: {borderColor: '#2e3c2e', transform: [{scale: 1.08}]}, column: {flex: 1}, disabled: {opacity: .55}, emptyAi: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, gap: 8, justifyContent: 'center', minHeight: 86, padding: 14}, emptyAiText: {color: '#6b7669', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, textAlign: 'center'}, formCard: {backgroundColor: '#fff', borderRadius: 22, boxShadow: '0 8px 20px rgba(42,58,42,.08)', marginTop: 12, padding: 15}, header: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, input: {color: '#354133', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, minHeight: 42, paddingHorizontal: 10}, inputShell: {alignItems: 'center', backgroundColor: '#f7f9f5', borderColor: '#e0e7de', borderRadius: 14, borderWidth: 1, flexDirection: 'row', minHeight: 44, paddingHorizontal: 11}, label: {color: '#344235', fontFamily: 'Prompt_700Bold', fontSize: 12, marginBottom: 6, marginTop: 13}, mode: {alignItems: 'center', borderRadius: 14, flex: 1, justifyContent: 'center', minHeight: 39}, modeActive: {backgroundColor: '#5f875f'}, modeText: {color: '#778477', fontFamily: 'Prompt_700Bold', fontSize: 12}, modeTextActive: {color: '#fff'}, modeToggle: {backgroundColor: '#e8eee5', borderRadius: 17, flexDirection: 'row', marginTop: 12, padding: 4}, noteInput: {backgroundColor: '#f7f9f5', borderColor: '#e0e7de', borderRadius: 14, borderWidth: 1, color: '#354133', fontFamily: 'Prompt_400Regular', fontSize: 12, minHeight: 96, padding: 12}, page: {paddingBottom: 6}, pickerButton: {alignItems: 'center', backgroundColor: '#f7f9f5', borderColor: '#e0e7de', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 52, paddingHorizontal: 11}, pickerLabel: {color: '#7c8879', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, pickerValue: {color: '#354133', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 1}, pressed: {opacity: .78, transform: [{scale: .987}]}, priorityDescription: {color: '#7a8677', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1}, priorityDescriptionActive: {color: 'rgba(255,255,255,.84)'}, priorityGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8}, priorityIcon: {alignItems: 'center', backgroundColor: '#e8efe5', borderRadius: 12, height: 32, justifyContent: 'center', width: 32}, priorityIconActive: {backgroundColor: 'rgba(255,255,255,.22)'}, priorityLabel: {color: '#354133', fontFamily: 'Prompt_800ExtraBold', fontSize: 12}, priorityLabelActive: {color: '#fff'}, priorityOption: {alignItems: 'center', backgroundColor: '#f7f9f5', borderColor: '#e0e7de', borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 58, padding: 9, width: '48.5%'}, priorityOptionActive: {backgroundColor: '#5f875f', borderColor: '#5f875f'}, reasonRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7}, save: {alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 50}, saveShell: {borderRadius: 16, marginTop: 15, overflow: 'hidden'}, saveText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 14}, scoreBadge: {alignItems: 'center', backgroundColor: '#edf2eb', borderRadius: 99, minWidth: 33, paddingHorizontal: 8, paddingVertical: 4}, scoreBadgeText: {color: '#5f875f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12}, suggestionArea: {gap: 10, marginTop: 16}, suggestionCard: {backgroundColor: '#fff', borderRadius: 20, boxShadow: '0 6px 18px rgba(42,58,42,.07)', padding: 14}, suggestionCardHead: {alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between'}, suggestionHero: {borderRadius: 20, padding: 16}, suggestionHeroText: {color: 'rgba(255,255,255,.88)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 4}, suggestionHeroTitle: {color: '#fff', fontFamily: 'Prompt_800ExtraBold', fontSize: 15}, suggestionText: {color: '#657164', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 5}, suggestionTitle: {color: '#314032', flex: 1, fontFamily: 'Prompt_800ExtraBold', fontSize: 14}, tag: {backgroundColor: '#edf2eb', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4}, tagRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 10}, tagText: {color: '#687767', fontFamily: 'Prompt_700Bold', fontSize: 12}, title: {color: '#2f3d2f', fontFamily: 'Prompt_800ExtraBold', fontSize: 22}, twoColumn: {flexDirection: 'row', gap: 9}, typeCard: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, flex: 1, gap: 5, minHeight: 61, justifyContent: 'center'}, typeCardActive: {backgroundColor: '#5f875f'}, typeRow: {flexDirection: 'row', gap: 7, marginTop: 12}, typeText: {color: '#778477', fontFamily: 'Prompt_700Bold', fontSize: 12}, typeTextActive: {color: '#fff'}, useSuggestion: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 12, justifyContent: 'center', marginTop: 12, minHeight: 37}, useSuggestionText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  cardDivider: {backgroundColor: '#e8ece6', height: 1, marginVertical: 12},
  compactChip: {backgroundColor: '#f0f4ed', borderRadius: 11, paddingHorizontal: 9, paddingVertical: 7},
  compactChipActive: {backgroundColor: '#5f875f'},
  compactChips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9},
  compactChipText: {color: '#748073', fontFamily: 'Prompt_700Bold', fontSize: 12},
  compactChipTextActive: {color: '#fff'},
  dateTimeRow: {alignItems: 'center', flexDirection: 'row', gap: 11},
  doneButton: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 21, boxShadow: '0 8px 17px rgba(70,100,65,.2)', height: 44, justifyContent: 'center', width: 44},
  doneButtonDisabled: {backgroundColor: '#cbd3c9', boxShadow: 'none'},
  entryMode: {alignItems: 'center', borderRadius: 14, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 42},
  entryModeActive: {backgroundColor: '#5f875f', boxShadow: '0 6px 14px rgba(68,96,64,.18)'},
  entryModeText: {color: '#718071', fontFamily: 'Prompt_700Bold', fontSize: 12},
  entryModeTextActive: {color: '#fff'},
  entryToggle: {backgroundColor: '#e8eee5', borderRadius: 18, flexDirection: 'row', marginTop: 13, padding: 4},
  eyebrow: {color: '#6f8a6b', fontFamily: 'Prompt_700Bold', fontSize: 12, letterSpacing: .6},
  headerDone: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 21, height: 44, justifyContent: 'center', width: 44},
  headerDoneDisabled: {backgroundColor: '#cbd3c9'},
  identityCard: {backgroundColor: '#fff', borderRadius: 22, boxShadow: '0 8px 20px rgba(42,58,42,.07)', marginTop: 12, paddingHorizontal: 15, paddingVertical: 7},
  inlineInput: {alignItems: 'center', flexDirection: 'row', gap: 6},
  inlineTextInput: {color: '#354133', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12, minHeight: 42},
  modernCard: {backgroundColor: '#fff', borderRadius: 22, boxShadow: '0 8px 20px rgba(42,58,42,.07)', padding: 15},
  modernHeader: {alignItems: 'center', flexDirection: 'row', gap: 11},
  modernHeaderCopy: {alignItems: 'center', flex: 1},
  modernPage: {paddingBottom: 8},
  modernTitle: {color: '#2f3d2f', fontFamily: 'Prompt_800ExtraBold', fontSize: 21, marginTop: 1},
  priorityQuickOption: {alignItems: 'center', backgroundColor: '#f0f4ed', borderColor: '#e1e7df', borderRadius: 13, borderWidth: 1, flex: 1, gap: 5, justifyContent: 'center', minHeight: 54, paddingHorizontal: 5},
  priorityQuickOptionActive: {backgroundColor: '#5f875f', borderColor: '#5f875f'},
  priorityQuickRow: {flexDirection: 'row', gap: 7},
  priorityQuickText: {color: '#657264', fontFamily: 'Prompt_700Bold', fontSize: 12},
  priorityQuickTextActive: {color: '#fff'},
  recurrenceChip: {backgroundColor: '#f0f4ed', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 7},
  recurrenceChipActive: {backgroundColor: '#dfeadd'},
  recurrenceRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9},
  recurrenceText: {color: '#7b8579', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  recurrenceTextActive: {color: '#4e704c'},
  reminderGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  reminderIcon: {alignItems: 'center', backgroundColor: '#e6efe3', borderRadius: 12, height: 32, justifyContent: 'center', width: 32},
  reminderIconActive: {backgroundColor: '#5f875f'},
  reminderOption: {alignItems: 'center', backgroundColor: '#f8faf6', borderColor: '#e1e7df', borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 7, minHeight: 48, paddingHorizontal: 9, width: '48.5%'},
  reminderOptionActive: {backgroundColor: '#eef5eb', borderColor: '#86a584'},
  reminderText: {color: '#697568', flexShrink: 1, fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  reminderTextActive: {color: '#456644', fontFamily: 'Prompt_700Bold'},
  roundButton: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 21, boxShadow: '0 6px 15px rgba(42,58,42,.07)', height: 44, justifyContent: 'center', width: 44},
  rowHint: {color: '#929a91', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1},
  rowIcon: {alignItems: 'center', backgroundColor: '#eaf2e6', borderRadius: 13, height: 39, justifyContent: 'center', width: 39},
  rowLabel: {color: '#697568', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  rowValue: {color: '#30402f', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2},
  sectionTitle: {color: '#334132', fontFamily: 'Prompt_800ExtraBold', fontSize: 13, marginBottom: 8, marginTop: 16},
  titleInput: {color: '#30402f', fontFamily: 'Prompt_700Bold', fontSize: 17, minHeight: 51},
});
