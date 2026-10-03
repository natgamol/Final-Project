/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {Touchable} from '@/components/touchable';
import {AuroraGradient, Sheen} from '@/components/color-motion';
import {LinearGradient} from 'expo-linear-gradient';

import SleepLogCard from '@/components/sleep-log-card';
import {useTour} from '@/providers/tour-provider';
import {loadLegacyPageData, runLegacyDataAction} from '@/services/legacy-data';
import {updateProfileDetails} from '@/services/auth';
import {uploadUserImage} from '@/services/storage';
import {Card, LoadingBlock, MaterialIcon, UserShell, type UserNavigate} from './user-ui';
import {showToast} from '@/components/app-toast';
import ConfirmDialog from '@/components/confirm-dialog';

// `avatarUrl` is not new data: `userProfile()` returns the whole users/{uid}
// document, so it was already arriving here and only lacked a declaration.
type Profile = {avatarUrl?: string; displayName?: string; email?: string; studentId?: string};
type Counts = {schedules?: number; notes?: number; transactions?: number};
type FeedbackType = 'ai' | 'schedule-scan' | 'expense-category' | 'other';
const showDevTools = __DEV__ || process.env.EXPO_PUBLIC_SMARTLIFE_SHOW_DEV_TOOLS === 'true';
const C = {pine: '#2c341b', sage: '#6f8f6d', dark: '#5f835f', soft: '#e8eee3', muted: '#81887d', danger: '#c96761', note: '#bb9293', finance: '#9297bb'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};
const feedbackTypes: [FeedbackType, string, string][] = [['ai', 'AI แนะนำไม่ตรง', 'auto_awesome'], ['schedule-scan', 'สแกนตารางผิด', 'document_scanner'], ['expense-category', 'หมวดรายจ่ายไม่ถูก', 'receipt_long'], ['other', 'ข้อเสนอแนะอื่น', 'chat_bubble']];

