import {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Platform, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import LoadingAndSuccessModal, {type FeedbackPhase} from '@/components/loading-success-modal';
import {
  disconnectGoogleCalendar,
  googleCalendarErrorMessage,
  preloadGoogleCalendarAuth,
  syncGoogleCalendar,
  watchGoogleCalendarConnection,
  type GoogleCalendarConnection,
  type GoogleCalendarSyncResult,
} from '@/services/google-calendar';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {showToast} from '@/components/app-toast';
import ConfirmDialog from '@/components/confirm-dialog';

type Feedback = {phase: FeedbackPhase; subtitle: string; title: string} | null;

export default function GoogleCalendarSyncCard({onSynced, uid}: {onSynced: () => Promise<void> | void; uid: string}) {
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [result, setResult] = useState<GoogleCalendarSyncResult | null>(null);
  const [connection, setConnection] = useState<GoogleCalendarConnection | null>(null);
  const [syncError, setSyncError] = useState('');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    preloadGoogleCalendarAuth().catch((error) => console.warn('[Google Calendar] OAuth preload skipped', error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => watchGoogleCalendarConnection(uid, setConnection, (error) => {
    console.warn('[Google Calendar] Unable to watch connection', error.message);
    setSyncError(error.message);
  }), [uid]);

  const connected = Boolean(connection || result);
  const connectedEmail = result?.email ?? connection?.email;

  const runDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setSyncError('');
    try {
      await disconnectGoogleCalendar(uid);
      setConnection(null);
      setResult(null);
      setFeedback({phase: 'success', subtitle: 'บัญชี Google Calendar ถูกนำออกจาก SmartLife แล้ว', title: 'ยกเลิกการเชื่อมแล้ว'});
      feedbackTimer.current = setTimeout(() => setFeedback(null), 1200);
    } catch (error) {
      const message = googleCalendarErrorMessage(error);
      setSyncError(message);
    } finally {
      setBusy(false);
    }
  };

  // One dialog on every platform. This used to branch: `Alert.alert` on native,
  // and the browser's own blocking `window.confirm` on web, because
  // `Alert.alert` is an empty function there. `ConfirmDialog` renders the same
  // sheet everywhere, so the wording and the styling no longer depend on where
  // the app is running.
  const confirmDisconnect = () => setDisconnectOpen(true);

  const sync = async () => {
    if (busy) return;
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setSyncError('');
    setBusy(true);
    setFeedback({phase: 'loading', subtitle: 'กำลังตรวจสอบกิจกรรมทั้ง SmartLife และ Google', title: 'กำลังซิงก์ปฏิทิน'});
    try {
      const next = await syncGoogleCalendar(uid);
      setResult(next);
      await onSynced();
      setFeedback({phase: 'success', subtitle: `ดึงเข้า ${next.pulled} รายการ • ส่งออก ${next.pushed} ชุดวิชา`, title: 'ซิงก์สำเร็จ'});
      feedbackTimer.current = setTimeout(() => setFeedback(null), 1350);
    } catch (error) {
      setFeedback(null);
      const message = googleCalendarErrorMessage(error);
      console.warn('[Google Calendar] Sync failed', {message});
      setSyncError(message);
      if (Platform.OS !== 'web') showToast('ซิงก์ Google Calendar ไม่สำเร็จ', message);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <LinearGradient colors={['#769675', '#8ca68d', '#9297bb']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.card}>
      <View style={styles.light} />
      <View style={styles.head}>
        <View style={styles.googleMark}><Text style={styles.googleLetter}>G</Text></View>
        <View style={styles.titleWrap}>
          <Text style={styles.eyebrow}>TWO-WAY SYNC</Text>
          <Text style={styles.title}>Google Calendar</Text>
          <Text numberOfLines={1} style={styles.account}>{connectedEmail ?? 'ตาราง SmartLife และ Google ในที่เดียว'}</Text>
        </View>
        {connected ? <View style={styles.connected}><View style={styles.connectedDot} /><Text style={styles.connectedText}>เชื่อมแล้ว</Text></View> : null}
      </View>

      {result ? <View style={styles.stats}>
        <View style={styles.stat}><MaterialIcon color="#426140" name="download" size={16} /><Text style={styles.statNumber}>{result.pulled}</Text><Text style={styles.statLabel}>ดึงเข้า</Text></View>
        <View style={styles.divider} />
        <View style={styles.stat}><MaterialIcon color="#575d8b" name="upload" size={16} /><Text style={styles.statNumber}>{result.pushed}</Text><Text style={styles.statLabel}>ส่งออก</Text></View>
        <View style={styles.divider} />
        <View style={styles.stat}><MaterialIcon color="#426140" name="event_repeat" size={16} /><Text style={styles.statNumber}>UTC+7</Text><Text style={styles.statLabel}>เวลาไทย</Text></View>
      </View> : <Text style={styles.description}>ดึงนัดหมายจาก Google เข้ามา และส่งตารางเรียนขึ้นเป็นกิจกรรมรายสัปดาห์ตลอดภาคเรียน</Text>}

      {result?.recentTitles.length ? <View style={styles.recent}><MaterialIcon color="rgba(255,255,255,.9)" name="event_available" size={15} /><Text numberOfLines={1} style={styles.recentText}>ล่าสุด: {result.recentTitles.join(' • ')}</Text></View> : null}

      {syncError ? <View accessibilityLiveRegion="polite" style={styles.errorBox}><MaterialIcon color="#9b4f52" name="error" size={16} /><Text style={styles.errorText}>{syncError}</Text></View> : null}

      <Touchable accessibilityLabel="ซิงก์กับ Google Calendar" accessibilityRole="button" accessibilityState={{busy, disabled: busy}} disabled={busy} onPress={sync} style={({pressed}) => [styles.button, pressed && !busy && styles.pressed]}>
        <LinearGradient colors={['rgba(255,255,255,.98)', 'rgba(247,248,252,.94)']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.buttonGradient}>
          {busy ? <ActivityIndicator color="#5d805c" size="small" /> : <MaterialIcon color="#5d805c" name={connected ? 'sync' : 'link'} size={20} />}
          <Text style={styles.buttonText}>{busy ? 'กำลังดำเนินการ...' : connected ? 'ซิงก์อีกครั้ง' : 'เชื่อมและซิงก์ Google Calendar'}</Text>
          {!busy ? <MaterialIcon color="#7b8278" name="arrow_forward" size={18} /> : null}
        </LinearGradient>
      </Touchable>
      {connected ? <Touchable accessibilityLabel="ยกเลิกการเชื่อม Google Calendar" accessibilityRole="button" disabled={busy} onPress={confirmDisconnect} style={({pressed}) => [styles.disconnect, pressed && !busy && styles.pressed]}>
        <MaterialIcon color="rgba(255,255,255,.9)" name="link_off" size={15} />
        <Text style={styles.disconnectText}>ยกเลิกการเชื่อม</Text>
      </Touchable> : null}
    </LinearGradient>
    <LoadingAndSuccessModal phase={feedback?.phase ?? 'loading'} subtitle={feedback?.subtitle ?? ''} title={feedback?.title ?? ''} visible={Boolean(feedback)} />
    <ConfirmDialog
      cancelLabel="เก็บการเชื่อมไว้"
      confirmLabel="ยกเลิกการเชื่อม"
      icon="link_off"
      message="ตารางที่นำเข้าแล้วจะยังอยู่ แต่ SmartLife จะหยุดซิงก์กับบัญชีนี้"
      onCancel={() => setDisconnectOpen(false)}
      onConfirm={() => { setDisconnectOpen(false); void runDisconnect(); }}
      title="ยกเลิกการเชื่อม Google Calendar?"
      visible={disconnectOpen}
    />
  </>;
}

const shadow = {shadowColor: '#25331f', shadowOffset: {height: 12, width: 0}, shadowOpacity: .17, shadowRadius: 24};
const styles = StyleSheet.create({
  account: {color: 'rgba(255,255,255,.79)', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1},
  button: {borderRadius: 14, marginTop: 13, overflow: 'hidden'},
  buttonGradient: {alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48, paddingHorizontal: 13},
  buttonText: {color: '#3e543c', flex: 1, fontFamily: 'Prompt_700Bold', fontSize: 12, textAlign: 'center'},
  card: {...shadow, borderColor: 'rgba(255,255,255,.58)', borderRadius: 20, borderWidth: 1, marginTop: 16, overflow: 'hidden', padding: 16},
  connected: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.17)', borderRadius: 12, flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 5},
  connectedDot: {backgroundColor: '#dff5d7', borderRadius: 4, height: 7, width: 7},
  connectedText: {color: '#fff', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  description: {color: 'rgba(255,255,255,.88)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 12},
  disconnect: {alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 5, marginTop: 11, paddingHorizontal: 12, paddingVertical: 5},
  disconnectText: {color: 'rgba(255,255,255,.9)', fontFamily: 'Prompt_600SemiBold', fontSize: 12, textDecorationLine: 'underline'},
  divider: {backgroundColor: 'rgba(255,255,255,.24)', height: 24, width: 1},
  eyebrow: {color: 'rgba(255,255,255,.7)', fontFamily: 'Prompt_700Bold', fontSize: 12},
  errorBox: {alignItems: 'flex-start', backgroundColor: 'rgba(255,241,239,.94)', borderColor: 'rgba(155,79,82,.2)', borderRadius: 11, borderWidth: 1, flexDirection: 'row', gap: 7, marginTop: 10, padding: 9},
  errorText: {color: '#87484b', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18},
  googleLetter: {color: '#5d805c', fontFamily: 'Prompt_800ExtraBold', fontSize: 19},
  googleMark: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, height: 46, justifyContent: 'center', shadowColor: '#2c341b', shadowOffset: {height: 5, width: 0}, shadowOpacity: .16, shadowRadius: 9, width: 46},
  head: {alignItems: 'center', flexDirection: 'row', gap: 10},
  light: {backgroundColor: 'rgba(255,255,255,.13)', borderRadius: 90, height: 150, position: 'absolute', right: -50, top: -76, width: 150},
  pressed: {opacity: .82, transform: [{scale: .985}]},
  recent: {alignItems: 'center', backgroundColor: 'rgba(35,53,31,.13)', borderRadius: 10, flexDirection: 'row', gap: 6, marginTop: 10, paddingHorizontal: 10, paddingVertical: 8},
  recentText: {color: 'rgba(255,255,255,.88)', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12},
  stat: {alignItems: 'center', flex: 1, gap: 1},
  statLabel: {color: 'rgba(255,255,255,.72)', fontFamily: 'Prompt_400Regular', fontSize: 12},
  statNumber: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  stats: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.12)', borderRadius: 13, flexDirection: 'row', marginTop: 13, paddingVertical: 9},
  title: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 15},
  titleWrap: {flex: 1},
});
