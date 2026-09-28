/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {AsyncActionOverlay, type AsyncActionStatus} from '@/components/async-action-ui';
import NativeDateTimePicker from '@/components/date-time-picker';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  baselineNightHours,
  clearSleepBaseline,
  finishSleepLog,
  findOpenSleepLog,
  findStaleSleepLog,
  formatClockMinutes,
  loadSleepBaseline,
  parseClockMinutes,
  removeSleepLog,
  resolveStaleSleepLog,
  saveSleepBaseline,
  startSleepLog,
  type SleepBaseline,
  type StaleSleepLog,
} from '@/services/sleep-log';

const C = {pine: '#2c341b', sage: '#6f8f6d', dark: '#5f835f', night: '#5a3d82', nightSoft: '#eceef7', sageSoft: '#e5efe2', muted: '#81887d', danger: '#c96761'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

type Status = {kind: 'error' | 'info' | 'success'; text: string} | null;

/**
 * One-tap sleep logging plus the usual-window baseline. Both live in one card
 * because the distinction between them is the point: the buttons record what
 * actually happened, the window below states a habit, and the copy never lets
 * the second be read as the first.
 *
 * `variant` decides how much shows. The dashboard wants the buttons; the
 * profile page wants the window editor.
 */
export default function SleepLogCard({onLogged, uid, variant = 'full'}: {
  onLogged?: () => void;
  uid: string;
  variant?: 'baseline' | 'full' | 'log';
}) {
  const [baseline, setBaseline] = useState<SleepBaseline | null>(null);
  const [openNight, setOpenNight] = useState<{startedAt: Date | null} | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [bedtimeText, setBedtimeText] = useState('23:00');
  const [wakeText, setWakeText] = useState('07:00');
  const [timePickerTarget, setTimePickerTarget] = useState<'bedtime' | 'wake' | null>(null);
  const [editing, setEditing] = useState(false);
  // A session the user forgot to close. It is asked about rather than silently
  // dropped, so the night is either corrected and counted or cleanly discarded.
  const [stale, setStale] = useState<StaleSleepLog | null>(null);
  const [staleStatus, setStaleStatus] = useState<AsyncActionStatus>('idle');
  const [staleError, setStaleError] = useState('');

  const showLog = variant !== 'baseline';
  const showBaseline = variant !== 'log';

  const load = useCallback(async () => {
    setLoading(true);
    const [stored, open, forgotten] = await Promise.all([
      loadSleepBaseline(uid).catch(() => null),
      showLog ? findOpenSleepLog(uid).catch(() => null) : Promise.resolve(null),
      showLog ? findStaleSleepLog(uid).catch(() => null) : Promise.resolve(null),
    ]);
    setBaseline(stored);
    setStale(forgotten);
    setStaleStatus(forgotten ? 'confirming' : 'idle');
    if (stored) {
      setBedtimeText(formatClockMinutes(stored.bedtimeMinutes));
      setWakeText(formatClockMinutes(stored.wakeMinutes));
    }
    setOpenNight(open ? {startedAt: open.startAt?.toDate?.() ?? null} : null);
    setLoading(false);
  }, [showLog, uid]);

  useEffect(() => { void load(); }, [load]);

  const baselineHours = useMemo(() => baselineNightHours(baseline), [baseline]);
  const draftHours = useMemo(() => {
    const bedtimeMinutes = parseClockMinutes(bedtimeText);
    const wakeMinutes = parseClockMinutes(wakeText);
    return bedtimeMinutes === null || wakeMinutes === null ? null : baselineNightHours({bedtimeMinutes, wakeMinutes});
  }, [bedtimeText, wakeText]);

  const pickerValue = (value: string) => {
    const minutes = parseClockMinutes(value) ?? 0;
    const result = new Date();
    result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return result;
  };

  const selectBaselineTime = (selectedDate?: Date) => {
    if (!timePickerTarget || !selectedDate) {
      setTimePickerTarget(null);
      return;
    }
    const value = formatClockMinutes(selectedDate.getHours() * 60 + selectedDate.getMinutes());
    if (timePickerTarget === 'bedtime') setBedtimeText(value);
    else setWakeText(value);
    setTimePickerTarget(null);
  };

  const goToBed = async () => {
    if (busy) return;
    setBusy(true); setStatus(null);
    try {
      const result = await startSleepLog(uid, {baseline});
      await load();
      setStatus(result.alreadyOpen
        ? {kind: 'info', text: 'มีคืนที่ยังไม่ได้กดตื่นอยู่แล้ว จะใช้รายการเดิมต่อ'}
        : {kind: 'success', text: 'บันทึกเวลาเข้านอนแล้ว กดตื่นนอนตอนเช้าเพื่อปิดรายการ'});
      onLogged?.();
    } catch (error) {
      setStatus({kind: 'error', text: error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง'});
    } finally {
      setBusy(false);
    }
  };

  const wakeUp = async () => {
    if (busy) return;
    setBusy(true); setStatus(null);
    try {
      const result = await finishSleepLog(uid);
      await load();
      if (result.status === 'saved') setStatus({kind: 'success', text: `บันทึกการนอน ${result.hours} ชั่วโมงแล้ว ข้อมูลนี้จะถูกใช้ประเมินความเสี่ยงหมดไฟ`});
      else if (result.reason === 'too-short') setStatus({kind: 'info', text: 'ช่วงที่บันทึกสั้นกว่า 2 ชั่วโมง จึงยังไม่นับเป็นการนอนหนึ่งคืน'});
      else setStatus({kind: 'info', text: 'ยังไม่มีคืนที่เปิดค้างไว้ กดเข้านอนก่อนนะครับ'});
      onLogged?.();
    } catch (error) {
      setStatus({kind: 'error', text: error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง'});
    } finally {
      setBusy(false);
    }
  };

  const saveBaseline = async () => {
    const bedtimeMinutes = parseClockMinutes(bedtimeText);
    const wakeMinutes = parseClockMinutes(wakeText);
    if (bedtimeMinutes === null || wakeMinutes === null) {
      setStatus({kind: 'error', text: 'กรอกเวลาในรูปแบบ HH:MM เช่น 23:00'});
      return;
    }
    if (draftHours === null) {
      setStatus({kind: 'error', text: 'ช่วงเวลานอนต้องยาว 2-14 ชั่วโมง'});
      return;
    }
    setBusy(true); setStatus(null);
    try {
      const saved = await saveSleepBaseline(uid, {bedtimeMinutes, wakeMinutes});
      setBaseline(saved);
      setEditing(false);
      setStatus(saved.synced === false
        ? {kind: 'info', text: 'บันทึกไว้บนเครื่องนี้แล้ว แต่ยังซิงก์ขึ้นเซิร์ฟเวอร์ไม่สำเร็จ'}
        : {kind: 'success', text: `บันทึกช่วงนอนปกติ ${draftHours} ชั่วโมงแล้ว ระบบจะใช้เป็นค่าอ้างอิงเฉพาะคืนที่ไม่มีบันทึกจริง`});
      onLogged?.();
    } catch (error) {
      setStatus({kind: 'error', text: error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง'});
    } finally {
      setBusy(false);
    }
  };

  const removeBaseline = async () => {
    setBusy(true); setStatus(null);
    try {
      await clearSleepBaseline(uid);
      setBaseline(null);
      setEditing(false);
      setStatus({kind: 'info', text: 'ล้างช่วงนอนปกติแล้ว ระบบจะใช้เฉพาะการนอนที่บันทึกจริงเท่านั้น'});
      onLogged?.();
    } finally {
      setBusy(false);
    }
  };

  const keepStale = async () => {
    if (!stale) return;
    setStaleStatus('loading'); setStaleError('');
    try {
      await resolveStaleSleepLog(uid, stale.activityId, stale.suggestedWakeAt);
      setStale(null); setStaleStatus('idle');
      await load();
      setStatus({kind: 'success', text: 'บันทึกเวลาตื่นให้แล้ว คืนนั้นถูกนำไปคิดคะแนนตามปกติ'});
      onLogged?.();
    } catch (error) {
      setStaleStatus('error');
      setStaleError(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    }
  };

  const discardStale = async () => {
    if (!stale) return;
    setStaleStatus('loading'); setStaleError('');
    try {
      await removeSleepLog(uid, stale.activityId);
      setStale(null); setStaleStatus('idle');
      await load();
      setStatus({kind: 'info', text: 'ลบรายการที่ค้างไว้แล้ว จะไม่ถูกนำไปคิดคะแนน'});
      onLogged?.();
    } catch (error) {
      setStaleStatus('error');
      setStaleError(error instanceof Error ? error.message : 'ลบไม่สำเร็จ ลองใหม่อีกครั้ง');
    }
  };

  const staleClock = (value: Date) => formatClockMinutes(value.getHours() * 60 + value.getMinutes());

  if (loading) return <View style={styles.card}><ActivityIndicator color={C.night} size="small" /></View>;

  return <View style={styles.card}>
    <View style={styles.head}>
      <View style={styles.icon}><MaterialIcon color={C.night} name="bedtime" size={20} /></View>
      <View style={{flex: 1}}>
        <Text style={styles.title}>บันทึกการนอน</Text>
        <Text style={styles.subtitle}>ใช้ประเมินความเสี่ยงหมดไฟจากข้อมูลจริง ไม่ใช่การเดา</Text>
      </View>
    </View>

    {showLog ? <>
      {openNight ? <View style={styles.openRow}>
        <MaterialIcon color={C.night} name="nightlight" size={16} />
        <Text style={styles.openText}>
          กำลังนอนอยู่ เริ่ม {openNight.startedAt ? formatClockMinutes(openNight.startedAt.getHours() * 60 + openNight.startedAt.getMinutes()) : '-'} น. · ยังไม่นับเป็นหลักฐานจนกว่าจะกดตื่นนอน
        </Text>
      </View> : null}
      <View style={styles.actions}>
        <Touchable accessibilityLabel="บันทึกเวลาเข้านอน" disabled={busy || Boolean(openNight)} onPress={goToBed} style={({pressed}) => [styles.action, styles.bed, pressed && styles.pressed, (busy || Boolean(openNight)) && styles.disabled]}>
          <MaterialIcon color={C.night} name="bedtime" size={17} />
          <Text style={[styles.actionText, {color: C.night}]}>เข้านอน</Text>
        </Touchable>
        <Touchable accessibilityLabel="บันทึกเวลาตื่นนอน" disabled={busy || !openNight} onPress={wakeUp} style={({pressed}) => [styles.action, styles.wake, pressed && styles.pressed, (busy || !openNight) && styles.disabled]}>
          <MaterialIcon color={C.dark} name="wb_sunny" size={17} />
          <Text style={[styles.actionText, {color: C.dark}]}>ตื่นนอน</Text>
        </Touchable>
      </View>
    </> : null}

    {showBaseline ? <View style={showLog ? styles.baselineBlock : undefined}>
      <View style={styles.baselineHead}>
        <Text style={styles.baselineLabel}>ช่วงนอนปกติ (ค่าอ้างอิง)</Text>
        {baseline && !editing ? <Touchable onPress={() => setEditing(true)} style={({pressed}) => [pressed && styles.pressed]}><Text style={styles.link}>แก้ไข</Text></Touchable> : null}
      </View>
      {baseline && !editing ? <>
        <Text style={styles.baselineValue}>{formatClockMinutes(baseline.bedtimeMinutes)} - {formatClockMinutes(baseline.wakeMinutes)} น. ({baselineHours} ชั่วโมง)</Text>
        <Text style={styles.baselineNote}>เป็นค่าที่ตั้งเอง ไม่ใช่การนอนที่วัดได้ ระบบจะใช้ก็ต่อเมื่อคืนนั้นไม่มีบันทึกจริง และจะไม่ทำให้ระดับความครบของหลักฐานขึ้นเป็น &quot;ค่อนข้างครบ&quot;</Text>
        <Touchable disabled={busy} onPress={removeBaseline} style={({pressed}) => [pressed && styles.pressed]}><Text style={styles.clearLink}>ล้างค่าอ้างอิงนี้</Text></Touchable>
      </> : <>
        <View style={styles.fields}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>เข้านอน</Text>
            <Touchable
              accessibilityLabel={`เลือกเวลาเข้านอน ปัจจุบัน ${bedtimeText} น.`}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setTimePickerTarget('bedtime')}
              style={({pressed}) => [styles.timePickerButton, pressed && styles.pressed, busy && styles.disabled]}>
              <MaterialIcon color={C.night} name="bedtime" size={16} />
              <Text style={styles.timePickerValue}>{bedtimeText}</Text>
              <MaterialIcon color={C.muted} name="expand_more" size={18} />
            </Touchable>
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>ตื่นนอน</Text>
            <Touchable
              accessibilityLabel={`เลือกเวลาตื่นนอน ปัจจุบัน ${wakeText} น.`}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setTimePickerTarget('wake')}
              style={({pressed}) => [styles.timePickerButton, pressed && styles.pressed, busy && styles.disabled]}>
              <MaterialIcon color={C.sage} name="wb_sunny" size={16} />
              <Text style={styles.timePickerValue}>{wakeText}</Text>
              <MaterialIcon color={C.muted} name="expand_more" size={18} />
            </Touchable>
          </View>
        </View>
        {timePickerTarget ? <NativeDateTimePicker
          accentColor={C.dark}
          is24Hour
          mode="time"
          onDismiss={() => setTimePickerTarget(null)}
          onValueChange={(_, selectedDate) => selectBaselineTime(selectedDate)}
          presentation="dialog"
          value={pickerValue(timePickerTarget === 'bedtime' ? bedtimeText : wakeText)}
        /> : null}
        <Text style={styles.baselineNote}>{draftHours === null ? 'เลือกเวลาให้ได้ช่วงนอนยาว 2-14 ชั่วโมง' : `ได้ช่วงนอน ${draftHours} ชั่วโมงต่อคืน`}</Text>
        <Touchable disabled={busy} onPress={saveBaseline} style={({pressed}) => [styles.save, pressed && styles.pressed, busy && styles.disabled]}>
          <Text style={styles.saveText}>{busy ? 'กำลังบันทึก...' : 'บันทึกช่วงนอนปกติ'}</Text>
        </Touchable>
      </>}
    </View> : null}

    {status ? <View style={[styles.status, status.kind === 'error' && styles.statusError, status.kind === 'success' && styles.statusSuccess]}>
      <Text style={[styles.statusText, status.kind === 'error' && styles.statusTextError]}>{status.text}</Text>
    </View> : null}

    {/* Reuses the app's standard confirm/dismiss overlay rather than a bespoke
        dialog, so a forgotten night is repaired the same way every other
        two-way confirmation in the app works. */}
    <AsyncActionOverlay
      cancelLabel="ลบรายการนี้"
      confirmLabel="ใช่ ใช้เวลานี้"
      errorMessage={staleError}
      loadingMessage="กำลังบันทึก…"
      onCancel={() => { void discardStale(); }}
      onConfirm={keepStale}
      onRequestClose={() => setStaleStatus('idle')}
      status={staleStatus}
      title="ลืมกดตื่นนอนหรือเปล่า?"
      visible={Boolean(stale) && staleStatus !== 'idle'}
    >
      {stale ? <View style={styles.staleBody}>
        <Text style={styles.staleText}>
          ดูเหมือนคุณลืมกดตื่นนอนเมื่อคืน รายการนี้เปิดค้างมา {stale.openHours} ชั่วโมงแล้ว จึงยังไม่ถูกนำไปคิดคะแนน
        </Text>
        <View style={styles.staleRow}>
          <Text style={styles.staleLabel}>เข้านอน</Text>
          <Text style={styles.staleValue}>{staleClock(stale.startedAt)} น.</Text>
        </View>
        <View style={styles.staleRow}>
          <Text style={styles.staleLabel}>ตื่นนอน (ที่เราเดาให้)</Text>
          <Text style={styles.staleValue}>{staleClock(stale.suggestedWakeAt)} น.</Text>
        </View>
        <Text style={styles.staleHint}>
          ถ้าเวลานี้ถูกต้อง กด &quot;ใช่ ใช้เวลานี้&quot; แล้วคืนนั้นจะถูกนำไปคิดคะแนน ถ้าไม่ถูก กด &quot;ลบรายการนี้&quot; เพื่อทิ้งไป แล้วบันทึกใหม่ได้ตามปกติ
        </Text>
      </View> : null}
    </AsyncActionOverlay>
  </View>;
}

const styles = StyleSheet.create({
  action: {alignItems: 'center', borderRadius: 12, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 40},
  actionText: {fontFamily: F.s, fontSize: 12},
  actions: {flexDirection: 'row', gap: 9, marginTop: 12},
  baselineBlock: {borderTopColor: 'rgba(44,52,27,.09)', borderTopWidth: 1, marginTop: 14, paddingTop: 12},
  baselineHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  baselineLabel: {color: '#4d5948', fontFamily: F.s, fontSize: 12},
  baselineNote: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 4},
  baselineValue: {color: C.pine, fontFamily: F.b, fontSize: 13, marginTop: 4},
  bed: {backgroundColor: C.nightSoft},
  card: {backgroundColor: '#fff', borderColor: 'rgba(92,102,153,.18)', borderRadius: 17, borderWidth: 1, marginBottom: 15, padding: 14},
  clearLink: {color: C.danger, fontFamily: F.s, fontSize: 12, marginTop: 8},
  disabled: {opacity: .45},
  field: {flex: 1},
  fieldLabel: {color: C.muted, fontFamily: F.m, fontSize: 12, marginBottom: 4},
  fields: {flexDirection: 'row', gap: 9, marginTop: 8},
  head: {alignItems: 'center', flexDirection: 'row', gap: 10},
  icon: {alignItems: 'center', backgroundColor: C.nightSoft, borderRadius: 13, height: 40, justifyContent: 'center', width: 40},
  link: {color: C.dark, fontFamily: F.s, fontSize: 12},
  openRow: {alignItems: 'center', backgroundColor: C.nightSoft, borderRadius: 11, flexDirection: 'row', gap: 7, marginTop: 11, padding: 9},
  openText: {color: '#4a5175', flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  pressed: {opacity: .82},
  save: {alignItems: 'center', backgroundColor: C.dark, borderRadius: 12, justifyContent: 'center', marginTop: 10, minHeight: 44},
  saveText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  staleBody: {gap: 7, marginTop: 4},
  staleHint: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2},
  staleLabel: {color: C.muted, fontFamily: F.m, fontSize: 12},
  staleRow: {alignItems: 'center', backgroundColor: C.nightSoft, borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 11, paddingVertical: 8},
  staleText: {color: C.pine, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  staleValue: {color: C.pine, fontFamily: F.b, fontSize: 12},
  status: {backgroundColor: '#f1f4ee', borderRadius: 11, marginTop: 11, padding: 9},
  statusError: {backgroundColor: '#fbeceb'},
  statusSuccess: {backgroundColor: '#eaf3e7'},
  statusText: {color: '#4d5948', fontFamily: F.m, fontSize: 12, lineHeight: 18},
  statusTextError: {color: C.danger},
  subtitle: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1},
  title: {color: C.pine, fontFamily: F.b, fontSize: 14},
  timePickerButton: {alignItems: 'center', backgroundColor: '#f8faf5', borderColor: 'rgba(44,52,27,.12)', borderRadius: 11, borderWidth: 1, flexDirection: 'row', gap: 7, minHeight: 44, paddingHorizontal: 11},
  timePickerValue: {color: C.pine, flex: 1, fontFamily: F.s, fontSize: 13},
  wake: {backgroundColor: C.sageSoft},
});
