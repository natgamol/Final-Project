/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import {loadLegacyPageData, runLegacyDataAction} from '@/services/legacy-data';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {C, F, LoadingBlock, type Data} from './admin-ui';
import AdminAiKnowledgeView from './views/ai-knowledge-view';
import AdminAnnouncementsView from './views/announcements-view';
import AdminCalendarView from './views/calendar-view';
import AdminCategoriesView from './views/categories-view';
import AdminDashboardView from './views/dashboard-view';
import AdminFeedbackView from './views/feedback-view';
import AdminFinanceView from './views/finance-view';
import AdminMoreView from './views/more-view';
import AdminNotesView from './views/notes-view';
import AdminOcrLogsView from './views/ocr-logs-view';
import AdminSystemHealthView from './views/system-health-view';
import AdminUsersView from './views/users-view';
import type {AdminViewProps} from './views/view-props';
import {showToast} from '@/components/app-toast';

type Props = {
  onLogout: () => Promise<void>;
  onNavigate: (page: string) => void;
  page: string;
  uid: string;
};

const pageInfo: Record<string, [string, string, string]> = {
  admin_ai_knowledge: ['AI Knowledge Monitor', 'ข้อมูลที่ AI ใช้ประกอบคำแนะนำ', 'auto_awesome'],
  admin_announcements: ['ประกาศ', 'ประกาศที่ส่งผ่าน Firebase', 'campaign'],
  admin_calendar: ['ปฏิทินรายผู้ใช้', 'เลือกผู้ใช้เพื่อดูกิจกรรมและตารางเรียนของคนนั้น', 'calendar_month'],
  admin_categories: ['จัดการหมวดหมู่', 'หมวดของโน้ต การเงิน และกิจกรรม', 'category'],
  admin_dashboard: ['Dashboard ภาพรวมระบบ', 'ติดตามการใช้งานและสถานะบริการของ SmartLife', 'dashboard'],
  admin_feedback: ['Feedback Center', 'ความคิดเห็นจากผู้ใช้จริง', 'forum'],
  admin_finance: ['การเงินรายผู้ใช้', 'รายรับ รายจ่าย เงินคงเหลือ และผลการสแกน OCR', 'account_balance_wallet'],
  admin_more: ['เมนูผู้ดูแล', 'เครื่องมือจัดการ SmartLife', 'apps'],
  admin_notes: ['โน้ตรายผู้ใช้', 'ดูว่าผู้ใช้แต่ละคนเขียนโน้ตแนวไหน', 'sticky_note_2'],
  admin_ocr_logs: ['OCR / Import Log', 'ประวัติการสแกนจาก Cloud Storage', 'document_scanner'],
  admin_system_health: ['System Health', 'สถานะบริการจากระบบจริง', 'monitor_heart'],
  admin_users: ['จัดการผู้ใช้', 'บัญชีผู้ใช้จาก Firebase Authentication', 'group'],
};

/**
 * Per-user views read the selected user's own collections directly and do not
 * need the aggregate `admin/<page>` payload, so the portal skips that fetch and
 * the Cloud Function calls behind it.
 */
const PER_USER_PAGES = new Set(['admin_calendar', 'admin_notes', 'admin_finance']);

const TABS: [icon: string, label: string, target: string][] = [
  ['dashboard', 'ภาพรวม', 'admin_dashboard'],
  ['calendar_month', 'ปฏิทิน', 'admin_calendar'],
  ['apps', '', 'admin_more'],
  ['sticky_note_2', 'โน้ต', 'admin_notes'],
  ['account_balance_wallet', 'การเงิน', 'admin_finance'],
];

const MORE_PAGES = [
  'admin_more', 'admin_users', 'admin_categories', 'admin_ocr_logs',
  'admin_announcements', 'admin_feedback', 'admin_ai_knowledge', 'admin_system_health',
];