export default function ProfileScreen({uid, onNavigate, onLogout}: {uid: string; onNavigate: UserNavigate; onLogout: () => Promise<void>}) {
  const {restartTour} = useTour();
  const [seedConfirmOpen, setSeedConfirmOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null); const [counts, setCounts] = useState<Counts>({}); const [feedbackType, setFeedbackType] = useState<FeedbackType>('ai'); const [feedback, setFeedback] = useState(''); const [sending, setSending] = useState(false); const [success, setSuccess] = useState(false); const [seeding, setSeeding] = useState(false); const [logoutOpen, setLogoutOpen] = useState(false); const [loggingOut, setLoggingOut] = useState(false); const [logoutError, setLogoutError] = useState('');
  const load = useCallback(async () => { const result = await loadLegacyPageData(uid, 'user/smartlife_profile') as {profile?: Profile; counts?: Counts}; setProfile(result.profile ?? {}); setCounts(result.counts ?? {}); }, [uid]);
  useEffect(() => { load().catch(() => setProfile({})); }, [load]);
  const initials = useMemo(() => (profile?.displayName || 'SL').trim().split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase(), [profile]);
  const [nameOpen, setNameOpen] = useState(false); const [nameDraft, setNameDraft] = useState(''); const [savingName, setSavingName] = useState(false); const [nameError, setNameError] = useState(''); const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const openNameEditor = () => { setNameDraft(profile?.displayName ?? ''); setNameError(''); setNameOpen(true); };
  // The student ID used to be implied at sign-up -- the email field was
  // labelled "รหัสนักศึกษา หรือ อีเมล" -- yet never stored anywhere, so this card
  // could only ever show "-". It is set here instead, and stays optional.
  const [studentIdOpen, setStudentIdOpen] = useState(false); const [studentIdDraft, setStudentIdDraft] = useState(''); const [savingStudentId, setSavingStudentId] = useState(false); const [studentIdError, setStudentIdError] = useState('');
  const openStudentIdEditor = () => { setStudentIdDraft(profile?.studentId ?? ''); setStudentIdError(''); setStudentIdOpen(true); };
  const saveStudentId = async () => {
    if (savingStudentId) return;
    setSavingStudentId(true); setStudentIdError('');
    try {
      await updateProfileDetails({studentId: studentIdDraft});
      await load();
      setStudentIdOpen(false);
      showToast(studentIdDraft.trim() ? 'บันทึกรหัสนักศึกษาแล้ว' : 'ลบรหัสนักศึกษาแล้ว', undefined, 'success');
    } catch (error) {
      setStudentIdError(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setSavingStudentId(false);
    }
  };
  const saveName = async () => {
    if (savingName) return;
    setSavingName(true); setNameError('');
    try {
      await updateProfileDetails({displayName: nameDraft});
      await load();
      setNameOpen(false);
      showToast('บันทึกชื่อแล้ว', undefined, 'success');
    } catch (error) {
      setNameError(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setSavingName(false);
    }
  };

  // The avatar reuses the receipt scanner's upload path: `uploadUserImage` with
  // kind 'avatars', which storage.rules already allows the owner to write at up
  // to 5 MB, and whose download URL is https -- which is what the Firestore rule
  // on `avatarUrl` requires.
  const changePhoto = async () => {
    if (uploadingPhoto) return;
    try {
      if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) { showToast('ไม่ได้รับสิทธิ์', 'อนุญาตการเข้าถึงรูปภาพก่อนเปลี่ยนรูปโปรไฟล์'); return; }
      }
      const picked = await ImagePicker.launchImageLibraryAsync({allowsEditing: true, aspect: [1, 1], mediaTypes: ['images'], quality: .8});
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      setUploadingPhoto(true);
      const {downloadUrl} = await uploadUserImage({contentType: asset.mimeType ?? 'image/jpeg', kind: 'avatars', uid, uri: asset.uri});
      await updateProfileDetails({avatarUrl: downloadUrl});
      await load();
      showToast('เปลี่ยนรูปโปรไฟล์แล้ว', undefined, 'success');
    } catch (error) {
      showToast('เปลี่ยนรูปไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const submit = async () => {
    if (!feedback.trim()) return showToast('กรอกรายละเอียดก่อนส่ง', 'บอกเราได้ว่าอยากให้ปรับปรุงอะไร');
    setSending(true); setSuccess(false);
    try { await runLegacyDataAction(uid, 'user/smartlife_profile', {action: 'feedback', payload: {type: feedbackType, message: feedback}}); setFeedback(''); setSuccess(true); }
    catch { showToast('ส่งไม่สำเร็จ', 'กรุณาลองใหม่อีกครั้ง'); }
    finally { setSending(false); }
  };

  const logout = () => { setLogoutError(''); setLogoutOpen(true); };
  const confirmLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError('');
    try { await onLogout(); }
    catch { setLogoutError('ออกจากระบบไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'); setLoggingOut(false); }
  };
  // Asked through `ConfirmDialog`: `Alert.alert` is an empty function on
  // react-native-web, so on web this prompt never appeared and the seed it
  // guards could not be reached at all.
  const runSeedAiDynamicData = async () => {
    setSeedConfirmOpen(false);
    setSeeding(true);
    try {
      const result = await runLegacyDataAction(uid, 'user/smartlife_profile', {action: 'seed-ai-dynamic-test-data'});
      await load();
      const summary = result && typeof result === 'object' ? Object.entries(result).map(([key, value]) => `${key}: ${value}`).join('\n') : '';
      showToast('เพิ่มข้อมูลสำเร็จ', summary || 'เพิ่มข้อมูลทดสอบเรียบร้อยแล้ว', 'success');
    } catch (error) {
      showToast('เพิ่มข้อมูลไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setSeeding(false);
    }
  };
  const seedAiDynamicData = () => setSeedConfirmOpen(true);
  const replayTour = async () => { await restartTour(); onNavigate('index'); };

  return <UserShell active="smartlife_profile" onNavigate={onNavigate}>
    <View style={styles.pageHead}><Touchable onPress={() => onNavigate('index')} style={({pressed}) => [styles.back, pressed && styles.pressed]}><MaterialIcon name="arrow_back_ios_new" size={18} /></Touchable><View><Text style={styles.title}>โปรไฟล์ของฉัน</Text><Text style={styles.subtitle}>บัญชี ความคิดเห็น และความเป็นส่วนตัว</Text></View></View>
    {profile === null ? <LoadingBlock /> : <>
      {showDevTools ? <Card colors={['#f7fbf4', '#eef5ea']} style={styles.seedPanel}><View style={styles.panelTitleRow}><View style={styles.seedIcon}><MaterialIcon color={C.dark} name="auto_awesome" size={20} /></View><View style={{flex: 1}}><Text style={styles.panelTitle}>ข้อมูลทดสอบ AI Dynamic</Text><Text style={styles.panelSub}>เติมข้อมูลจำลองเข้า Firebase ของบัญชีนี้เพื่อทดสอบ Dashboard และ AI Assistant</Text></View></View><Touchable disabled={seeding} onPress={seedAiDynamicData} style={({pressed}) => [styles.seedButton, pressed && styles.pressed, seeding && styles.disabled]}><MaterialIcon color="#fff" name="database" size={17} /><Text style={styles.seedButtonText}>{seeding ? 'กำลังเพิ่มข้อมูล...' : 'เพิ่มข้อมูลทดสอบ'}</Text></Touchable></Card> : null}
      <AuroraGradient colors={['#769674', '#8ca28b', '#9297bb', '#a1afa0']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.profileCard}>
        <Touchable accessibilityLabel="เปลี่ยนรูปโปรไฟล์" accessibilityRole="button" disabled={uploadingPhoto} onPress={() => void changePhoto()} style={styles.avatarShell}>
          {profile.avatarUrl
            ? <Image source={{uri: profile.avatarUrl}} style={styles.avatar} />
            : <LinearGradient colors={['#392e3a', '#844a50', '#c1a895']} style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></LinearGradient>}
          <View style={styles.avatarBadge}>{uploadingPhoto ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="photo_camera" size={13} />}</View>
        </Touchable>
        <View style={{flex: 1}}>
          <Touchable accessibilityLabel="แก้ไขชื่อที่แสดง" accessibilityRole="button" onPress={openNameEditor} style={styles.nameRow}>
            <Text style={styles.name}>{profile.displayName || 'ผู้ใช้ SmartLife'}</Text>
            <MaterialIcon color="rgba(255,255,255,.8)" name="edit" size={15} />
          </Touchable>
          <Text style={styles.email}>{profile.email || 'ยังไม่มีอีเมล'}</Text>
          <Touchable accessibilityLabel="แก้ไขรหัสนักศึกษา" accessibilityRole="button" onPress={openStudentIdEditor} style={styles.nameRow}>
            <Text style={styles.student}>รหัสนักศึกษา {profile.studentId || '-'}</Text>
            <MaterialIcon color="rgba(255,255,255,.72)" name="edit" size={13} />
          </Touchable>
        </View>
        <MaterialIcon color="rgba(255,255,255,.75)" name="verified" size={22} />
      </AuroraGradient>
      <View style={styles.stats}>{[[counts.schedules ?? 0, 'กิจกรรม', 'school', C.sage], [counts.notes ?? 0, 'โน้ต', 'note_alt', C.note], [counts.transactions ?? 0, 'รายการเงิน', 'account_balance_wallet', C.finance]].map(([value, label, icon, color]) => <Card key={String(label)} style={styles.stat}><View style={[styles.statIcon, {backgroundColor: `${String(color)}22`}]}><MaterialIcon color={String(color)} name={String(icon)} size={18} /></View><Text style={styles.statValue}>{String(value)}</Text><Text style={styles.statLabel}>{String(label)}</Text></Card>)}</View>
      <SleepLogCard uid={uid} variant="baseline" />
      <Touchable onPress={() => onNavigate('smartlife_help')} style={({pressed}) => [styles.lineSettings, pressed && styles.pressed]}><View style={styles.lineSettingsIcon}><MaterialIcon color="#fff" name="menu_book" size={21} /></View><View style={{flex: 1}}><Text style={styles.panelTitle}>คู่มือการใช้งาน</Text><Text style={styles.panelSub}>อ่านวิธีใช้แต่ละหน้าจอแบบละเอียด เข้าใจง่าย เปิดดูได้ทุกเมื่อ</Text></View><MaterialIcon color={C.sage} name="chevron_right" size={22} /></Touchable>
      <Touchable onPress={() => onNavigate('smartlife_line_settings')} style={({pressed}) => [styles.lineSettings, pressed && styles.pressed]}><View style={styles.lineSettingsIcon}><MaterialIcon color="#fff" name="notifications_active" size={21} /></View><View style={{flex: 1}}><Text style={styles.panelTitle}>อ่านแจ้งเตือนการเงิน</Text><Text style={styles.panelSub}>จัดการสิทธิ์ Android ความเป็นส่วนตัว และรายการรอตรวจ</Text></View><MaterialIcon color={C.sage} name="chevron_right" size={22} /></Touchable>
      <Touchable onPress={() => void replayTour()} style={({pressed}) => [styles.lineSettings, pressed && styles.pressed]}><View style={styles.lineSettingsIcon}><MaterialIcon color="#fff" name="tour" size={21} /></View><View style={{flex: 1}}><Text style={styles.panelTitle}>ดูคำแนะนำการใช้งานอีกครั้ง</Text><Text style={styles.panelSub}>เปิดสปอตไลท์แนะนำจุดสำคัญของแต่ละหน้าใหม่อีกครั้ง</Text></View><MaterialIcon color={C.sage} name="chevron_right" size={22} /></Touchable>
      <Card colors={['rgba(255,255,255,.99)', '#f8faf5']} style={styles.panel}><View style={styles.panelTitleRow}><View style={styles.feedbackIcon}><MaterialIcon color={C.sage} name="forum" size={20} /></View><View style={{flex: 1}}><Text style={styles.panelTitle}>ส่ง Feedback</Text><Text style={styles.panelSub}>ช่วยบอกเราเมื่อ AI หรือตารางข้อมูลไม่ตรง</Text></View></View>
        <Text style={styles.label}>ประเภทปัญหา</Text><View style={styles.typeGrid}>{feedbackTypes.map(([type, label, icon]) => <Touchable key={type} onPress={() => setFeedbackType(type)} style={({pressed}) => [styles.typeChip, feedbackType === type && styles.typeChipActive, pressed && styles.pressed]}><MaterialIcon color={feedbackType === type ? '#fff' : C.sage} name={icon} size={15} /><Text style={[styles.typeText, feedbackType === type && styles.typeTextActive]}>{label}</Text></Touchable>)}</View>
        <Text style={styles.label}>รายละเอียด</Text><View style={styles.textAreaShell}><TextInput multiline onChangeText={(value) => {setFeedback(value); setSuccess(false);}} placeholder="อธิบายสิ่งที่พบหรือสิ่งที่อยากให้ปรับปรุง" placeholderTextColor="#9ca49a" style={styles.textArea} textAlignVertical="top" value={feedback} /></View>
        <Touchable disabled={sending} onPress={submit} style={({pressed}) => [styles.submitShell, pressed && styles.pressed, sending && styles.disabled]}><LinearGradient colors={['#759873', '#4e704a']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.submit}>{sending ? null : <Sheen radius={13} />}{sending ? <Text style={styles.submitText}>กำลังส่ง...</Text> : <><MaterialIcon color="#fff" name="send" size={17} /><Text style={styles.submitText}>ส่งความคิดเห็น</Text></>}</LinearGradient></Touchable>
        {success ? <View style={styles.success}><MaterialIcon color={C.dark} name="check_circle" size={18} /><Text style={styles.successText}>ส่ง Feedback สำเร็จ ขอบคุณที่ช่วยพัฒนา SmartLife</Text></View> : null}
      </Card>
      <Touchable onPress={logout} style={({pressed}) => [styles.logout, pressed && styles.pressed]}><MaterialIcon color={C.danger} name="logout" size={19} /><Text style={styles.logoutText}>ออกจากระบบ</Text></Touchable>
    </>}
    <Modal animationType="fade" onRequestClose={() => { if (!savingStudentId) setStudentIdOpen(false); }} transparent visible={studentIdOpen}>
      <View style={styles.modalBackdrop}>
        <Pressable disabled={savingStudentId} onPress={() => setStudentIdOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={styles.logoutDialog}>
          <View style={styles.nameDialogIcon}><MaterialIcon color={C.dark} name="school" size={25} /></View>
          <Text style={styles.logoutDialogTitle}>รหัสนักศึกษา</Text>
          <Text style={styles.logoutDialogMessage}>ไม่บังคับ เว้นว่างไว้ได้ ลบทั้งหมดแล้วบันทึกเพื่อเอาออก</Text>
          <View style={styles.textAreaShell}><TextInput autoCapitalize="characters" autoFocus maxLength={32} onChangeText={(value) => { setStudentIdDraft(value); setStudentIdError(''); }} onSubmitEditing={() => void saveStudentId()} placeholder="เช่น B6700000" placeholderTextColor="#9ca49a" returnKeyType="done" style={styles.nameInput} value={studentIdDraft} /></View>
          {studentIdError ? <View style={styles.logoutError}><MaterialIcon color={C.danger} name="error" size={17} /><Text style={styles.logoutErrorText}>{studentIdError}</Text></View> : null}
          <View style={styles.logoutActions}>
            <Touchable disabled={savingStudentId} onPress={() => setStudentIdOpen(false)} style={({pressed}) => [styles.cancelLogout, pressed && styles.pressed, savingStudentId && styles.disabled]}><Text style={styles.cancelLogoutText}>ยกเลิก</Text></Touchable>
            <Touchable disabled={savingStudentId} onPress={() => void saveStudentId()} style={({pressed}) => [styles.confirmName, pressed && styles.pressed, savingStudentId && styles.disabled]}>{savingStudentId ? <><ActivityIndicator color="#fff" size="small" /><Text style={styles.confirmLogoutText}>กำลังบันทึก...</Text></> : <><MaterialIcon color="#fff" name="check" size={17} /><Text style={styles.confirmLogoutText}>บันทึก</Text></>}</Touchable>
          </View>
        </View>
      </View>
    </Modal>
    <Modal animationType="fade" onRequestClose={() => { if (!savingName) setNameOpen(false); }} transparent visible={nameOpen}>
      <View style={styles.modalBackdrop}>
        <Pressable disabled={savingName} onPress={() => setNameOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={styles.logoutDialog}>
          <View style={styles.nameDialogIcon}><MaterialIcon color={C.dark} name="badge" size={25} /></View>
          <Text style={styles.logoutDialogTitle}>ชื่อที่แสดง</Text>
          <Text style={styles.logoutDialogMessage}>ชื่อนี้จะขึ้นบนโปรไฟล์และในผู้ช่วย AI</Text>
          <View style={styles.textAreaShell}><TextInput autoFocus maxLength={80} onChangeText={(value) => { setNameDraft(value); setNameError(''); }} onSubmitEditing={() => void saveName()} placeholder="กรอกชื่อที่อยากให้แสดง" placeholderTextColor="#9ca49a" returnKeyType="done" style={styles.nameInput} value={nameDraft} /></View>
          {nameError ? <View style={styles.logoutError}><MaterialIcon color={C.danger} name="error" size={17} /><Text style={styles.logoutErrorText}>{nameError}</Text></View> : null}
          <View style={styles.logoutActions}>
            <Touchable disabled={savingName} onPress={() => setNameOpen(false)} style={({pressed}) => [styles.cancelLogout, pressed && styles.pressed, savingName && styles.disabled]}><Text style={styles.cancelLogoutText}>ยกเลิก</Text></Touchable>
            <Touchable disabled={savingName} onPress={() => void saveName()} style={({pressed}) => [styles.confirmName, pressed && styles.pressed, savingName && styles.disabled]}>{savingName ? <><ActivityIndicator color="#fff" size="small" /><Text style={styles.confirmLogoutText}>กำลังบันทึก...</Text></> : <><MaterialIcon color="#fff" name="check" size={17} /><Text style={styles.confirmLogoutText}>บันทึกชื่อ</Text></>}</Touchable>
          </View>
        </View>
      </View>
    </Modal>
    <Modal animationType="fade" onRequestClose={() => { if (!loggingOut) setLogoutOpen(false); }} transparent visible={logoutOpen}>
      <View style={styles.modalBackdrop}>
        <Pressable disabled={loggingOut} onPress={() => setLogoutOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={styles.logoutDialog}>
          <View style={styles.logoutDialogIcon}><MaterialIcon color={C.danger} name="logout" size={25} /></View>
          <Text style={styles.logoutDialogTitle}>ออกจากระบบ?</Text>
          <Text style={styles.logoutDialogMessage}>ต้องการออกจากบัญชี SmartLife บนอุปกรณ์นี้ใช่ไหม?</Text>
          {logoutError ? <View style={styles.logoutError}><MaterialIcon color={C.danger} name="error" size={17} /><Text style={styles.logoutErrorText}>{logoutError}</Text></View> : null}
          <View style={styles.logoutActions}>
            <Touchable disabled={loggingOut} onPress={() => setLogoutOpen(false)} style={({pressed}) => [styles.cancelLogout, pressed && styles.pressed, loggingOut && styles.disabled]}><Text style={styles.cancelLogoutText}>ยกเลิก</Text></Touchable>
            <Touchable disabled={loggingOut} onPress={confirmLogout} style={({pressed}) => [styles.confirmLogout, pressed && styles.pressed, loggingOut && styles.disabled]}>{loggingOut ? <><ActivityIndicator color="#fff" size="small" /><Text style={styles.confirmLogoutText}>กำลังออก...</Text></> : <><MaterialIcon color="#fff" name="logout" size={17} /><Text style={styles.confirmLogoutText}>ออกจากระบบ</Text></>}</Touchable>
          </View>
        </View>
      </View>
    </Modal>
    <ConfirmDialog
      confirmLabel="เพิ่มข้อมูล"
      icon="dataset"
      message="ระบบจะเพิ่มตาราง งาน โน้ต และรายการการเงินจำลองเข้า Firebase ของบัญชีนี้ เหมือนผู้ใช้เพิ่มเอง ต้องการทำต่อไหม?"
      onCancel={() => setSeedConfirmOpen(false)}
      onConfirm={() => void runSeedAiDynamicData()}
      title="เพิ่มข้อมูลทดสอบ AI Dynamic"
      tone="neutral"
      visible={seedConfirmOpen}
    />
  </UserShell>;
}

const shadow = {shadowColor: C.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: .08, shadowRadius: 20};
const styles = StyleSheet.create({
  lineSettings: {...shadow, alignItems: 'center', backgroundColor: '#f4f8f1', borderColor: '#dce8d8', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 10, marginBottom: 12, padding: 13},
  lineSettingsIcon: {alignItems: 'center', backgroundColor: C.sage, borderRadius: 14, height: 42, justifyContent: 'center', width: 42},
  cancelLogout: {alignItems: 'center', backgroundColor: '#eff3eb', borderRadius: 13, flex: 1, justifyContent: 'center', minHeight: 46}, cancelLogoutText: {color: C.dark, fontFamily: F.b, fontSize: 12}, confirmLogout: {alignItems: 'center', backgroundColor: C.danger, borderRadius: 13, flex: 1.25, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46}, confirmLogoutText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  avatarBadge: {alignItems: 'center', backgroundColor: 'rgba(38,50,31,.82)', borderColor: 'rgba(255,255,255,.9)', borderRadius: 11, borderWidth: 1.5, bottom: -1, height: 22, justifyContent: 'center', position: 'absolute', right: -1, width: 22}, avatarShell: {height: 62, width: 62}, confirmName: {alignItems: 'center', backgroundColor: C.dark, borderRadius: 13, flex: 1.25, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46}, nameDialogIcon: {alignItems: 'center', alignSelf: 'center', backgroundColor: C.soft, borderRadius: 22, height: 48, justifyContent: 'center', marginBottom: 11, width: 48}, nameInput: {color: C.pine, fontFamily: F.r, fontSize: 13, padding: 12}, nameRow: {alignItems: 'center', flexDirection: 'row', gap: 6},
  avatar: {alignItems: 'center', borderColor: 'rgba(255,255,255,.88)', borderRadius: 31, borderWidth: 3, height: 62, justifyContent: 'center', width: 62}, avatarText: {color: '#fff', fontFamily: F.x, fontSize: 17}, back: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 14, height: 42, justifyContent: 'center', width: 42}, disabled: {opacity: .6}, email: {color: 'rgba(255,255,255,.88)', fontFamily: F.r, fontSize: 12, marginTop: 1}, feedbackIcon: {alignItems: 'center', backgroundColor: '#e8f0e4', borderRadius: 14, height: 40, justifyContent: 'center', width: 40}, label: {color: '#4d5948', fontFamily: F.s, fontSize: 12, marginBottom: 6, marginTop: 14}, logout: {alignItems: 'center', backgroundColor: '#f8e5e2', borderColor: 'rgba(201,103,97,.22)', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 48}, logoutActions: {flexDirection: 'row', gap: 9, marginTop: 17}, logoutDialog: {...shadow, backgroundColor: '#fff', borderRadius: 22, maxWidth: 410, padding: 22, width: '88%'}, logoutDialogIcon: {alignItems: 'center', alignSelf: 'center', backgroundColor: '#f8e5e2', borderRadius: 22, height: 48, justifyContent: 'center', marginBottom: 11, width: 48}, logoutDialogMessage: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, textAlign: 'center'}, logoutDialogTitle: {color: C.pine, fontFamily: F.x, fontSize: 19, marginBottom: 5, textAlign: 'center'}, logoutError: {alignItems: 'center', backgroundColor: '#fff0ee', borderRadius: 10, flexDirection: 'row', gap: 7, marginTop: 12, padding: 9}, logoutErrorText: {color: C.danger, flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18}, logoutText: {color: C.danger, fontFamily: F.b, fontSize: 12}, modalBackdrop: {alignItems: 'center', backgroundColor: 'rgba(24,30,19,.48)', flex: 1, justifyContent: 'center', padding: 18}, name: {color: '#fff', fontFamily: F.x, fontSize: 18}, pageHead: {alignItems: 'center', flexDirection: 'row', gap: 12, marginBottom: 14}, panel: {marginBottom: 13, marginTop: 0, padding: 15}, panelSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1}, panelTitle: {color: C.pine, fontFamily: F.b, fontSize: 14}, panelTitleRow: {alignItems: 'center', flexDirection: 'row', gap: 10}, pressed: {opacity: .82, transform: [{scale: .987}]}, profileCard: {...shadow, alignItems: 'center', borderRadius: 20, flexDirection: 'row', gap: 13, marginBottom: 12, padding: 16}, seedButton: {alignItems: 'center', backgroundColor: C.dark, borderRadius: 13, flexDirection: 'row', gap: 7, justifyContent: 'center', marginTop: 12, minHeight: 44}, seedButtonText: {color: '#fff', fontFamily: F.b, fontSize: 12}, seedIcon: {alignItems: 'center', backgroundColor: '#dfeadd', borderRadius: 14, height: 40, justifyContent: 'center', width: 40}, seedPanel: {marginBottom: 13, marginTop: 0, padding: 15}, stat: {alignItems: 'center', flex: 1, marginTop: 0, padding: 10}, statIcon: {alignItems: 'center', borderRadius: 12, height: 31, justifyContent: 'center', marginBottom: 3, width: 31}, statLabel: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1}, statValue: {color: C.pine, fontFamily: F.x, fontSize: 18}, stats: {flexDirection: 'row', gap: 8, marginBottom: 12}, student: {color: 'rgba(255,255,255,.72)', fontFamily: F.r, fontSize: 12, marginTop: 2}, submit: {alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 45}, submitShell: {...shadow, borderRadius: 13, marginTop: 3, overflow: 'hidden'}, submitText: {color: '#fff', fontFamily: F.b, fontSize: 12}, subtitle: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1}, success: {alignItems: 'center', backgroundColor: C.soft, borderRadius: 11, flexDirection: 'row', gap: 7, marginTop: 10, padding: 9}, successText: {color: C.dark, flex: 1, fontFamily: F.s, fontSize: 12}, textArea: {color: C.pine, fontFamily: F.r, fontSize: 12, minHeight: 88, padding: 10}, textAreaShell: {backgroundColor: '#f8faf5', borderColor: 'rgba(44,52,27,.1)', borderRadius: 12, borderWidth: 1}, title: {color: C.pine, fontFamily: F.x, fontSize: 21}, typeChip: {alignItems: 'center', backgroundColor: '#eef3ea', borderRadius: 10, flexDirection: 'row', gap: 5, minHeight: 35, paddingHorizontal: 9, width: '48.5%'}, typeChipActive: {backgroundColor: C.sage}, typeGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 7}, typeText: {color: C.dark, fontFamily: F.m, fontSize: 12}, typeTextActive: {color: '#fff', fontFamily: F.s},
});
