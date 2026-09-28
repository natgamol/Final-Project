import { FirebaseError } from 'firebase/app';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { Href, Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import LegacyPageDom, { LegacyAuthRequest, LegacyAuthResult, LegacyOcrResult, LegacyScanRequest, LegacyScanResult } from '@/components/legacy/legacy-page-dom';
import { legacyPageParams, legacyPages } from '@/generated/legacy-pages';
import { resolveLegacyRoute } from '@/lib/legacy-route';
import { useAuth } from '@/providers/auth-provider';
import { getUserRole, registerWithEmail, sendResetEmail, signInWithEmail, signInWithFacebook, signInWithGoogle } from '@/services/auth';
import {loadLegacyPageData, runLegacyDataAction, type LegacyDataAction} from '@/services/legacy-data';
import { uploadAndAnalyzeScan } from '@/services/ocr';
import AdminPortal from '@/screens/admin/admin-portal';
import AuthPortal from '@/screens/auth/auth-portal';
import DashboardScreen from '@/screens/native/user/dashboard-screen';
import CalendarScreen from '@/screens/native/user/calendar-screen';
import PlannerScreen from '@/screens/native/user/planner-screen';
import FinanceScreen from '@/screens/native/user/finance-screen';
import MonthlyBudgetScreen from '@/screens/native/user/monthly-budget-screen';
import NotesScreen from '@/screens/native/user/notes-screen';
import AssistantScreen from '@/screens/native/user/assistant-screen';
import NotificationsScreen from '@/screens/native/user/notifications-screen';
import ProfileScreen from '@/screens/native/user/profile-screen';
import ActivityFormScreen from '@/screens/native/user/activity-form-screen';
import OcrHistoryScreen from '@/screens/native/user/ocr-history-screen';
import ScanScreen from '@/screens/native/user/scan-screen';
import ScheduleFinanceScreen from '@/screens/native/user/schedule-finance-screen';
import OnboardingScreen from '@/screens/native/user/onboarding-screen';
import NoteFormScreen from '@/screens/native/user/note-form-screen';
import MiscScreen from '@/screens/native/user/misc-screen';
import LineImportScreen from '@/screens/native/user/line-import-screen';
import AdaptiveSchedulingScreen from '@/screens/native/user/adaptive-scheduling-screen';
import HelpScreen from '@/screens/native/user/help-screen';

export function generateStaticParams() {
  return [
    ...legacyPageParams.map(({ section, page }) => ({ section, page })),
    {section: 'admin', page: 'admin_calendar'},
    {section: 'admin', page: 'admin_notes'},
    {section: 'admin', page: 'admin_finance'},
    {section: 'user', page: 'smartlife_ocr_history'},
    {section: 'user', page: 'smartlife_monthly_budget'},
    {section: 'user', page: 'smartlife_line_import'},
    {section: 'user', page: 'smartlife_line_pending'},
    {section: 'user', page: 'smartlife_line_settings'},
    {section: 'user', page: 'smartlife_adaptive_scheduling'},
    {section: 'user', page: 'smartlife_line_bank'},
    {section: 'user', page: 'smartlife_help'},
  ];
}

function authErrorMessage(error: unknown) {
  if (!(error instanceof FirebaseError)) {
    const message = error instanceof Error ? error.message : '';
    return message || 'ไม่สามารถดำเนินการได้ กรุณาลองอีกครั้ง';
  }
  const messages: Record<string, string> = {
    'auth/account-exists-with-different-credential': 'อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบด้วยวิธีเดิมก่อน',
    'auth/email-already-in-use': 'อีเมลนี้ถูกใช้งานแล้ว',
    'auth/invalid-credential': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    'auth/invalid-email': 'รูปแบบอีเมลไม่ถูกต้อง',
    'auth/operation-not-allowed': 'ยังไม่ได้เปิด Social provider ใน Firebase Authentication',
    'auth/popup-closed-by-user': 'ยกเลิกการเข้าสู่ระบบด้วย Google',
    'auth/unauthorized-domain': 'Firebase ยังไม่อนุญาต localhost กรุณาเพิ่ม localhost ที่ Authentication > Settings > Authorized domains แล้วกด Google อีกครั้ง',
    'auth/weak-password': 'รหัสผ่านควรมีอย่างน้อย 6 ตัวอักษร',
  };
  return messages[error.code] ?? 'ไม่สามารถดำเนินการได้ กรุณาลองอีกครั้ง';
}

function LegacyPageRouteContent() {
  const params = useLocalSearchParams<{ autoAsk?: string; autoListen?: string; id?: string; page: string; section: string }>();
  const router = useRouter();
  const {initializing, role, signOut, user} = useAuth();
  const section = String(params.section ?? '').toLowerCase();
  const page = String(params.page ?? '');
  const html = legacyPages[`${section}/${page}`];
  const [scanResult, setScanResult] = useState<LegacyOcrResult | null>(null);
  const resultType = page === 'smartlife_receipt_result' ? 'receipt' :
    page === 'smartlife_scan_result' ? 'schedule' : null;

  useEffect(() => {
    if (!resultType) return;
    AsyncStorage.getItem(`smartlife:last-ocr:${resultType}`).then((stored) => {
      setScanResult(stored ? JSON.parse(stored) as LegacyOcrResult : null);
    }).catch(() => setScanResult(null));
  }, [resultType]);

  const handleLogout = useCallback(async () => {
    await signOut();
    if (router.canDismiss()) router.dismissAll();
    router.replace('/login/login' as Href);
  }, [router, signOut]);

  const onNavigate = useCallback(async (href: string) => {
    const route = resolveLegacyRoute(section, href);
    if (!route) return;
    if (route.section === 'login') {
      await handleLogout();
      return;
    }
    router.push(`/${route.section}/${route.page}` as Href);
  }, [handleLogout, router, section]);

  const onBack = useCallback(async () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const onAuthenticate = useCallback(async (request: LegacyAuthRequest): Promise<LegacyAuthResult> => {
    try {
      if (request.action === 'reset') {
        await sendResetEmail(request.email);
        return { ok: true, message: 'ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว' };
      }
      if (request.action === 'register') {
        await registerWithEmail({
          displayName: request.displayName ?? '', email: request.email, password: request.password ?? '',
        });
        router.replace('/user/index' as Href);
        return { ok: true };
      }
      const user = await signInWithEmail(request.email, request.password ?? '');
      const role = await getUserRole(user);
      router.replace((role === 'admin' ? '/admin/admin_dashboard' : '/user/index') as Href);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: authErrorMessage(error) };
    }
  }, [router]);

  const onGoogleAuthenticate = useCallback(async (): Promise<LegacyAuthResult> => {
    try {
      const googleUser = await signInWithGoogle();
      const googleRole = await getUserRole(googleUser);
      router.replace((googleRole === 'admin' ? '/admin/admin_dashboard' : '/user/index') as Href);
      return {ok: true};
    } catch (error) {
      return {ok: false, message: authErrorMessage(error)};
    }
  }, [router]);

  const onFacebookAuthenticate = useCallback(async (): Promise<LegacyAuthResult> => {
    try {
      const facebookUser = await signInWithFacebook();
      const facebookRole = await getUserRole(facebookUser);
      router.replace((facebookRole === 'admin' ? '/admin/admin_dashboard' : '/user/index') as Href);
      return {ok: true};
    } catch (error) {
      return {ok: false, message: authErrorMessage(error)};
    }
  }, [router]);

  const onScan = useCallback(async (request: LegacyScanRequest): Promise<LegacyScanResult> => {
    if (!user) return { ok: false, message: 'กรุณาเข้าสู่ระบบก่อนสแกน' };
    try {
      if (Platform.OS !== 'web') {
        const permission = request.source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) return { ok: false, message: 'กรุณาอนุญาตการเข้าถึงกล้องหรือคลังรูป' };
      }

      const pickerResult = request.source === 'camera'
        ? await ImagePicker.launchCameraAsync({mediaTypes: ['images'], quality: 0.9})
        : await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], quality: 0.9});
      if (pickerResult.canceled || !pickerResult.assets[0]) return { canceled: true, ok: false };

      const asset = pickerResult.assets[0];
      const result = await uploadAndAnalyzeScan({
        contentType: asset.mimeType ?? 'image/jpeg',
        scanType: request.scanType,
        uid: user.uid,
        uri: asset.uri,
      });
      await AsyncStorage.setItem(`smartlife:last-ocr:${request.scanType}`, JSON.stringify(result));
      const target = request.scanType === 'receipt'
        ? '/user/smartlife_receipt_result'
        : '/user/smartlife_scan_result';
      router.push(target as Href);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ไม่สามารถอ่านรูปนี้ได้ กรุณาลองใหม่';
      return { ok: false, message };
    }
  }, [router, user]);

  const onDataRequest = useCallback(async (requestedPageKey: string) => {
    if (!user) throw new Error('กรุณาเข้าสู่ระบบ');
    return loadLegacyPageData(user.uid, requestedPageKey);
  }, [user]);

  const onDataAction = useCallback(async (requestedPageKey: string, request: LegacyDataAction) => {
    if (!user) throw new Error('กรุณาเข้าสู่ระบบ');
    return runLegacyDataAction(user.uid, requestedPageKey, request);
  }, [user]);

  if (initializing) return <View style={styles.loading}><ActivityIndicator color="#6f966f" size="large" /></View>;
  if (section === 'login' && user) {
    // `role` resolves *after* `user`: the auth listener sets the user, then
    // awaits the `admin` custom claim. Redirecting while the role is still
    // null sent an admin to the user app, because null falls to the `:`
    // branch -- an intermittent failure, since the sign-in handler usually
    // won the race by awaiting `getUserRole` itself. Wait for the answer
    // instead of guessing it; the listener always resolves the role to
    // 'admin' or 'user', including on error, so this cannot hang.
    if (role === null) return <View style={styles.loading}><ActivityIndicator color="#6f966f" size="large" /></View>;
    return <Redirect href={(role === 'admin' ? '/admin/admin_dashboard' : '/user/index') as Href} />;
  }
  if (section === 'login') return <AuthPortal mode={page === 'register' ? 'register' : 'login'} onFacebook={onFacebookAuthenticate} onGoogle={onGoogleAuthenticate} onSubmit={onAuthenticate} onSwitch={(target) => router.push(`/login/${target}` as Href)} />;
  if (!user) {
    return <Redirect href={'/login/login' as Href} />;
  }
  if (section === 'admin' && (!user || role === null)) return <View style={styles.loading}><ActivityIndicator color="#6f966f" size="large" /></View>;
  if (section === 'admin' && role === 'user') return <Redirect href={'/user/index' as Href} />;
  if (section === 'admin' && user) return <AdminPortal page={page === 'index' ? 'admin_dashboard' : page} uid={user.uid} onNavigate={(target) => router.push(`/admin/${target}` as Href)} onLogout={handleLogout} />;
  if (section === 'user' && user && page === 'index') return <DashboardScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_planner') return <PlannerScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_planner_notes') return <PlannerScreen initialTab="notes" uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_calendar_day', 'smartlife_calendar_week', 'smartlife_calendar_month'].includes(page)) return <CalendarScreen page={page as 'smartlife_calendar_day' | 'smartlife_calendar_week' | 'smartlife_calendar_month'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_finance_day', 'smartlife_finance_week', 'smartlife_finance_month', 'smartlife_finance_income', 'smartlife_finance_expense'].includes(page)) return <FinanceScreen page={page as 'smartlife_finance_day' | 'smartlife_finance_week' | 'smartlife_finance_month' | 'smartlife_finance_income' | 'smartlife_finance_expense'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_monthly_budget') return <MonthlyBudgetScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_line_import', 'smartlife_line_pending', 'smartlife_line_settings'].includes(page)) return <LineImportScreen page={page as 'smartlife_line_import' | 'smartlife_line_pending' | 'smartlife_line_settings'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_adaptive_scheduling') return <AdaptiveSchedulingScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_notes', 'smartlife_notes_study', 'smartlife_notes_work', 'smartlife_notes_ideas'].includes(page)) return <NotesScreen page={page as 'smartlife_notes' | 'smartlife_notes_study' | 'smartlife_notes_work' | 'smartlife_notes_ideas'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_notifications', 'smartlife_notifications_urgent', 'smartlife_notifications_ai', 'smartlife_notifications_finance', 'smartlife_notifications_schedule'].includes(page)) return <NotificationsScreen page={page as 'smartlife_notifications' | 'smartlife_notifications_urgent' | 'smartlife_notifications_ai' | 'smartlife_notifications_finance' | 'smartlife_notifications_schedule'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_profile') return <ProfileScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} onLogout={handleLogout} />;
  if (section === 'user' && user && page === 'smartlife_help') return <HelpScreen onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_add_activity', 'smartlife_add_task', 'smartlife_add_appointment', 'smartlife_add_income', 'smartlife_add_expense', 'smartlife_save_activity', 'smartlife_save_task', 'smartlife_save_appointment'].includes(page)) return <ActivityFormScreen page={page as 'smartlife_add_activity' | 'smartlife_add_task' | 'smartlife_add_appointment' | 'smartlife_add_income' | 'smartlife_add_expense' | 'smartlife_save_activity' | 'smartlife_save_task' | 'smartlife_save_appointment'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_add_note') return <NoteFormScreen noteId={params.id ? String(params.id) : undefined} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_ocr_history') return <OcrHistoryScreen uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_scan_schedule', 'smartlife_scan_finance', 'smartlife_scan_result', 'smartlife_receipt_scan', 'smartlife_receipt_result'].includes(page)) return <ScanScreen page={page as 'smartlife_scan_schedule' | 'smartlife_scan_finance' | 'smartlife_scan_result' | 'smartlife_receipt_scan' | 'smartlife_receipt_result'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_schedule_finance_sync', 'smartlife_schedule_finance_sync_week', 'smartlife_schedule_finance_sync_month'].includes(page)) return <ScheduleFinanceScreen page={page as 'smartlife_schedule_finance_sync' | 'smartlife_schedule_finance_sync_week' | 'smartlife_schedule_finance_sync_month'} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_line_bank') return <LineImportScreen page="smartlife_line_import" uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && ['smartlife_onboarding', 'smartlife_onboarding_step_2', 'smartlife_onboarding_step_3', 'smartlife_s25', 'smartlife_ui_board_earthy_theme_1_'].includes(page)) return <OnboardingScreen page={page} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page.includes('ai_')) return <AssistantScreen autoAsk={typeof params.autoAsk === 'string' ? params.autoAsk : undefined} autoListen={params.autoListen === '1'} page={page} uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_calendar') return <CalendarScreen page="smartlife_calendar_day" uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user && page === 'smartlife_finance') return <FinanceScreen page="smartlife_finance_day" uid={user.uid} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (section === 'user' && user) return <MiscScreen page={page} onNavigate={(target) => router.push(`/user/${target}` as Href)} />;
  if (!html) return <Redirect href="/" />;
  return (
    <View style={styles.container}>
      <LegacyPageDom dom={{ scrollEnabled: false, style: styles.container }} html={html}
        onAuthenticate={onAuthenticate} onBack={onBack} onNavigate={onNavigate}
        onDataAction={onDataAction} onDataRequest={onDataRequest}
        onScan={onScan} scanResult={resultType ? scanResult : null} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { alignItems: 'center', backgroundColor: '#e9ebe2', flex: 1, justifyContent: 'center' },
});

// The web build has no native stack transition, so a screen would otherwise cut in
// abruptly. Native keeps its own slide, so this only fades on web.
export default function LegacyPageRoute() {
  return <Animated.View entering={Platform.OS === 'web' ? FadeIn.duration(320).reduceMotion(ReduceMotion.System) : undefined} style={{flex: 1}}><LegacyPageRouteContent /></Animated.View>;
}