function AdminTabs({active, onNavigate}: {active: string; onNavigate: (page: string) => void}) {
  return (
    <LinearGradient colors={['rgba(255,255,255,.99)', '#f6f8f3']} style={styles.tabs}>
      {TABS.map(([icon, label, target], index) => {
        const selected = active === target || (target === 'admin_more' && MORE_PAGES.includes(active));
        return (
          <Touchable
            accessibilityLabel={label || 'เมนูผู้ดูแล'}
            key={target}
            onPress={() => onNavigate(target)}
            style={({pressed}) => [styles.tab, pressed && styles.pressed]}
          >
            {index === 2 ? (
              <LinearGradient colors={selected ? ['#60875d', '#31572d'] : ['#789a75', '#4d7049']} style={styles.centerTab}>
                <MaterialIcon color="#fff" name="apps" size={28} />
              </LinearGradient>
            ) : (
              <>
                <MaterialIcon color={selected ? C.pine2 : '#9ea69b'} name={icon} size={20} />
                <Text style={[styles.tabText, selected && styles.tabTextActive]}>{label}</Text>
              </>
            )}
          </Touchable>
        );
      })}
    </LinearGradient>
  );
}

export default function AdminPortal({onLogout, onNavigate, page, uid}: Props) {
  const key = `admin/${page}`;
  const perUser = PER_USER_PAGES.has(page);
  const [loaded, setLoaded] = useState<{data: Data; key: string} | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  const data = useMemo(() => (loaded?.key === key ? loaded.data : {}), [key, loaded]);
  const loading = !perUser && loaded?.key !== key;
  const info = pageInfo[page] ?? pageInfo.admin_dashboard;

  const load = useCallback(async () => {
    if (perUser) return;
    setLoaded({data: (await loadLegacyPageData(uid, key)) as Data, key});
  }, [key, perUser, uid]);

  useEffect(() => {
    if (perUser) return;
    load().catch(() => setLoaded({data: {}, key}));
  }, [key, load, perUser]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // `Alert.alert` is a no-op on react-native-web, so the confirmation is a Modal
  // to keep logout working on the web build as well as on the native app.
  const logout = useCallback(() => { setLogoutError(''); setLogoutOpen(true); }, []);

  const confirmLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      await onLogout();
    } catch {
      setLogoutError('ออกจากระบบไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
      setLoggingOut(false);
    }
  }, [loggingOut, onLogout]);

  const handleAction = useCallback(async (
    id: string,
    action: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) => {
    setActionLoading(id);
    try {
      await runLegacyDataAction(uid, key, {action, payload});
      await load();
      if (successMessage) showToast('สำเร็จ', successMessage, 'success');
      return true;
    } catch (error) {
      showToast('ข้อผิดพลาด', error instanceof Error ? error.message : 'กรุณาลองอีกครั้ง');
      return false;
    } finally {
      setActionLoading(null);
    }
  }, [key, load, uid]);

  const viewProps: AdminViewProps = {actionLoading, data, onAction: handleAction, onNavigate, reload: load};

  const body = useMemo(() => {
    if (page === 'admin_calendar') return <AdminCalendarView />;
    if (page === 'admin_notes') return <AdminNotesView />;
    if (page === 'admin_finance') return <AdminFinanceView />;
    if (page === 'admin_dashboard') return <AdminDashboardView {...viewProps} />;
    if (page === 'admin_users') return <AdminUsersView {...viewProps} />;
    if (page === 'admin_categories') return <AdminCategoriesView {...viewProps} />;
    if (page === 'admin_announcements') return <AdminAnnouncementsView {...viewProps} />;
    if (page === 'admin_ocr_logs') return <AdminOcrLogsView {...viewProps} />;
    if (page === 'admin_feedback') return <AdminFeedbackView {...viewProps} />;
    if (page === 'admin_ai_knowledge') return <AdminAiKnowledgeView {...viewProps} />;
    if (page === 'admin_system_health') return <AdminSystemHealthView {...viewProps} onLogout={logout} />;
    return <AdminMoreView {...viewProps} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionLoading, data, handleAction, load, logout, onNavigate, page]);

  return (
    <ResponsiveSafeArea style={styles.safe}>
      <View style={styles.shell}>
        <LinearGradient colors={['#f7f9f4', '#eef3e9', '#e5ebdf']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />

        <LinearGradient colors={['rgba(255,255,255,.98)', 'rgba(240,245,236,.94)']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.headerLight}>
          {page === 'admin_dashboard' ? (
            <View style={styles.headerAvatar}><Text style={styles.headerAvatarText}>SL</Text></View>
          ) : (
            <Touchable
              accessibilityLabel="กลับหน้าภาพรวม"
              onPress={() => onNavigate('admin_dashboard')}
              style={({pressed}) => [styles.headerBack, pressed && styles.pressed]}
            >
              <MaterialIcon color={C.pine} name="chevron_left" size={25} />
            </Touchable>
          )}
          <View style={styles.headerCopy}>
            <Text style={styles.headerBrand}>SmartLife Admin</Text>
            <Text style={styles.adminTitle}>{page === 'admin_dashboard' ? 'ผู้ดูแลระบบ' : info[0]}</Text>
          </View>
          <Touchable
            accessibilityLabel="ออกจากระบบ"
            accessibilityRole="button"
            onPress={logout}
            style={({pressed}) => [styles.logoutButton, pressed && styles.pressed]}
          >
            <MaterialIcon color={C.red} name="logout" size={21} />
          </Touchable>
        </LinearGradient>

        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={perUser ? undefined : <RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={C.sage} />}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.pageHead}>
            <View style={styles.pageIcon}><MaterialIcon color={C.sage} name={info[2]} size={22} /></View>
            <View style={{flex: 1}}>
              <Text style={styles.title}>{info[0]}</Text>
              <Text style={styles.subtitle}>{info[1]}</Text>
            </View>
          </View>
          {loading ? <LoadingBlock /> : body}
        </ScrollView>

        <AdminTabs active={page} onNavigate={onNavigate} />

        <Modal animationType="fade" onRequestClose={() => { if (!loggingOut) setLogoutOpen(false); }} transparent visible={logoutOpen}>
          <View style={styles.modalBackdrop}>
            <Pressable disabled={loggingOut} onPress={() => setLogoutOpen(false)} style={StyleSheet.absoluteFill} />
            <View accessibilityViewIsModal style={styles.logoutDialog}>
              <View style={styles.logoutDialogIcon}><MaterialIcon color={C.red} name="logout" size={25} /></View>
              <Text style={styles.logoutDialogTitle}>ออกจากระบบ Admin?</Text>
              <Text style={styles.logoutDialogMessage}>ต้องการกลับไปหน้าเข้าสู่ระบบใช่ไหม?</Text>
              {logoutError ? (
                <View style={styles.logoutErrorBox}>
                  <MaterialIcon color={C.red} name="error" size={17} />
                  <Text style={styles.logoutErrorText}>{logoutError}</Text>
                </View>
              ) : null}
              <View style={styles.logoutActions}>
                <Touchable
                  disabled={loggingOut}
                  onPress={() => setLogoutOpen(false)}
                  style={({pressed}) => [styles.cancelLogout, pressed && styles.pressed, loggingOut && styles.disabled]}
                >
                  <Text style={styles.cancelLogoutText}>ยกเลิก</Text>
                </Touchable>
                <Touchable
                  disabled={loggingOut}
                  onPress={confirmLogout}
                  style={({pressed}) => [styles.confirmLogout, pressed && styles.pressed, loggingOut && styles.disabled]}
                >
                  {loggingOut ? (
                    <><ActivityIndicator color="#fff" size="small" /><Text style={styles.confirmLogoutText}>กำลังออก...</Text></>
                  ) : (
                    <><MaterialIcon color="#fff" name="logout" size={17} /><Text style={styles.confirmLogoutText}>ออกจากระบบ</Text></>
                  )}
                </Touchable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </ResponsiveSafeArea>
  );
}

