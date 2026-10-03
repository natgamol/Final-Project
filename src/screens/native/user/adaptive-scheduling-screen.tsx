import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Easing, Modal, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {AsyncActionOverlay, type AsyncActionStatus} from '@/components/async-action-ui';
import {PlainDateTimeField} from '@/components/date-time-picker';
import {appCheckErrorMessage, isAppCheckError} from '@/lib/app-check';
import {
  adaptiveScheduling,
  type AdaptiveCreateConflict,
  type AdaptiveDashboard,
  type AdaptiveHistory,
  type AdaptivePattern,
  type AdaptivePreferences,
  type AdaptiveProposedActivity,
  type AdaptiveSuggestion,
} from '@/services/adaptive-scheduling';
import ScheduleConflictDialog from '@/components/schedule-conflict-dialog';
import ConfirmDialog from '@/components/confirm-dialog';
import {MaterialIcon, PLANNER_TABS, UserShell, type UserNavigate} from './user-ui';
import {registerAdaptivePushNotifications} from '@/services/push-notifications';
import {showToast} from '@/components/app-toast';

type PlannerTab = 'adaptive' | 'calendar' | 'notes';
type HistoryFilter = 'ai' | 'all' | 'automatic' | 'errors' | 'user';
type Planner = {activeTab: PlannerTab; onTabChange: (tab: PlannerTab) => void};
type ConfirmationFlow = {
  adjusted?: boolean;
  clientRequestId?: string;
  conflicts?: AdaptiveCreateConflict[];
  error?: string;
  proposal: AdaptiveProposedActivity | null;
  savedStartAt?: string;
  stage: 'analyzing' | 'confirm' | 'conflict' | 'error' | 'saving' | 'success';
};
type ActionFeedback = {
  error?: string;
  /** Only a failed action offers a retry; a plain answer has nothing to redo. */
  retryable?: boolean;
  message: string;
  status: AsyncActionStatus;
  title: string;
};

const categoryLabels: Record<string, string> = {
  administration: 'งานทั่วไป', assignment: 'งานส่ง', exercise: 'ออกกำลังกาย', gaming: 'โหมดเล่นเกม', other: 'อื่น ๆ',
  personal_project: 'โปรเจกต์ส่วนตัว', programming: 'เขียนโปรแกรม', reading: 'อ่านหนังสือ', rest: 'พักผ่อน',
  shopping: 'ซื้อของ', study: 'เรียน/ทบทวน',
};

function errorMessage(error: unknown) {
  if (isAppCheckError(error)) return appCheckErrorMessage(error);
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/unauthenticated/i.test(raw)) return 'กรุณาเข้าสู่ระบบอีกครั้ง';
  if (/permission/i.test(raw)) return 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งานข้อมูลส่วนนี้';
  if (/not-found|ไม่พบช่วงว่าง/i.test(raw)) return 'ยังไม่พบช่วงว่างที่ผ่านเงื่อนไขทั้งหมด';
  if (/aborted|อุปกรณ์อื่น/i.test(raw)) return 'รายการถูกแก้จากอุปกรณ์อื่นแล้ว กรุณาโหลดข้อมูลใหม่';
  return raw.replace(/^FirebaseError:\s*/i, '') || 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

function thaiDate(value: string, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  try { return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeStyle: 'short', timeZone}).format(date); }
  catch { return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeStyle: 'short'}).format(date); }
}

function confidenceLabel(value: number) {
  if (value >= .75) return 'ความมั่นใจสูง';
  if (value >= .5) return 'ความมั่นใจปานกลาง';
  if (value >= .3) return 'ความมั่นใจต่ำ';
  return 'อิงจากค่าที่ตั้งไว้';
}

type DateTimeParts = {day: number; hour: number; minute: number; month: number; year: number};

const utcTimeZone = 'UTC';

function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-CA', {timeZone}).format();
    return true;
  } catch { return false; }
}

function resolveTimeZone(suggestionTimeZone: string | undefined, dashboardTimeZone: string | undefined) {
  if (isValidTimeZone(suggestionTimeZone)) return suggestionTimeZone;
  if (isValidTimeZone(dashboardTimeZone)) return dashboardTimeZone;
  return utcTimeZone;
}

function zonedParts(value: Date, timeZone: string): DateTimeParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      calendar: 'iso8601', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', numberingSystem: 'latn', timeZone, year: 'numeric',
    }).formatToParts(value);
    const read = (part: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === part)?.value);
    const result = {day: read('day'), hour: read('hour'), minute: read('minute'), month: read('month'), year: read('year')};
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch { return null; }
}

function sameDateTime(left: DateTimeParts, right: DateTimeParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute;
}

function localInput(value: string, timeZone: string) {
  const parts = zonedParts(new Date(value), timeZone);
  if (!parts) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function parseLocalInput(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const intended = {day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), month: Number(match[2]), year: Number(match[1])};
  const intendedUtc = new Date(Date.UTC(intended.year, intended.month - 1, intended.day, intended.hour, intended.minute));
  if (intendedUtc.getUTCFullYear() !== intended.year || intendedUtc.getUTCMonth() + 1 !== intended.month || intendedUtc.getUTCDate() !== intended.day || intended.hour > 23 || intended.minute > 59) return null;

  const asUtcMs = intendedUtc.getTime();
  const offsetAt = (instantMs: number) => {
    const parts = zonedParts(new Date(instantMs), timeZone);
    return parts ? Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instantMs : null;
  };
  const firstOffset = offsetAt(asUtcMs);
  if (firstOffset === null) return null;
  let instantMs = asUtcMs - firstOffset;
  const correctedOffset = offsetAt(instantMs);
  if (correctedOffset === null) return null;
  instantMs = asUtcMs - correctedOffset;
  const date = new Date(instantMs);
  const verified = zonedParts(date, timeZone);
  return verified && sameDateTime(verified, intended) ? date : null;
}

function newClientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `adaptive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AdaptiveSchedulingScreen({onNavigate, planner}: {onNavigate: UserNavigate; planner?: Planner; uid: string}) {
  const [dashboard, setDashboard] = useState<AdaptiveDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [command, setCommand] = useState('');
  const [alternativeId, setAlternativeId] = useState('');
  const [alternativeTime, setAlternativeTime] = useState('');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [loadedAt, setLoadedAt] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const [confirmationFlow, setConfirmationFlow] = useState<ConfirmationFlow | null>(null);
  // `Alert.alert` does nothing on react-native-web, so these two confirmations
  // -- and the deletes behind them -- were unreachable there.
  const [deletingPatternId, setDeletingPatternId] = useState('');
  const [deletingHistory, setDeletingHistory] = useState(false);
  const [proposalDateDraft, setProposalDateDraft] = useState('');
  const [proposalDurationDraft, setProposalDurationDraft] = useState('60');
  const [proposalEditorError, setProposalEditorError] = useState('');
  const [proposalEditorOpen, setProposalEditorOpen] = useState(false);
  const [proposalTimeDraft, setProposalTimeDraft] = useState('');
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>({message: '', status: 'idle', title: ''});
  const pendingPreferencePatchRef = useRef<Partial<AdaptivePreferences> | null>(null);

  /**
   * Shows the assistant's own answer.
   *
   * These used to be Alert.alert, which react-native-web implements as an empty
   * function, so a web user who asked for a time the schedule could not take
   * saw the input clear and nothing else at all. The screen already renders an
   * overlay for every other outcome; these go through it too.
   */
  const announce = useCallback((title: string, message: string, status: 'success' | 'error' = 'success') => {
    setActionFeedback(status === 'error' ? {error: message, message: '', status, title} : {message, status, title});
  }, []);
  const actionInFlightRef = useRef(false);
  const commandInFlightRef = useRef(false);
  const createActivityInFlightRef = useRef(false);
  const retryActionRef = useRef<{action: () => Promise<unknown>; key: string; success?: string} | null>(null);
  const [successProgress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (confirmationFlow?.stage !== 'success') return;
    successProgress.setValue(0);
    Animated.spring(successProgress, {bounciness: 12, speed: 12, toValue: 1, useNativeDriver: true}).start();
  }, [confirmationFlow?.stage, successProgress]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setDashboard(await adaptiveScheduling.getDashboard()); setLoadedAt(Date.now()); }
    catch (error) { showToast('โหลด Adaptive Scheduling ไม่สำเร็จ', errorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
      void registerAdaptivePushNotifications().catch(() => undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const act = useCallback(async (key: string, action: () => Promise<unknown>, success?: string) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    retryActionRef.current = {action, key, success};
    setBusy(key);
    setActionFeedback({message: 'กำลังตรวจข้อมูลล่าสุดและบันทึกอย่างปลอดภัย', status: 'loading', title: 'กำลังดำเนินการ'});
    try {
      await action();
      await load();
      setActionFeedback({message: success ?? 'ดำเนินการเรียบร้อยแล้ว', status: 'success', title: 'เรียบร้อย'});
    } catch (error) {
      setActionFeedback({error: errorMessage(error), message: '', retryable: true, status: 'error', title: 'ดำเนินการไม่สำเร็จ'});
    } finally {
      actionInFlightRef.current = false;
      setBusy('');
    }
  }, [load]);

  const updatePreference = useCallback((patch: Partial<AdaptivePreferences>, label?: string) => {
    void act('preferences', () => adaptiveScheduling.updatePreferences(patch), label);
  }, [act]);

  const saveProposedActivity = useCallback(async (proposal: AdaptiveProposedActivity, existingClientRequestId?: string) => {
    if (createActivityInFlightRef.current) return;
    createActivityInFlightRef.current = true;
    const clientRequestId = existingClientRequestId ?? newClientRequestId();
    setBusy('create-activity');
    setConfirmationFlow({clientRequestId, proposal, stage: 'saving'});
    try {
      const result = await adaptiveScheduling.createActivity(proposal, clientRequestId);
      if (!result.saved) {
        setConfirmationFlow({clientRequestId, conflicts: result.conflicts, proposal, stage: 'conflict'});
        return;
      }
      setCommand('');
      await load();
      setConfirmationFlow({adjusted: result.adjusted, clientRequestId, proposal, savedStartAt: result.startAt, stage: 'success'});
    } catch (error) {
      setConfirmationFlow({clientRequestId, error: errorMessage(error), proposal, stage: 'error'});
    } finally {
      createActivityInFlightRef.current = false;
      setBusy('');
    }
  }, [load]);

  const applyProposalEdits = useCallback(() => {
    if (confirmationFlow?.stage !== 'confirm' || !confirmationFlow.proposal) return;
    const timeZone = resolveTimeZone(confirmationFlow.proposal.generatedForTimeZone, dashboard?.preferences.timeZone);
    const startAt = parseLocalInput(`${proposalDateDraft} ${proposalTimeDraft}`, timeZone);
    const durationMinutes = Number(proposalDurationDraft);
    // Alert.alert is a no-op on react-native-web, so every one of these
    // messages also has to land somewhere the web build can actually show it.
    const reject = (title: string, detail: string) => {
      setProposalEditorError(detail);
      showToast(title, detail);
    };
    if (!startAt) {
      reject('วันหรือเวลาไม่ถูกต้อง', `กรุณาใช้วันที่แบบ YYYY-MM-DD และเวลา HH:mm ในเขตเวลา ${timeZone}`);
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720) {
      reject('ระยะเวลาไม่ถูกต้อง', 'กรุณาใส่ระยะเวลาตั้งแต่ 15 ถึง 720 นาที');
      return;
    }
    if (startAt.getTime() < Date.now() + 5 * 60_000) {
      reject('เวลานี้ใกล้หรือผ่านไปแล้ว', 'กรุณาเลือกเวลาอย่างน้อย 5 นาทีจากเวลาปัจจุบัน');
      return;
    }
    setProposalEditorError('');
    const updatedProposal: AdaptiveProposedActivity = {
      ...confirmationFlow.proposal,
      durationMinutes,
      endAt: new Date(startAt.getTime() + durationMinutes * 60_000).toISOString(),
      explanation: 'ใช้วัน เวลา และระยะเวลาที่คุณแก้ไข ระบบจะตรวจตารางอีกครั้งก่อนบันทึก',
      generatedForTimeZone: timeZone,
      startAt: startAt.toISOString(),
    };
    setConfirmationFlow((current) => current ? {...current, proposal: updatedProposal} : current);
    setProposalEditorOpen(false);
  }, [confirmationFlow, dashboard?.preferences.timeZone, proposalDateDraft, proposalDurationDraft, proposalTimeDraft]);

  const submitCommand = useCallback(async () => {
    if (commandInFlightRef.current) return;
    const message = command.trim();
    if (!message) return;
    commandInFlightRef.current = true;
    setBusy('command');
    setConfirmationFlow({proposal: null, stage: 'analyzing'});
    try {
      const result = await adaptiveScheduling.processCommand(message);
      setCommand('');
      if (result.preferencePatch) {
        setConfirmationFlow(null);
        pendingPreferencePatchRef.current = result.preferencePatch;
        setActionFeedback({message: 'ระบบเข้าใจว่าคุณต้องการเปลี่ยนช่วงเวลาที่ชอบ ต้องการบันทึกค่านี้หรือไม่?', status: 'confirming', title: 'ยืนยันการตั้งค่า'});
      } else if (result.proposedActivity) {
        const timeZone = resolveTimeZone(result.proposedActivity.generatedForTimeZone, dashboard?.preferences.timeZone);
        const [datePart = '', timePart = ''] = localInput(result.proposedActivity.startAt, timeZone).split(' ');
        setProposalDateDraft(datePart);
        setProposalTimeDraft(timePart);
        setProposalDurationDraft(String(result.proposedActivity.durationMinutes));
        setProposalEditorError('');
        setProposalEditorOpen(false);
        setConfirmationFlow({clientRequestId: newClientRequestId(), proposal: result.proposedActivity, stage: 'confirm'});
      } else if (result.suggestion) {
        setConfirmationFlow(null);
        announce('สร้างคำแนะนำแล้ว', result.suggestion.explanation);
      } else if (result.message) { setConfirmationFlow(null); announce('Adaptive Scheduling', result.message, 'error'); }
      else if (result.intent.intent === 'productivity') { setConfirmationFlow(null); announce('สรุปประสิทธิภาพ', 'อัปเดตข้อมูลด้านล่างแล้ว'); }
      else { setConfirmationFlow(null); announce('ต้องการข้อมูลเพิ่ม', 'ลองระบุชื่องาน ระยะเวลา หรือวันที่ต้องเสร็จให้ชัดขึ้น', 'error'); }
      await load();
    } catch (error) { setConfirmationFlow({error: errorMessage(error), proposal: null, stage: 'error'}); }
    finally { commandInFlightRef.current = false; setBusy(''); }
  }, [announce, command, dashboard, load]);

  const submitAlternative = useCallback((suggestion: AdaptiveSuggestion) => {
    const timeZone = resolveTimeZone(suggestion.generatedForTimeZone, dashboard?.preferences.timeZone);
    const parsed = parseLocalInput(alternativeTime, timeZone);
    if (!parsed) return showToast('รูปแบบเวลาไม่ถูกต้อง', `ใช้รูปแบบ YYYY-MM-DD HH:mm ในเขตเวลา ${timeZone}`);
    void act(`alternative-${suggestion.id}`, () => adaptiveScheduling.chooseAlternative(suggestion.id, parsed), 'ตรวจสอบและเปลี่ยนเวลาที่เสนอแล้ว');
    setAlternativeId('');
  }, [act, alternativeTime, dashboard?.preferences.timeZone]);

  const workload = useMemo(() => dashboard?.dailyWorkload ?? [], [dashboard]);
  const filteredHistory = useMemo(() => (dashboard?.history ?? []).filter((item) => {
    if (historyFilter === 'all') return true;
    if (historyFilter === 'automatic') return item.automatic === true;
    if (historyFilter === 'errors') return item.syncStatus === 'failed';
    if (historyFilter === 'ai') return item.actor === 'adaptive_ai' || /suggestion|adaptive/i.test(item.source ?? '');
    return item.actor === 'user' && item.automatic !== true;
  }), [dashboard?.history, historyFilter]);

  return <UserShell active="smartlife_planner" onNavigate={onNavigate}>
    <AsyncActionOverlay
      cancelLabel={actionFeedback.status === 'confirming' ? 'ยังไม่บันทึก' : 'ปิด'}
      confirmLabel="บันทึก"
      errorMessage={actionFeedback.error}
      loadingMessage={actionFeedback.message}
      onCancel={() => {
        pendingPreferencePatchRef.current = null;
        setActionFeedback({message: '', status: 'idle', title: ''});
      }}
      onConfirm={() => {
        const patch = pendingPreferencePatchRef.current;
        pendingPreferencePatchRef.current = null;
        return patch ? act('preferences', () => adaptiveScheduling.updatePreferences(patch), 'บันทึกช่วงเวลาที่ชอบแล้ว') : undefined;
      }}
      onRequestClose={() => {
        pendingPreferencePatchRef.current = null;
        setActionFeedback({message: '', status: 'idle', title: ''});
      }}
      onRetry={actionFeedback.retryable ? () => {
        const retry = retryActionRef.current;
        return retry ? act(retry.key, retry.action, retry.success) : undefined;
      } : undefined}
      onSuccessAnimationComplete={() => setActionFeedback({message: '', status: 'idle', title: ''})}
      slowMessage="กำลังตรวจ conflict, กำหนดส่ง เวลาพัก และข้อมูล Firebase ล่าสุด…"
      status={actionFeedback.status}
      successMessage={actionFeedback.message}
      title={actionFeedback.title || 'Adaptive Scheduling'}
    />
    <View style={styles.page}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>SMARTLIFE PLANNER</Text><Text style={styles.title}>Adaptive Scheduling</Text><Text style={styles.subtitle}>แนะนำเวลาใหม่ด้วยกฎที่ตรวจสอบตารางจริงทุกครั้ง</Text></View><Touchable accessibilityRole="button" accessibilityState={{busy: loading, disabled: loading}} disabled={loading} onPress={() => void load()} style={[styles.iconButton, loading && styles.disabled]}>{loading ? <ActivityIndicator color="#557553" size="small" /> : <MaterialIcon color="#557553" name="refresh" size={20} />}</Touchable></View>
      {planner ? <PlannerTabs planner={planner} /> : null}
      <LinearGradient colors={['#ffffff', '#f4f8f0', '#f1f0f8']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.commandCard}><View style={styles.commandTitleRow}><View style={styles.commandIcon}><MaterialIcon color="#5b7e59" name="auto_awesome" size={19} /></View><View style={{flex: 1}}><Text style={styles.cardTitle}>สั่งงานด้วยภาษาธรรมชาติ</Text><Text style={styles.caption}>ไม่ต้องจำคำสั่ง พิมพ์สิ่งที่ต้องการได้ตามปกติ</Text></View></View><View style={styles.commandRow}><TextInput editable={!busy} multiline onChangeText={setCommand} placeholder="เช่น ช่วยหาช่วงอ่านหนังสือ 90 นาทีคืนนี้" placeholderTextColor="#98a097" style={styles.commandInput} value={command} /><Touchable accessibilityRole="button" accessibilityState={{busy: busy === 'command', disabled: Boolean(busy)}} disabled={Boolean(busy)} onPress={() => void submitCommand()} style={[styles.send, busy && styles.disabled]}>{busy === 'command' ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="arrow_upward" size={20} />}</Touchable></View></LinearGradient>
      {loading ? <View style={styles.loading}><ActivityIndicator color="#5f875f" /><Text style={styles.caption}>กำลังตรวจตารางและรูปแบบการใช้งาน</Text></View> : dashboard ? <>
        <Section title={`คำแนะนำที่รอยืนยัน (${dashboard.suggestions.length})`} subtitle="Suggestion Mode เป็นค่าเริ่มต้น ระบบจะไม่ย้ายงานเองจนกว่าคุณยืนยัน">
          {dashboard.suggestions.length ? dashboard.suggestions.map((suggestion) => <SuggestionCard
            alternativeId={alternativeId}
            alternativeTime={alternativeTime}
            busy={busy}
            key={suggestion.id}
            onAccept={() => void act(`accept-${suggestion.id}`, () => adaptiveScheduling.accept(suggestion.id), 'ปรับตารางแล้ว และสามารถย้อนกลับได้จากประวัติ')}
            onAlternative={() => { const timeZone = resolveTimeZone(suggestion.generatedForTimeZone, dashboard.preferences.timeZone); setAlternativeId(suggestion.id); setAlternativeTime(localInput(suggestion.suggestedStartAt, timeZone)); }}
            onAlternativeCancel={() => setAlternativeId('')}
            onAlternativeChange={setAlternativeTime}
            onAlternativeSubmit={() => submitAlternative(suggestion)}
            onLock={() => void act(`lock-${suggestion.id}`, () => adaptiveScheduling.lock(suggestion.scheduleItemId), 'ล็อกงานแล้ว ระบบจะไม่เสนอให้ย้ายอีก')}
            onPresetAlternative={(startAt) => void act(`alternative-${suggestion.id}`, () => adaptiveScheduling.chooseAlternative(suggestion.id, new Date(startAt)), 'ตรวจและอัปเดตเวลาทางเลือกแล้ว')}
            onReject={() => void act(`reject-${suggestion.id}`, () => adaptiveScheduling.reject(suggestion.id), 'เก็บคำตอบไว้เพื่อหลีกเลี่ยงคำแนะนำแบบเดิม')}
            suggestion={suggestion}
            timeZone={resolveTimeZone(suggestion.generatedForTimeZone, dashboard.preferences.timeZone)}
          />) : <Empty label="ยังไม่มีคำแนะนำใหม่ เพิ่มงานแบบยืดหยุ่นหรือใช้คำสั่งด้านบนได้" />}
        </Section>
        <Section title="ภาระงาน 7 วัน" subtitle={`รวม ${dashboard.weeklyWorkloadMinutes.toLocaleString('th-TH')} นาที`}><View style={styles.workloadGrid}>{workload.map((item) => <View key={item.date} style={[styles.workloadDay, item.highWorkload && styles.workloadHigh]}><Text style={styles.workloadDate}>{new Intl.DateTimeFormat('th-TH', {day: 'numeric', month: 'short'}).format(new Date(`${item.date}T12:00:00`))}</Text><Text style={styles.workloadMinutes}>{item.minutes} นาที</Text>{item.highWorkload ? <Text style={styles.risk}>ภาระสูง</Text> : null}</View>)}</View><View style={styles.actionRow}><SmallButton disabled={Boolean(busy)} label="ปรับวันพรุ่งนี้ให้เบาลง" loading={busy === 'day'} onPress={() => void act('day', () => adaptiveScheduling.rebalanceDay(), 'สร้างคำแนะนำสำหรับวันพรุ่งนี้แล้ว')} /><SmallButton disabled={Boolean(busy)} label="สมดุลทั้งสัปดาห์" loading={busy === 'week'} onPress={() => void act('week', () => adaptiveScheduling.rebalanceWeek(), 'ตรวจทั้งสัปดาห์และสร้างตัวเลือกที่ผ่านเงื่อนไขแล้ว')} /></View></Section>
        <Section title="รูปแบบที่เรียนรู้" subtitle="คำนวณแยกตามประเภทกิจกรรม และไม่สรุปแรงเกินไปเมื่อข้อมูลยังน้อย"><View style={styles.patternList}>{dashboard.patterns.length ? dashboard.patterns.map((pattern) => <PatternRow key={pattern.id} onDelete={() => setDeletingPatternId(pattern.id)} pattern={pattern} />) : <Empty label="ยังมีข้อมูลไม่ถึง 3 เหตุการณ์ต่อหมวด จึงยังไม่ตั้งรูปแบบถาวร" />}</View><SmallButton label="คำนวณรูปแบบใหม่ตอนนี้" onPress={() => void act('patterns', () => adaptiveScheduling.calculatePatterns(), 'คำนวณจากพฤติกรรมล่าสุดแล้ว')} /></Section>
        <Section title="Productivity Insights" subtitle="ตัวเลขมาจากข้อมูลที่คำนวณแล้ว ไม่ให้ Gemini เดา"><View style={styles.insightList}>{dashboard.insights.length ? dashboard.insights.map((item) => <View key={item.id} style={styles.insight}><MaterialIcon color="#617e60" name="lightbulb" size={18} /><View style={{flex: 1}}><Text style={styles.insightText}>{item.message}</Text><Text style={styles.meta}>อิงจาก {item.observationCount} เหตุการณ์</Text></View></View>) : <Empty label="ยังไม่มี insight จนกว่าจะมีพฤติกรรมเพียงพอ" />}</View></Section>
        <Section title="การตั้งค่าและความเป็นส่วนตัว" subtitle="ค่าที่คุณเลือกมีสิทธิ์เหนือรูปแบบที่ระบบเรียนรู้"><PreferenceControls busy={busy} onUpdate={updatePreference} preferences={dashboard.preferences} /><View style={styles.privacyActions}><SmallButton danger label="ลบประวัติพฤติกรรม" onPress={() => setDeletingHistory(true)} /></View></Section>
        <Section title="ประวัติการปรับตาราง" subtitle="บอกว่าใครเปลี่ยน เหตุผล เวลาเดิม/ใหม่ และสถานะการซิงก์"><View style={styles.historyFilters}>{([['all', 'ทั้งหมด'], ['user', 'ยืนยันโดยคุณ'], ['ai', 'คำแนะนำ AI'], ['automatic', 'อัตโนมัติ'], ['errors', 'ซิงก์ผิดพลาด']] as [HistoryFilter, string][]).map(([key, label]) => <Touchable accessibilityRole="button" accessibilityState={{selected: historyFilter === key}} key={key} onPress={() => setHistoryFilter(key)} style={[styles.historyFilter, historyFilter === key && styles.historyFilterActive]}><Text style={[styles.historyFilterText, historyFilter === key && styles.historyFilterTextActive]}>{label}</Text></Touchable>)}</View><View style={styles.historyList}>{filteredHistory.length ? filteredHistory.map((item) => <ActivityLogItem busy={busy} item={item} key={item.id} now={Math.max(loadedAt, clockNow)} onUndo={() => void act(`undo-${item.id}`, () => adaptiveScheduling.undo(item.id), 'คืนเวลาเดิมแล้ว')} />) : <Empty label={dashboard.history.length ? 'ไม่มีประวัติในตัวกรองนี้' : 'ยังไม่มีการเปลี่ยนตารางจากคำแนะนำ'} />}</View></Section>
      </> : null}
    </View>
    <ConfirmDialog
      confirmLabel="ลบ"
      message="ระบบจะเริ่มเรียนรู้หมวดนี้ใหม่จากประวัติที่ยังเหลืออยู่"
      onCancel={() => setDeletingPatternId('')}
      onConfirm={() => { const id = deletingPatternId; setDeletingPatternId(''); void act(`pattern-${id}`, () => adaptiveScheduling.deletePattern(id)); }}
      title="ลบรูปแบบนี้?"
      visible={Boolean(deletingPatternId)}
    />
    <ConfirmDialog
      confirmLabel="ลบ"
      message="เหตุการณ์และรูปแบบที่เรียนรู้จะถูกลบ แต่ตารางงานเดิมจะไม่ถูกลบ"
      onCancel={() => setDeletingHistory(false)}
      onConfirm={() => { setDeletingHistory(false); void act('delete-history', () => adaptiveScheduling.deleteBehaviorHistory(), 'ลบประวัติการเรียนรู้แล้ว'); }}
      title="ลบประวัติการเรียนรู้ทั้งหมด?"
      visible={deletingHistory}
    />
    <Modal animationType="fade" onRequestClose={() => confirmationFlow?.stage !== 'saving' && confirmationFlow?.stage !== 'analyzing' ? setConfirmationFlow(null) : undefined} transparent visible={Boolean(confirmationFlow) && confirmationFlow?.stage !== 'conflict'}>
      <View style={styles.flowOverlay}>
        <View style={styles.flowCard}>
          {confirmationFlow?.stage === 'analyzing' ? <FlowLoading icon="auto_awesome" label="กำลังตรวจช่วงว่างและเงื่อนไขในตาราง..." title="Adaptive AI กำลังวางแผน" /> : null}
          {confirmationFlow?.stage === 'saving' ? <FlowLoading icon="cloud_upload" label="กำลังตรวจสอบเวลาอีกครั้งและบันทึกผ่าน SmartLife backend" title="กำลังเพิ่มลงตาราง" /> : null}
          {confirmationFlow?.stage === 'confirm' && confirmationFlow.proposal ? <>
            <LinearGradient colors={['#eef7e9', '#ffffff']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.flowHero}>
              <View style={styles.flowHeroIcon}><MaterialIcon color="#527750" name="auto_awesome" size={25} /></View>
              <View style={{flex: 1}}><Text style={styles.flowEyebrow}>SMARTLIFE ADAPTIVE AI</Text><Text style={styles.flowTitle}>{confirmationFlow.proposal.unavailableRequest ? 'เวลาที่ขอไม่ว่าง' : 'พร้อมเพิ่มลงตาราง'}</Text></View>
            </LinearGradient>
            <Text style={styles.flowActivityTitle}>{confirmationFlow.proposal.title}</Text>
            {confirmationFlow.proposal.unavailableRequest ? <View style={styles.flowClashNotice}>
              <MaterialIcon color="#a3714f" name="event_busy" size={17} />
              <Text style={styles.flowClashText}>{confirmationFlow.proposal.unavailableRequest} ชนกับรายการในตาราง ลองช่วงนี้แทนได้ไหม</Text>
            </View> : null}
            <View style={styles.flowDetails}>
              <FlowDetail icon="calendar_month" label={confirmationFlow.proposal.unavailableRequest ? 'เวลาที่เสนอแทน' : 'วันและเวลา'} value={thaiDate(confirmationFlow.proposal.startAt, dashboard?.preferences.timeZone)} />
              <FlowDetail icon="timer" label="ระยะเวลา" value={`${confirmationFlow.proposal.durationMinutes} นาที`} />
              <FlowDetail icon="sync_alt" label="Adaptive" value="ย้ายเวลาได้เมื่อคุณอนุญาต" />
            </View>
            <Touchable onPress={() => setProposalEditorOpen((current) => !current)} style={styles.flowEditToggle}>
              <MaterialIcon color="#587957" name="edit_calendar" size={17} />
              <Text style={styles.flowEditToggleText}>{proposalEditorOpen ? 'ปิดการแก้ไข' : 'แก้ไขวัน เวลา และระยะเวลาเอง'}</Text>
              <MaterialIcon color="#7b8d78" name={proposalEditorOpen ? 'expand_less' : 'expand_more'} size={18} />
            </Touchable>
            {proposalEditorOpen ? <View style={styles.flowEditor}>
              <View style={styles.flowEditorRow}>
                <View style={styles.flowEditorFieldWide}><Text style={styles.flowEditorLabel}>วันที่</Text><PlainDateTimeField mode="date" onChangeText={setProposalDateDraft} placeholder="YYYY-MM-DD" placeholderTextColor="#9ba499" style={styles.flowEditorInput} value={proposalDateDraft} /></View>
                <View style={styles.flowEditorField}><Text style={styles.flowEditorLabel}>เวลา</Text><PlainDateTimeField mode="time" onChangeText={setProposalTimeDraft} placeholder="HH:mm" placeholderTextColor="#9ba499" style={styles.flowEditorInput} value={proposalTimeDraft} /></View>
                <View style={styles.flowEditorField}><Text style={styles.flowEditorLabel}>นาที</Text><TextInput keyboardType="number-pad" onChangeText={setProposalDurationDraft} placeholder="60" placeholderTextColor="#9ba499" style={styles.flowEditorInput} value={proposalDurationDraft} /></View>
              </View>
              <Text style={styles.flowEditorHint}>เวลาที่คุณกำหนดมีสิทธิ์เหนือคำแนะนำของ AI และจะถูกตรวจว่าไม่ชนตารางก่อนบันทึก</Text>
              {proposalEditorError ? <Text style={styles.flowEditorError}>{proposalEditorError}</Text> : null}
              <Touchable onPress={applyProposalEdits} style={styles.flowEditorApply}><MaterialIcon color="#ffffff" name="done" size={17} /><Text style={styles.flowEditorApplyText}>ใช้เวลานี้</Text></Touchable>
            </View> : null}
            <View style={styles.flowReason}><MaterialIcon color="#62805f" name="verified" size={18} /><Text style={styles.flowReasonText}>{confirmationFlow.proposal.explanation}</Text></View>
            <View style={styles.flowActions}>
              <Touchable onPress={() => setConfirmationFlow(null)} style={styles.flowSecondary}><Text style={styles.flowSecondaryText}>ยังไม่เพิ่ม</Text></Touchable>
              <Touchable onPress={() => void saveProposedActivity(confirmationFlow.proposal as AdaptiveProposedActivity, confirmationFlow.clientRequestId)} style={styles.flowPrimary}><MaterialIcon color="#fff" name="check" size={19} /><Text style={styles.flowPrimaryText}>ยืนยันเพิ่ม</Text></Touchable>
            </View>
          </> : null}
          {confirmationFlow?.stage === 'success' && confirmationFlow.proposal ? <View style={styles.flowCentered}>
            <Animated.View style={[styles.successBadge, {opacity: successProgress, transform: [{scale: successProgress}]}]}><MaterialIcon color="#ffffff" name="check" size={42} /></Animated.View>
            <Text style={styles.successTitle}>บันทึกลงตารางแล้ว</Text>
            <Text style={styles.successText}>“{confirmationFlow.proposal.title}”{confirmationFlow.adjusted ? ' ถูกปรับเป็นช่วงว่างล่าสุดที่ตรวจสอบแล้ว' : ' อยู่ในช่วงเวลาที่ตรวจสอบแล้ว'}{`\n${thaiDate(confirmationFlow.savedStartAt ?? confirmationFlow.proposal.startAt, dashboard?.preferences.timeZone)}`}</Text>
            <View style={styles.flowActions}>
              <Touchable onPress={() => setConfirmationFlow(null)} style={styles.flowSecondary}><Text style={styles.flowSecondaryText}>อยู่หน้านี้</Text></Touchable>
              <Touchable onPress={() => { setConfirmationFlow(null); onNavigate('smartlife_calendar_day'); }} style={styles.flowPrimary}><MaterialIcon color="#fff" name="calendar_month" size={19} /><Text style={styles.flowPrimaryText}>ดูตาราง</Text></Touchable>
            </View>
          </View> : null}
          {confirmationFlow?.stage === 'error' ? <View style={styles.flowCentered}>
            <View style={styles.errorBadge}><MaterialIcon color="#a45e58" name="error" size={32} /></View>
            <Text style={styles.errorTitle}>ยังบันทึกไม่สำเร็จ</Text>
            <Text style={styles.successText}>{confirmationFlow.error}</Text>
            <View style={styles.flowActions}>
              <Touchable onPress={() => setConfirmationFlow(null)} style={styles.flowSecondary}><Text style={styles.flowSecondaryText}>ปิด</Text></Touchable>
              {confirmationFlow.proposal ? <Touchable onPress={() => void saveProposedActivity(confirmationFlow.proposal as AdaptiveProposedActivity, confirmationFlow.clientRequestId)} style={styles.flowPrimary}><MaterialIcon color="#fff" name="refresh" size={19} /><Text style={styles.flowPrimaryText}>ลองอีกครั้ง</Text></Touchable> : null}
            </View>
          </View> : null}
        </View>
      </View>
    </Modal>
    <ScheduleConflictDialog
      conflicts={confirmationFlow?.conflicts ?? []}
      onConfirm={() => confirmationFlow?.proposal ? void saveProposedActivity({...confirmationFlow.proposal, allowOverlap: true}, confirmationFlow.clientRequestId) : undefined}
      onEdit={() => {
        if (!confirmationFlow?.proposal) return setConfirmationFlow(null);
        const timeZone = resolveTimeZone(confirmationFlow.proposal.generatedForTimeZone, dashboard?.preferences.timeZone);
        const [datePart = '', timePart = ''] = localInput(confirmationFlow.proposal.startAt, timeZone).split(' ');
        setProposalDateDraft(datePart);
        setProposalTimeDraft(timePart);
        setProposalDurationDraft(String(confirmationFlow.proposal.durationMinutes));
        setProposalEditorError('');
        setProposalEditorOpen(true);
        setConfirmationFlow({...confirmationFlow, stage: 'confirm'});
      }}
      proposedEndAt={confirmationFlow?.proposal?.endAt ?? confirmationFlow?.proposal?.startAt ?? new Date().toISOString()}
      proposedStartAt={confirmationFlow?.proposal?.startAt ?? new Date().toISOString()}
      saving={confirmationFlow?.stage === 'saving'}
      timeZone={confirmationFlow?.proposal?.generatedForTimeZone}
      visible={confirmationFlow?.stage === 'conflict'}
    />
  </UserShell>;
}

function FlowLoading({icon, label, title}: {icon: string; label: string; title: string}) {
  const [rotation] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(rotation, {duration: 950, easing: Easing.linear, toValue: 1, useNativeDriver: true}));
    loop.start();
    return () => loop.stop();
  }, [rotation]);
  return <View style={styles.flowCentered}><Animated.View style={[styles.loadingRing, {transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}]}]}><View style={styles.loadingRingInner}><MaterialIcon color="#5b7f59" name={icon} size={27} /></View></Animated.View><Text style={styles.flowTitle}>{title}</Text><Text style={styles.successText}>{label}</Text><View style={styles.progressTrack}><View style={styles.progressFill} /></View></View>;
}

function FlowDetail({icon, label, value}: {icon: string; label: string; value: string}) {
  return <View style={styles.flowDetail}><View style={styles.flowDetailIcon}><MaterialIcon color="#5c7c59" name={icon} size={18} /></View><View style={{flex: 1}}><Text style={styles.flowDetailLabel}>{label}</Text><Text style={styles.flowDetailValue}>{value}</Text></View></View>;
}

function PlannerTabs({planner}: {planner: Planner}) { return <View accessibilityRole="tablist" style={styles.tabs}>{PLANNER_TABS.map(([key, label]) => <Touchable accessibilityRole="tab" accessibilityState={{selected: planner.activeTab === key}} key={key} onPress={() => planner.onTabChange(key)} style={[styles.tab, planner.activeTab === key && styles.tabActive]}><Text style={[styles.tabText, planner.activeTab === key && styles.tabTextActive]}>{label}</Text></Touchable>)}</View>; }
function Section({children, subtitle, title}: {children: React.ReactNode; subtitle?: string; title: string}) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{subtitle ? <Text style={styles.caption}>{subtitle}</Text> : null}<View style={styles.sectionBody}>{children}</View></View>; }
function Empty({label}: {label: string}) { return <View style={styles.empty}><MaterialIcon color="#9aa399" name="event_busy" size={22} /><Text style={styles.emptyText}>{label}</Text></View>; }
function SmallButton({danger = false, disabled = false, label, loading = false, onPress}: {danger?: boolean; disabled?: boolean; label: string; loading?: boolean; onPress: () => void}) { return <Touchable accessibilityRole="button" accessibilityState={{busy: loading, disabled: disabled || loading}} disabled={disabled || loading} onPress={onPress} style={({pressed}) => [styles.smallButton, danger && styles.smallButtonDanger, (disabled || loading) && styles.disabled, pressed && !disabled && !loading && styles.buttonPressed]}>{loading ? <ActivityIndicator color={danger ? '#a75f59' : '#597358'} size="small" /> : null}<Text style={[styles.smallButtonText, danger && styles.smallButtonDangerText]}>{loading ? 'กำลังตรวจ…' : label}</Text></Touchable>; }

function SuggestionCard({alternativeId, alternativeTime, busy, onAccept, onAlternative, onAlternativeCancel, onAlternativeChange, onAlternativeSubmit, onLock, onPresetAlternative, onReject, suggestion, timeZone}: {alternativeId: string; alternativeTime: string; busy: string; onAccept: () => void; onAlternative: () => void; onAlternativeCancel: () => void; onAlternativeChange: (value: string) => void; onAlternativeSubmit: () => void; onLock: () => void; onPresetAlternative: (startAt: string) => void; onReject: () => void; suggestion: AdaptiveSuggestion; timeZone: string}) {
  const disabled = Boolean(busy);
  // The stored value stays a single "YYYY-MM-DD HH:mm" string so the existing
  // parsing and validation are untouched; only the entry is split in two.
  const [alternativeDay = '', alternativeClock = ''] = alternativeTime.split(' ');
  return <LinearGradient colors={['#ffffff', '#f7faf4', '#f3f1f9']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.suggestion}>
    <View style={styles.suggestionHead}><View style={styles.category}><Text style={styles.categoryText}>{categoryLabels[suggestion.activityCategory] ?? suggestion.activityCategory}</Text></View><View style={styles.confidenceBadge}><MaterialIcon color="#5e7f5b" name="verified" size={13} /><Text style={styles.confidence}>{confidenceLabel(suggestion.confidence)} · {Math.round(suggestion.confidence * 100)}%</Text></View></View>
    <Text style={styles.suggestionTitle}>{suggestion.taskTitle}</Text>
    <View style={styles.timeChange}><View style={{flex: 1}}><Text style={styles.timeLabel}>ก่อนปรับ</Text><Text style={styles.timeValue}>{thaiDate(suggestion.originalStartAt, timeZone)}</Text></View><View style={styles.arrowBadge}><MaterialIcon color="#668766" name="arrow_forward" size={18} /></View><View style={{flex: 1}}><Text style={styles.timeLabel}>เวลาที่แนะนำ</Text><Text style={styles.timeValue}>{thaiDate(suggestion.suggestedStartAt, timeZone)}</Text></View></View>
    <View style={styles.reasonCard}><MaterialIcon color="#6a8467" name="lightbulb" size={17} /><Text style={styles.explanation}>{suggestion.explanation}</Text></View>
    <Text style={styles.benefit}>ผลที่คาดหวัง: {suggestion.expectedBenefit}</Text>
    {suggestion.alternativeOptions?.length ? <View style={styles.optionList}><Text style={styles.optionHeading}>ตัวเลือกอื่นที่ผ่านการตรวจแล้ว</Text>{suggestion.alternativeOptions.map((option) => <Touchable accessibilityRole="button" disabled={disabled} key={`${suggestion.id}-${option.startAt}`} onPress={() => onPresetAlternative(option.startAt)} style={({pressed}) => [styles.option, pressed && styles.buttonPressed, disabled && styles.disabled]}><View style={{flex: 1}}><Text style={styles.optionLabel}>{option.label}</Text><Text style={styles.optionTime}>{thaiDate(option.startAt, timeZone)}</Text><Text style={styles.optionTradeoff}>{option.tradeoff}</Text></View><MaterialIcon color="#668566" name="chevron_right" size={19} /></Touchable>)}</View> : null}
    <View style={styles.freshnessRow}><MaterialIcon color="#7e8d7c" name="schedule" size={13} /><Text style={styles.meta}>ใช้ได้ถึง {thaiDate(suggestion.validUntil ?? suggestion.expiresAt, timeZone)} · ตรวจ conflict, กำหนดส่ง, เวลานอน และภาระงานแล้ว</Text></View>
    {alternativeId === suggestion.id ? <View style={styles.alternative}><Text style={styles.optionHeading}>กำหนดเวลาเอง</Text><Text style={styles.optionTime}>เขตเวลา: {timeZone}</Text><View style={styles.alternativeRow}><PlainDateTimeField editable={!disabled} mode="date" onChangeText={(value) => onAlternativeChange(`${value} ${alternativeClock}`.trim())} placeholder="YYYY-MM-DD" style={[styles.alternativeInput, styles.alternativeDate]} value={alternativeDay} /><PlainDateTimeField editable={!disabled} mode="time" onChangeText={(value) => onAlternativeChange(`${alternativeDay} ${value}`.trim())} placeholder="HH:mm" style={[styles.alternativeInput, styles.alternativeClock]} value={alternativeClock} /></View><View style={styles.actionRow}><SmallButton disabled={disabled} label="ตรวจเวลานี้" onPress={onAlternativeSubmit} /><SmallButton disabled={disabled} label="ยกเลิก" onPress={onAlternativeCancel} /></View></View> : null}
    <View style={styles.actions}><Touchable accessibilityRole="button" disabled={disabled} onPress={onAccept} style={({pressed}) => [styles.primaryAction, disabled && styles.disabled, pressed && !disabled && styles.buttonPressed]}>{busy === `accept-${suggestion.id}` ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={17} />}<Text style={styles.primaryActionText}>ยืนยันใช้เวลานี้</Text></Touchable><Touchable accessibilityRole="button" disabled={disabled} onPress={onReject} style={({pressed}) => [styles.secondaryAction, disabled && styles.disabled, pressed && !disabled && styles.buttonPressed]}><Text style={styles.secondaryActionText}>ไม่ใช้คำแนะนำ</Text></Touchable></View>
    <View style={styles.actionRow}><SmallButton disabled={disabled} label="เลือกเวลาเอง" onPress={onAlternative} /><SmallButton disabled={disabled} label="ล็อกงานนี้" onPress={onLock} /></View>
  </LinearGradient>;
}

function ActivityLogItem({busy, item, now, onUndo}: {busy: string; item: AdaptiveHistory; now: number; onUndo: () => void}) {
  const actorLabel = item.actor === 'adaptive_ai' || item.automatic ? 'Adaptive AI' : 'ยืนยันโดยคุณ';
  const syncLabel = item.syncStatus === 'pending' ? 'รอซิงก์' : item.syncStatus === 'failed' ? 'ซิงก์ไม่สำเร็จ' : item.syncStatus === 'synced' ? 'ซิงก์แล้ว' : 'บันทึกใน SmartLife';
  const canUndo = item.status === 'applied' && new Date(item.canUndoUntil).getTime() > now;
  return <LinearGradient colors={['#fbfcf9', '#f2f7ee']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.history}>
    <View style={styles.historyTimeline}><View style={styles.historyDot}><MaterialIcon color="#fff" name={item.status === 'undone' ? 'undo' : 'auto_awesome'} size={15} /></View><View style={styles.historyLine} /></View>
    <View style={{flex: 1}}>
      <View style={styles.historyHeader}><Text style={styles.historyTitle}>{item.taskTitle || item.actionLabel || 'ปรับเวลางาน'}</Text><View style={[styles.syncBadge, item.syncStatus === 'failed' && styles.syncBadgeError]}><Text style={[styles.syncText, item.syncStatus === 'failed' && styles.syncTextError]}>{syncLabel}</Text></View></View>
      <Text style={styles.historyActor}>{actorLabel} · {thaiDate(item.createdAt, item.timeZone)}</Text>
      <View style={styles.historyChange}><View style={{flex: 1}}><Text style={styles.timeLabel}>เวลาเดิม</Text><Text style={styles.historyTime}>{thaiDate(item.previousStartAt, item.timeZone)}</Text></View><MaterialIcon color="#7b9279" name="arrow_forward" size={16} /><View style={{flex: 1}}><Text style={styles.timeLabel}>{item.status === 'undone' ? 'ย้อนกลับแล้ว' : 'เวลาใหม่'}</Text><Text style={styles.historyTime}>{thaiDate(item.newStartAt, item.timeZone)}</Text></View></View>
      {item.reason ? <Text numberOfLines={3} style={styles.historyReason}>{item.reason}</Text> : null}
      {canUndo ? <View style={styles.historyAction}><SmallButton disabled={Boolean(busy)} loading={busy === `undo-${item.id}`} label="ย้อนกลับการเปลี่ยนนี้" onPress={onUndo} /></View> : null}
    </View>
  </LinearGradient>;
}

function PatternRow({onDelete, pattern}: {onDelete: () => void; pattern: AdaptivePattern}) { return <View style={styles.pattern}><View style={{flex: 1}}><Text style={styles.patternTitle}>{categoryLabels[pattern.activityCategory] ?? pattern.activityCategory} · {String(pattern.preferredStartHour).padStart(2, '0')}:00–{String(pattern.preferredEndHour).padStart(2, '0')}:00</Text><Text style={styles.meta}>สำเร็จ {Math.round(pattern.completionRate * 100)}% · เลื่อน {Math.round(pattern.postponementRate * 100)}% · {pattern.observationCount} ครั้ง</Text><Text style={styles.confidence}>{pattern.confidenceLevel === 'insufficient' ? 'ข้อมูลยังไม่พอ' : confidenceLabel(pattern.confidenceScore)}</Text></View><Touchable accessibilityLabel="ลบรูปแบบ" onPress={onDelete} style={styles.deleteIcon}><MaterialIcon color="#b36b65" name="delete" size={18} /></Touchable></View>; }

function PreferenceControls({busy, onUpdate, preferences}: {busy: string; onUpdate: (patch: Partial<AdaptivePreferences>, label?: string) => void; preferences: AdaptivePreferences}) {
  const rows: {key: keyof AdaptivePreferences; label: string; note: string}[] = [
    {key: 'allowAiSuggestions', label: 'คำแนะนำ Adaptive', note: 'ปิดแล้วระบบจะไม่สร้างคำแนะนำใหม่'},
    {key: 'allowAutomaticRescheduling', label: 'ปรับเวลาอัตโนมัติ', note: 'ปิดเป็นค่าเริ่มต้น และใช้เฉพาะงานที่อนุญาต'},
    {key: 'allowBehavioralPersonalization', label: 'เรียนรู้จากพฤติกรรม', note: 'ปิดเพื่อหยุดใช้ประวัติส่วนตัวในการให้คะแนน'},
    {key: 'allowGeminiInsights', label: 'คำอธิบายจาก Gemini', note: 'ปิดแล้วยังใช้ scheduling engine ได้ตามปกติ'},
    {key: 'notificationsEnabled', label: 'แจ้งเตือนการปรับตาราง', note: 'จำกัดเฉพาะเหตุการณ์สำคัญ'},
  ];
  return <View style={styles.preferenceList}>{rows.map((row) => <View key={row.key} style={styles.preference}><View style={{flex: 1}}><Text style={styles.preferenceTitle}>{row.label}</Text><Text style={styles.meta}>{row.note}</Text></View><Switch disabled={busy === 'preferences'} onValueChange={(value) => onUpdate({[row.key]: value})} thumbColor="#fff" trackColor={{false: '#d7ddd4', true: '#729071'}} value={Boolean(preferences[row.key])} /></View>)}<View style={styles.clockRow}><View style={{flex: 1}}><Text style={styles.preferenceTitle}>ช่วงตื่น</Text><Text style={styles.clockValue}>{preferences.wakeTime ?? 'ไม่กำหนด'}</Text></View><View style={{flex: 1}}><Text style={styles.preferenceTitle}>ช่วงนอน</Text><Text style={styles.clockValue}>{preferences.sleepTime ?? 'ไม่กำหนด'}</Text></View><View style={{flex: 1}}><Text style={styles.preferenceTitle}>พักขั้นต่ำ</Text><Text style={styles.clockValue}>{preferences.minimumBreakMinutes} นาที</Text></View></View></View>;
}

const styles = StyleSheet.create({
  historyFilter: {backgroundColor: '#eef3eb', borderColor: '#e0e8dc', borderRadius: 99, borderWidth: 1, minHeight: 34, paddingHorizontal: 10, paddingVertical: 7},
  historyFilterActive: {backgroundColor: '#5f815d', borderColor: '#5f815d'},
  historyFilters: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10},
  historyFilterText: {color: '#687a65', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  historyFilterTextActive: {color: '#ffffff'},
  errorBadge: {alignItems: 'center', backgroundColor: '#faece9', borderRadius: 28, height: 58, justifyContent: 'center', marginBottom: 13, width: 58},
  errorTitle: {color: '#7f4945', fontFamily: 'Prompt_800ExtraBold', fontSize: 19, marginBottom: 5, textAlign: 'center'},
  flowActions: {flexDirection: 'row', gap: 10, marginTop: 20, width: '100%'},
  flowActivityTitle: {color: '#2f3d2f', fontFamily: 'Prompt_800ExtraBold', fontSize: 19, lineHeight: 27, marginTop: 18},
  flowCard: {backgroundColor: '#ffffff', borderRadius: 28, boxShadow: '0 18px 50px rgba(31,45,29,.24)', maxWidth: 520, overflow: 'hidden', padding: 20, width: '100%'},
  flowCentered: {alignItems: 'center', paddingHorizontal: 4, paddingVertical: 12},
  flowDetail: {alignItems: 'center', borderBottomColor: '#e9eee5', borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 58, paddingVertical: 8},
  flowDetailIcon: {alignItems: 'center', backgroundColor: '#edf5e9', borderRadius: 13, height: 38, justifyContent: 'center', width: 38},
  flowDetailLabel: {color: '#8a9487', fontFamily: 'Prompt_500Medium', fontSize: 12},
  flowClashNotice: {alignItems: 'flex-start', backgroundColor: '#fbf1e9', borderRadius: 14, flexDirection: 'row', gap: 8, marginTop: 12, padding: 11}, flowClashText: {color: '#8a5f42', flex: 1, fontFamily: 'Prompt_600SemiBold', fontSize: 12, lineHeight: 18}, flowDetails: {backgroundColor: '#f8faf6', borderColor: '#e5ebe1', borderRadius: 18, borderWidth: 1, marginTop: 14, overflow: 'hidden', paddingHorizontal: 12},
  flowDetailValue: {color: '#3a4938', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2},
  flowEditor: {backgroundColor: '#f4f8f1', borderColor: '#dfe9db', borderRadius: 17, borderWidth: 1, marginTop: 9, padding: 11},
  flowEditorApply: {alignItems: 'center', alignSelf: 'flex-end', backgroundColor: '#5b8059', borderRadius: 12, flexDirection: 'row', gap: 5, justifyContent: 'center', marginTop: 9, minHeight: 38, paddingHorizontal: 14},
  flowEditorApplyText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  flowEditorField: {flex: .8},
  flowEditorFieldWide: {flex: 1.35},
  flowEditorError: {color: '#a75f59', fontFamily: 'Prompt_600SemiBold', fontSize: 12, lineHeight: 18, marginTop: 6}, flowEditorHint: {color: '#748171', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 8},
  flowEditorInput: {backgroundColor: '#ffffff', borderColor: '#dce5d8', borderRadius: 11, borderWidth: 1, color: '#354334', fontFamily: 'Prompt_600SemiBold', fontSize: 12, height: 40, marginTop: 4, paddingHorizontal: 9},
  flowEditorLabel: {color: '#71806f', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  flowEditorRow: {flexDirection: 'row', gap: 7},
  flowEditToggle: {alignItems: 'center', backgroundColor: '#f0f5ed', borderRadius: 14, flexDirection: 'row', gap: 7, marginTop: 10, minHeight: 42, paddingHorizontal: 11},
  flowEditToggleText: {color: '#587257', flex: 1, fontFamily: 'Prompt_700Bold', fontSize: 12},
  flowEyebrow: {color: '#668564', fontFamily: 'Prompt_700Bold', fontSize: 12, letterSpacing: 1},
  flowHero: {alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 11, padding: 13},
  flowHeroIcon: {alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 18, boxShadow: '0 4px 12px rgba(65,91,61,.12)', height: 46, justifyContent: 'center', width: 46},
  flowOverlay: {alignItems: 'center', backgroundColor: 'rgba(28,37,27,.58)', flex: 1, justifyContent: 'center', padding: 20},
  flowPrimary: {alignItems: 'center', backgroundColor: '#557d52', borderRadius: 16, boxShadow: '0 8px 18px rgba(74,111,71,.24)', flex: 1.35, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 52},
  flowPrimaryText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 13},
  flowReason: {alignItems: 'flex-start', backgroundColor: '#eff6eb', borderRadius: 15, flexDirection: 'row', gap: 8, marginTop: 13, padding: 11},
  flowReasonText: {color: '#596a56', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18},
  flowSecondary: {alignItems: 'center', backgroundColor: '#eef2eb', borderRadius: 16, flex: 1, justifyContent: 'center', minHeight: 52},
  flowSecondaryText: {color: '#61705e', fontFamily: 'Prompt_700Bold', fontSize: 12},
  flowTitle: {color: '#30402f', fontFamily: 'Prompt_800ExtraBold', fontSize: 19, marginTop: 8, textAlign: 'center'},
  loadingRing: {alignItems: 'center', borderColor: '#dcead7', borderRadius: 42, borderRightColor: '#5f865c', borderTopColor: '#5f865c', borderWidth: 4, height: 82, justifyContent: 'center', marginBottom: 12, width: 82},
  loadingRingInner: {alignItems: 'center', backgroundColor: '#f1f7ee', borderRadius: 31, height: 62, justifyContent: 'center', width: 62},
  progressFill: {backgroundColor: '#658a62', borderRadius: 99, height: '100%', width: '68%'},
  progressTrack: {backgroundColor: '#e6ede2', borderRadius: 99, height: 5, marginTop: 18, overflow: 'hidden', width: '74%'},
  successBadge: {alignItems: 'center', backgroundColor: '#5c8658', borderRadius: 38, boxShadow: '0 10px 24px rgba(72,117,67,.28)', height: 76, justifyContent: 'center', marginBottom: 12, width: 76},
  successText: {color: '#748071', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 5, textAlign: 'center'},
  successTitle: {color: '#30442f', fontFamily: 'Prompt_800ExtraBold', fontSize: 21, textAlign: 'center'},
  actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9}, actions: {flexDirection: 'row', gap: 8, marginTop: 15}, alternative: {backgroundColor: '#f4f7f1', borderRadius: 16, marginTop: 12, padding: 12}, alternativeClock: {flex: 1}, alternativeDate: {flex: 1.5}, alternativeInput: {backgroundColor: '#fff', borderColor: '#dfe6dc', borderRadius: 13, borderWidth: 1, color: '#334132', fontFamily: 'Prompt_500Medium', fontSize: 12, minHeight: 46, paddingHorizontal: 11}, alternativeRow: {flexDirection: 'row', gap: 8, marginTop: 6}, arrowBadge: {alignItems: 'center', backgroundColor: '#e5efe1', borderRadius: 20, height: 32, justifyContent: 'center', width: 32}, benefit: {color: '#557355', fontFamily: 'Prompt_600SemiBold', fontSize: 12, lineHeight: 18, marginTop: 9}, buttonPressed: {opacity: .84, transform: [{scale: .985}]}, caption: {color: '#7b8679', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 3}, cardTitle: {color: '#344234', fontFamily: 'Prompt_700Bold', fontSize: 12}, category: {backgroundColor: '#e6efe2', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5}, categoryText: {color: '#557653', fontFamily: 'Prompt_700Bold', fontSize: 12}, clockRow: {backgroundColor: '#f5f7f3', borderRadius: 13, flexDirection: 'row', gap: 8, marginTop: 9, padding: 11}, clockValue: {color: '#5b7459', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 3}, commandCard: {borderColor: 'rgba(255,255,255,.8)', borderRadius: 24, borderWidth: 1, boxShadow: '0 12px 28px rgba(43,57,40,.10)', marginTop: 13, padding: 16}, commandIcon: {alignItems: 'center', backgroundColor: '#e9f1e5', borderRadius: 16, height: 42, justifyContent: 'center', width: 42}, commandInput: {color: '#344134', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12, maxHeight: 92, minHeight: 48, paddingHorizontal: 11, paddingVertical: 8}, commandRow: {alignItems: 'flex-end', backgroundColor: 'rgba(255,255,255,.78)', borderColor: '#dfe7db', borderRadius: 17, borderWidth: 1, flexDirection: 'row', marginTop: 12, padding: 5}, commandTitleRow: {alignItems: 'center', flexDirection: 'row', gap: 10}, confidence: {color: '#60775e', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, confidenceBadge: {alignItems: 'center', backgroundColor: '#eef4eb', borderRadius: 99, flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 5}, deleteIcon: {alignItems: 'center', backgroundColor: '#f8ecea', borderRadius: 11, height: 44, justifyContent: 'center', width: 44}, disabled: {opacity: .55}, empty: {alignItems: 'center', gap: 6, padding: 18}, emptyText: {color: '#879185', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, textAlign: 'center'}, eyebrow: {color: '#628660', fontFamily: 'Prompt_700Bold', fontSize: 12}, explanation: {color: '#566254', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18}, freshnessRow: {alignItems: 'flex-start', flexDirection: 'row', gap: 5, marginTop: 10}, header: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, history: {alignItems: 'stretch', borderColor: '#e1e8de', borderRadius: 18, borderWidth: 1, flexDirection: 'row', gap: 10, overflow: 'hidden', padding: 13}, historyAction: {alignItems: 'flex-start', marginTop: 10}, historyActor: {color: '#82907f', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2}, historyChange: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.7)', borderRadius: 12, flexDirection: 'row', gap: 6, marginTop: 8, padding: 9}, historyDot: {alignItems: 'center', backgroundColor: '#62845f', borderRadius: 17, height: 34, justifyContent: 'center', width: 34}, historyHeader: {alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'space-between'}, historyLine: {backgroundColor: '#dbe7d7', flex: 1, marginHorizontal: 16, marginTop: 5, width: 2}, historyList: {gap: 9}, historyReason: {color: '#596857', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 8}, historyTime: {color: '#435341', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2}, historyTimeline: {alignItems: 'center', width: 34}, historyTitle: {color: '#384737', flex: 1, fontFamily: 'Prompt_700Bold', fontSize: 12}, iconButton: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, height: 44, justifyContent: 'center', width: 44}, insight: {alignItems: 'flex-start', backgroundColor: '#f3f7ef', borderRadius: 14, flexDirection: 'row', gap: 8, padding: 11}, insightList: {gap: 8}, insightText: {color: '#40503f', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18}, loading: {alignItems: 'center', gap: 8, paddingVertical: 38}, meta: {color: '#879085', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 3}, option: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.82)', borderColor: '#e0e8dc', borderRadius: 14, borderWidth: 1, flexDirection: 'row', marginTop: 7, minHeight: 58, paddingHorizontal: 11, paddingVertical: 8}, optionHeading: {color: '#566b54', fontFamily: 'Prompt_700Bold', fontSize: 12}, optionLabel: {color: '#3f513d', fontFamily: 'Prompt_700Bold', fontSize: 12}, optionList: {backgroundColor: 'rgba(239,245,235,.72)', borderRadius: 16, marginTop: 11, padding: 10}, optionTime: {color: '#5a7158', fontFamily: 'Prompt_600SemiBold', fontSize: 12, marginTop: 2}, optionTradeoff: {color: '#879185', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2}, page: {paddingBottom: 8}, pattern: {alignItems: 'center', backgroundColor: '#f6f8f4', borderRadius: 14, flexDirection: 'row', gap: 8, padding: 11}, patternList: {gap: 8}, patternTitle: {color: '#3e4c3d', fontFamily: 'Prompt_700Bold', fontSize: 12}, preference: {alignItems: 'center', borderBottomColor: '#e8ede5', borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 58, paddingVertical: 8}, preferenceList: {gap: 1}, preferenceTitle: {color: '#3f4c3e', fontFamily: 'Prompt_700Bold', fontSize: 12}, primaryAction: {alignItems: 'center', backgroundColor: '#5e835c', borderRadius: 14, flex: 1.2, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 50}, primaryActionText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12}, privacyActions: {marginTop: 10}, reasonCard: {alignItems: 'flex-start', backgroundColor: 'rgba(238,245,234,.82)', borderRadius: 14, flexDirection: 'row', gap: 8, marginTop: 11, padding: 10}, risk: {color: '#a35f58', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2}, secondaryAction: {alignItems: 'center', backgroundColor: '#edf1ea', borderRadius: 14, flex: 1, justifyContent: 'center', minHeight: 50}, secondaryActionText: {color: '#60725e', fontFamily: 'Prompt_700Bold', fontSize: 12}, section: {backgroundColor: '#fff', borderRadius: 22, boxShadow: '0 8px 22px rgba(43,57,40,.075)', marginTop: 13, padding: 14}, sectionBody: {marginTop: 10}, sectionTitle: {color: '#334133', fontFamily: 'Prompt_800ExtraBold', fontSize: 14}, send: {alignItems: 'center', backgroundColor: '#5f845d', borderRadius: 14, height: 42, justifyContent: 'center', width: 42}, smallButton: {alignItems: 'center', backgroundColor: '#eef3eb', borderRadius: 13, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 44, paddingHorizontal: 12}, smallButtonDanger: {backgroundColor: '#f8ecea'}, smallButtonDangerText: {color: '#a75f59'}, smallButtonText: {color: '#597358', fontFamily: 'Prompt_700Bold', fontSize: 12}, subtitle: {color: '#7c8779', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2}, suggestion: {borderColor: 'rgba(255,255,255,.9)', borderRadius: 22, borderWidth: 1, boxShadow: '0 9px 24px rgba(48,65,45,.09)', marginBottom: 11, overflow: 'hidden', padding: 14}, suggestionHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, suggestionTitle: {color: '#334033', fontFamily: 'Prompt_800ExtraBold', fontSize: 14, marginTop: 10}, syncBadge: {backgroundColor: '#e8f1e4', borderRadius: 99, paddingHorizontal: 7, paddingVertical: 3}, syncBadgeError: {backgroundColor: '#faeae7'}, syncText: {color: '#607b5d', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, syncTextError: {color: '#a35e58'}, tab: {alignItems: 'center', borderRadius: 11, flex: 1, paddingVertical: 8}, tabActive: {backgroundColor: '#fff'}, tabText: {color: '#7c887a', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, tabTextActive: {color: '#557755'}, tabs: {backgroundColor: '#e5ece1', borderRadius: 15, flexDirection: 'row', marginTop: 12, padding: 4}, timeChange: {alignItems: 'center', backgroundColor: 'rgba(239,245,235,.82)', borderRadius: 15, flexDirection: 'row', gap: 8, marginTop: 10, padding: 11}, timeLabel: {color: '#899287', fontFamily: 'Prompt_500Medium', fontSize: 12}, timeValue: {color: '#435341', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2}, title: {color: '#2f3d2f', fontFamily: 'Prompt_800ExtraBold', fontSize: 24}, workloadDate: {color: '#667464', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, workloadDay: {backgroundColor: '#f2f6ef', borderRadius: 12, minWidth: '22%', padding: 9}, workloadGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 7}, workloadHigh: {backgroundColor: '#faeeec'}, workloadMinutes: {color: '#354334', fontFamily: 'Prompt_800ExtraBold', fontSize: 12, marginTop: 3},
});
