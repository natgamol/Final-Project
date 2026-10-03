import {useState} from 'react';
import {ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';

import type {LegacyAuthRequest, LegacyAuthResult} from '@/components/legacy/legacy-page-dom';
import {MaterialIcon} from '@/screens/native/user/user-ui';

type AuthPortalProps = {
  mode: 'login' | 'register';
  onFacebook: () => Promise<LegacyAuthResult>;
  onGoogle: () => Promise<LegacyAuthResult>;
  onSubmit: (request: LegacyAuthRequest) => Promise<LegacyAuthResult>;
  onSwitch: (page: 'login' | 'register') => void;
};

const C = {pine: '#2c341b', green: '#688a65', greenDark: '#4e704a', olivine: '#97ac82', morning: '#94a59c', bone: '#dddfc2', soft: '#f4f5ef', muted: '#7f897a'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

function Field({icon, label, placeholder, value, onChangeText, secure, onToggle, keyboardType = 'default'}: {icon: string; label: string; placeholder: string; value: string; onChangeText: (value: string) => void; secure?: boolean; onToggle?: () => void; keyboardType?: 'default' | 'email-address'}) {
  return <View style={styles.fieldGroup}><Text style={styles.label}>{label}</Text><View style={styles.inputShell}><MaterialIcon color="#9aa394" name={icon} size={19} /><TextInput autoCapitalize="none" keyboardType={keyboardType} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#aeb5aa" secureTextEntry={secure} style={styles.input} value={value} />{onToggle ? <Touchable hitSlop={10} onPress={onToggle}><MaterialIcon color="#9aa394" name={secure ? 'visibility_off' : 'visibility'} size={19} /></Touchable> : null}</View></View>;
}

export default function AuthPortal({mode, onFacebook, onGoogle, onSubmit, onSwitch}: AuthPortalProps) {
  const registering = mode === 'register';
  const [displayName, setDisplayName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false); const [accepted, setAccepted] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [socialBusy, setSocialBusy] = useState<'facebook' | 'google' | null>(null);

  const submit = async () => {
    setMessage('');
    if (!email.trim() || !password) return setMessage('กรุณากรอกอีเมลและรหัสผ่าน');
    if (registering && !displayName.trim()) return setMessage('กรุณากรอกชื่อ - นามสกุล');
    if (registering && password !== confirmPassword) return setMessage('รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน');
    if (registering && !accepted) return setMessage('กรุณายอมรับข้อตกลงและนโยบายความเป็นส่วนตัว');
    setBusy(true);
    try { const result = await onSubmit({action: registering ? 'register' : 'signIn', displayName, email, password}); if (!result.ok) setMessage(result.message ?? 'ไม่สามารถดำเนินการได้'); } finally { setBusy(false); }
  };

  const resetPassword = async () => {
    if (!email.trim()) return setMessage('กรอกอีเมลก่อนขอรีเซ็ตรหัสผ่าน');
    setBusy(true); setMessage('');
    try { const result = await onSubmit({action: 'reset', email}); setMessage(result.message ?? (result.ok ? 'ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว' : 'ส่งลิงก์ไม่สำเร็จ')); } finally { setBusy(false); }
  };

  const googleLogin = async () => {
    if (busy) return;
    setSocialBusy('google'); setBusy(true); setMessage('');
    try {
      const result = await onGoogle();
      if (!result.ok) setMessage(result.message ?? 'ไม่สามารถเข้าสู่ระบบด้วย Google ได้');
    } finally {
      setSocialBusy(null);
      setBusy(false);
    }
  };

  const facebookLogin = async () => {
    if (busy) return;
    setSocialBusy('facebook'); setBusy(true); setMessage('');
    try {
      const result = await onFacebook();
      if (!result.ok) setMessage(result.message ?? 'ไม่สามารถเข้าสู่ระบบด้วย Facebook ได้');
    } finally {
      setSocialBusy(null);
      setBusy(false);
    }
  };

  return <ResponsiveSafeArea style={styles.safe}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
    <LinearGradient colors={['#f7f8f2', '#dfe7d7', '#cbd7c2']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />
    <ScrollView bounces={false} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={[styles.hero, registering && styles.heroRegister]}>
        <LinearGradient colors={['#ffffff', '#f2f6ed']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.logo}><MaterialIcon color={C.green} name="all_inclusive" size={34} /></LinearGradient>
        <Text style={styles.title}>{registering ? 'สร้างบัญชีใหม่' : 'ยินดีต้อนรับสู่\nSmartLife'}</Text>
        <Text style={styles.subtitle}>{registering ? 'เริ่มต้นจัดการชีวิตของคุณไปกับเรา' : 'จัดการชีวิตและการเงินในที่เดียว'}</Text>
      </View>

      <LinearGradient colors={['rgba(255,255,255,.96)', 'rgba(248,250,245,.92)']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.formCard}>
        {registering ? <Field icon="badge" label="ชื่อ - นามสกุล" onChangeText={setDisplayName} placeholder="สมชาย ใจดี" value={displayName} /> : null}
        {/* An email in both modes, because that is all either one accepts: the
            value goes straight to Firebase email/password auth. Sign-up used
            to offer "รหัสนักศึกษา" and log-in "ชื่อผู้ใช้" -- neither was ever
            looked up, so typing either one simply failed. A student ID is
            optional and set on the profile page instead. */}
        <Field icon="mail" keyboardType="email-address" label="อีเมล" onChangeText={setEmail} placeholder="name@example.com" value={email} />
        <Field icon="lock" label="รหัสผ่าน" onChangeText={setPassword} onToggle={() => setShowPassword((value) => !value)} placeholder="••••••••" secure={!showPassword} value={password} />
        {registering ? <Field icon="verified" label="ยืนยันรหัสผ่าน" onChangeText={setConfirmPassword} placeholder="••••••••" secure={!showPassword} value={confirmPassword} /> : <Touchable disabled={busy} onPress={resetPassword} style={styles.forgot}><Text style={styles.forgotText}>ลืมรหัสผ่าน?</Text></Touchable>}

        {registering ? <Touchable onPress={() => setAccepted((value) => !value)} style={styles.terms}><View style={[styles.checkbox, accepted && styles.checkboxActive]}>{accepted ? <MaterialIcon color="#fff" name="check" size={14} /> : null}</View><Text style={styles.termsText}>ฉันยอมรับ <Text style={styles.termsLink}>ข้อตกลงและเงื่อนไข</Text> และ <Text style={styles.termsLink}>นโยบายความเป็นส่วนตัว</Text></Text></Touchable> : null}
        {message ? <View style={styles.message}><MaterialIcon color={message.includes('แล้ว') ? C.green : '#bd625b'} name={message.includes('แล้ว') ? 'check_circle' : 'error'} size={17} /><Text style={styles.messageText}>{message}</Text></View> : null}

        <Touchable disabled={busy} onPress={submit} style={({pressed}) => [styles.primaryShell, pressed && styles.pressed, busy && styles.disabled]}><LinearGradient colors={['#789a75', '#4b7047']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.primary}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{registering ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</Text>}</LinearGradient></Touchable>

        <View style={styles.divider}><View style={styles.dividerLine} /><Text style={styles.dividerText}>{registering ? 'หรือสมัครผ่าน' : 'หรือเข้าสู่ระบบด้วย'}</Text><View style={styles.dividerLine} /></View>
        <View style={styles.socials}>
          <Touchable accessibilityLabel="เข้าสู่ระบบด้วย Google" accessibilityRole="button" disabled={busy} onPress={googleLogin} style={({pressed}) => [styles.google, pressed && !busy && styles.pressed, busy && styles.disabled]}>{socialBusy === 'google' ? <ActivityIndicator color="#4285f4" size="small" /> : <Text style={styles.googleMark}>G</Text>}<Text style={styles.googleText}>{socialBusy === 'google' ? 'กำลังเชื่อมต่อ...' : 'Google'}</Text></Touchable>
          <Touchable accessibilityLabel="เข้าสู่ระบบด้วย Facebook" accessibilityRole="button" disabled={busy} onPress={facebookLogin} style={({pressed}) => [styles.facebook, pressed && !busy && styles.pressed, busy && styles.disabled]}>{socialBusy === 'facebook' ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.facebookMark}>f</Text>}<Text style={styles.facebookText}>{socialBusy === 'facebook' ? 'กำลังเชื่อมต่อ...' : 'Facebook'}</Text></Touchable>
        </View>

        <Touchable onPress={() => onSwitch(registering ? 'login' : 'register')} style={styles.switch}><Text style={styles.switchMuted}>{registering ? 'มีบัญชีอยู่แล้วใช่ไหม? ' : 'ยังไม่มีบัญชีใช่ไหม? '}<Text style={styles.switchLink}>{registering ? 'เข้าสู่ระบบ' : 'ลงทะเบียนเลย'}</Text></Text></Touchable>
      </LinearGradient>
    </ScrollView>
  </KeyboardAvoidingView></ResponsiveSafeArea>;
}

const shadow = {shadowColor: C.pine, shadowOffset: {height: 12, width: 0}, shadowOpacity: .1, shadowRadius: 24};
const styles = StyleSheet.create({
  checkbox: {alignItems: 'center', borderColor: '#b9c0b4', borderRadius: 5, borderWidth: 1, height: 19, justifyContent: 'center', width: 19}, checkboxActive: {backgroundColor: C.green, borderColor: C.green}, disabled: {opacity: .62}, divider: {alignItems: 'center', flexDirection: 'row', gap: 10, marginVertical: 18}, dividerLine: {backgroundColor: '#e0e4d8', flex: 1, height: 1}, dividerText: {color: '#92998e', fontFamily: F.s, fontSize: 12}, facebook: {alignItems: 'center', backgroundColor: '#5b86bd', borderRadius: 14, flexDirection: 'row', gap: 9, justifyContent: 'center', minHeight: 48}, facebookMark: {color: '#fff', fontFamily: F.b, fontSize: 18}, facebookText: {color: '#fff', fontFamily: F.b, fontSize: 12}, fieldGroup: {marginBottom: 12}, forgot: {alignSelf: 'flex-end', marginBottom: 4, marginTop: -3, padding: 4}, forgotText: {color: C.green, fontFamily: F.s, fontSize: 12, textDecorationLine: 'underline'}, formCard: {...shadow, borderColor: 'rgba(255,255,255,.9)', borderTopLeftRadius: 36, borderTopRightRadius: 36, borderTopWidth: 1, flex: 1, minHeight: 500, padding: 27, paddingBottom: 22}, google: {alignItems: 'center', backgroundColor: '#fff', borderColor: '#e1e4d8', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 10, justifyContent: 'center', minHeight: 48}, googleMark: {color: '#4285f4', fontFamily: F.x, fontSize: 17}, googleText: {color: C.pine, fontFamily: F.b, fontSize: 12}, hero: {justifyContent: 'flex-end', minHeight: 282, paddingBottom: 32, paddingHorizontal: 31}, heroRegister: {minHeight: 224, paddingBottom: 24}, input: {color: C.pine, flex: 1, fontFamily: F.r, fontSize: 12, height: 50, paddingVertical: 0}, inputShell: {...shadow, alignItems: 'center', backgroundColor: 'rgba(255,255,255,.92)', borderColor: 'rgba(221,223,194,.65)', borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 50, paddingHorizontal: 14, shadowOpacity: .035, shadowRadius: 10}, label: {color: '#596552', fontFamily: F.s, fontSize: 12, marginBottom: 6, marginLeft: 3}, logo: {...shadow, alignItems: 'center', borderColor: 'rgba(221,223,194,.55)', borderRadius: 17, borderWidth: 1, height: 61, justifyContent: 'center', marginBottom: 20, width: 61}, message: {alignItems: 'center', backgroundColor: '#f6f1ed', borderRadius: 11, flexDirection: 'row', gap: 7, marginBottom: 9, padding: 9}, messageText: {color: '#7c665f', flex: 1, fontFamily: F.r, fontSize: 12}, pressed: {opacity: .83, transform: [{scale: .988}]}, primary: {alignItems: 'center', justifyContent: 'center', minHeight: 51}, primaryShell: {...shadow, borderRadius: 15, marginTop: 8, overflow: 'hidden'}, primaryText: {color: '#fff', fontFamily: F.b, fontSize: 14}, safe: {backgroundColor: '#dfe7d7', flex: 1}, screen: {flex: 1}, scroll: {flexGrow: 1}, socialHalf: {flex: 1}, socials: {gap: 10}, socialsRegister: {flexDirection: 'row'}, switch: {alignItems: 'center', marginTop: 20, paddingVertical: 5}, switchLink: {color: C.green, fontFamily: F.b, textDecorationLine: 'underline'}, switchMuted: {color: '#899184', fontFamily: F.r, fontSize: 12}, subtitle: {color: '#65725f', fontFamily: F.m, fontSize: 12, marginTop: 5}, terms: {alignItems: 'flex-start', flexDirection: 'row', gap: 9, marginBottom: 3, marginTop: 1}, termsLink: {color: C.green, fontFamily: F.s}, termsText: {color: '#788273', flex: 1, fontFamily: F.r, fontSize: 12, lineHeight: 18}, title: {color: C.pine, fontFamily: F.x, fontSize: 29, lineHeight: 36},
});