const shadow = {shadowColor: C.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: 0.08, shadowRadius: 20};

const styles = StyleSheet.create({
  adminTitle: {color: C.pine, fontFamily: F.x, fontSize: 18, lineHeight: 22, marginTop: 1},
  cancelLogout: {alignItems: 'center', backgroundColor: '#eff3eb', borderRadius: 13, flex: 1, justifyContent: 'center', minHeight: 46},
  cancelLogoutText: {color: C.pine, fontFamily: F.b, fontSize: 12},
  centerTab: {...shadow, alignItems: 'center', borderColor: '#fff', borderRadius: 32, borderWidth: 5, height: 64, justifyContent: 'center', marginTop: -27, width: 64},
  confirmLogout: {alignItems: 'center', backgroundColor: C.red, borderRadius: 13, flex: 1.25, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46},
  confirmLogoutText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  content: {padding: 19, paddingBottom: 27},
  disabled: {opacity: 0.6},
  headerAvatar: {alignItems: 'center', backgroundColor: '#754b59', borderColor: '#fff', borderRadius: 24, borderWidth: 3, height: 46, justifyContent: 'center', width: 46},
  headerAvatarText: {color: '#fff', fontFamily: F.x, fontSize: 13},
  headerBack: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 20, height: 42, justifyContent: 'center', width: 42},
  headerBrand: {color: '#668d65', fontFamily: F.s, fontSize: 12},
  headerCopy: {flex: 1},
  headerLight: {alignItems: 'center', borderBottomColor: '#e5e9e1', borderBottomWidth: 1, flexDirection: 'row', gap: 10, justifyContent: 'space-between', minHeight: 76, paddingHorizontal: 19, paddingVertical: 12},
  logoutActions: {flexDirection: 'row', gap: 9, marginTop: 17},
  logoutButton: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderColor: 'rgba(201,103,97,.22)', borderRadius: 22, borderWidth: 1, height: 44, justifyContent: 'center', width: 44},
  logoutDialog: {...shadow, backgroundColor: '#fff', borderRadius: 22, maxWidth: 410, padding: 22, width: '88%'},
  logoutDialogIcon: {alignItems: 'center', alignSelf: 'center', backgroundColor: C.redSoft, borderRadius: 22, height: 48, justifyContent: 'center', marginBottom: 11, width: 48},
  logoutDialogMessage: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, textAlign: 'center'},
  logoutDialogTitle: {color: C.pine, fontFamily: F.x, fontSize: 19, marginBottom: 5, textAlign: 'center'},
  logoutErrorBox: {alignItems: 'center', backgroundColor: '#fff0ee', borderRadius: 10, flexDirection: 'row', gap: 7, marginTop: 12, padding: 9},
  logoutErrorText: {color: C.red, flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  modalBackdrop: {alignItems: 'center', backgroundColor: 'rgba(24,30,19,.48)', flex: 1, justifyContent: 'center', padding: 18},
  pageHead: {alignItems: 'center', flexDirection: 'row', gap: 11},
  pageIcon: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, height: 47, justifyContent: 'center', width: 47},
  pressed: {opacity: 0.78, transform: [{scale: 0.987}]},
  safe: {backgroundColor: C.pine, flex: 1},
  shell: {backgroundColor: C.mist, flex: 1},
  subtitle: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  tab: {alignItems: 'center', flex: 1, justifyContent: 'center'},
  tabText: {color: '#9da59a', fontFamily: F.m, fontSize: 12, marginTop: 3},
  tabTextActive: {color: C.pine2, fontFamily: F.b},
  tabs: {alignItems: 'center', borderTopColor: 'rgba(44,52,27,.08)', borderTopWidth: 1, flexDirection: 'row', height: 78, paddingHorizontal: 11},
  title: {color: C.pine, fontFamily: F.x, fontSize: 22},
});
