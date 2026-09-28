import {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import LoadingAndSuccessModal, {type FeedbackPhase} from '@/components/loading-success-modal';
import {scanLogs} from '@/services/firestore';
import type {ScanLog, ScanKind, WithId} from '@/types/smartlife';
import {MaterialIcon, UserHeader, UserShell, type UserNavigate} from './user-ui';
import {showToast} from '@/components/app-toast';

type Filter = 'all' | ScanKind;
type Feedback = {phase: FeedbackPhase; subtitle: string; title: string} | null;

const C = {finance: '#9297bb', muted: '#858b80', pine: '#2c341b', sage: '#6f8f6d'};
const F = {b: 'Prompt_700Bold', r: 'Prompt_400Regular', s: 'Prompt_600SemiBold'};

function parsedObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scanDate(value: unknown) {
  const date = value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function'
    ? value.toDate() as Date
    : null;
  if (!date || Number.isNaN(date.getTime())) return 'กำลังบันทึกเวลา';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'short',
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
  }).format(date);
}

function scanSummary(item: WithId<ScanLog>) {
  const parsed = parsedObject(item.parsed);
  if (item.kind === 'receipt') {
    const merchant = typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant : 'ไม่พบชื่อร้าน';
    const amount = Number(parsed.total ?? 0);
    return `${merchant} · ${amount > 0 ? `฿${amount.toLocaleString('th-TH', {maximumFractionDigits: 2})}` : 'ไม่พบยอดเงิน'}`;
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const codes = entries.map((entry) => parsedObject(entry).courseCode).filter((value): value is string => typeof value === 'string' && Boolean(value)).slice(0, 3);
  return codes.length ? `${codes.join(', ')}${entries.length > codes.length ? ` และอีก ${entries.length - codes.length} วิชา` : ''}` : 'ยังไม่พบรหัสวิชา';
}

function statusText(status: ScanLog['status']) {
  return status === 'completed' ? 'สำเร็จ' : status === 'failed' ? 'ไม่สำเร็จ' : 'กำลังประมวลผล';
}

export default function OcrHistoryScreen({uid, onNavigate}: {uid: string; onNavigate: UserNavigate}) {
  const [items, setItems] = useState<WithId<ScanLog>[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [deleteTarget, setDeleteTarget] = useState<WithId<ScanLog> | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = scanLogs.watchList(uid, (nextItems) => {
      setItems(nextItems);
      setLoading(false);
    }, (error) => {
      console.error('[OCR History] Unable to watch scan logs', error);
      setLoading(false);
      showToast('โหลดประวัติไม่สำเร็จ', 'กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    });
    return unsubscribe;
  }, [uid]);

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  const filteredItems = useMemo(() => filter === 'all' ? items : items.filter((item) => item.kind === filter), [filter, items]);
  const receiptCount = items.filter((item) => item.kind === 'receipt').length;
  const scheduleCount = items.filter((item) => item.kind === 'schedule').length;

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setFeedback({phase: 'loading', subtitle: 'กำลังลบรายการออกจาก Firebase อย่างปลอดภัย', title: 'กำลังลบประวัติ'});
    try {
      await scanLogs.remove(uid, target.id);
      setFeedback({phase: 'success', subtitle: 'ลบประวัติ OCR เรียบร้อยแล้ว', title: 'ลบสำเร็จ'});
      feedbackTimer.current = setTimeout(() => setFeedback(null), 850);
    } catch (error) {
      console.error('[OCR History] Delete failed', {error, id: target.id});
      setFeedback(null);
      showToast('ลบไม่สำเร็จ', 'กรุณาลองใหม่อีกครั้ง');
    }
  };

  return <UserShell active="smartlife_scan_schedule" onNavigate={onNavigate} scroll={false}>
    <UserHeader onNavigate={onNavigate} right={<Touchable accessibilityLabel="เปิด Smart Scan" onPress={() => onNavigate('smartlife_scan_schedule')} style={styles.headerAction}><MaterialIcon color="#fff" name="document_scanner" size={21} /></Touchable>} subtitle="รายการสแกนจริงจาก Firebase" title="ประวัติ OCR" />
    <FlatList
      contentContainerStyle={[styles.list, !filteredItems.length && styles.listEmpty]}
      data={filteredItems}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={loading ? <View style={styles.empty}><ActivityIndicator color={C.sage} size="large" /><Text style={styles.emptyText}>กำลังโหลดประวัติ OCR</Text></View> : <View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcon color={C.sage} name="history" size={31} /></View><Text style={styles.emptyTitle}>ยังไม่มีประวัติในหมวดนี้</Text><Text style={styles.emptyText}>สแกนสลิปหรือตารางเรียนแล้วรายการจะปรากฏที่นี่</Text></View>}
      ListHeaderComponent={<View>
        <LinearGradient colors={['#789a75', '#91a69a', '#9297bb']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.summary}>
          <View><Text style={styles.summaryLabel}>สแกนทั้งหมด</Text><Text style={styles.summaryValue}>{items.length}</Text></View>
          <View style={styles.summarySplit} />
          <View style={styles.summaryMini}><Text style={styles.summaryMiniValue}>{scheduleCount}</Text><Text style={styles.summaryMiniLabel}>ตารางเรียน</Text></View>
          <View style={styles.summaryMini}><Text style={styles.summaryMiniValue}>{receiptCount}</Text><Text style={styles.summaryMiniLabel}>การเงิน</Text></View>
        </LinearGradient>
        <View style={styles.filters}>{([['all', 'ทั้งหมด'], ['schedule', 'ตารางเรียน'], ['receipt', 'การเงิน']] as [Filter, string][]).map(([value, label]) => <Touchable key={value} onPress={() => setFilter(value)} style={[styles.filter, filter === value && styles.filterActive]}><Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{label}</Text></Touchable>)}</View>
        <View style={styles.listTitleRow}><Text style={styles.listTitle}>รายการล่าสุด</Text><Text style={styles.listCount}>{filteredItems.length} รายการ</Text></View>
      </View>}
      renderItem={({item}) => <HistoryItem item={item} onDelete={() => setDeleteTarget(item)} />}
      showsVerticalScrollIndicator={false}
    />

    <Modal animationType="fade" onRequestClose={() => setDeleteTarget(null)} statusBarTranslucent transparent visible={Boolean(deleteTarget)}>
      <Pressable onPress={() => setDeleteTarget(null)} style={styles.confirmOverlay}>
        <View onStartShouldSetResponder={() => true} style={styles.confirmPanel}>
          <LinearGradient colors={['#fff9f8', '#f8eeee']} style={styles.confirmIcon}><MaterialIcon color="#b85f60" name="delete_forever" size={30} /></LinearGradient>
          <Text style={styles.confirmTitle}>ลบประวัตินี้หรือไม่?</Text>
          <Text style={styles.confirmText}>รายการจะถูกลบออกจากประวัติ OCR อย่างถาวร แต่ข้อมูลการเงินหรือตารางเรียนที่เคยบันทึกไว้จะยังอยู่</Text>
          <View style={styles.confirmActions}>
            <Touchable onPress={() => setDeleteTarget(null)} style={styles.cancelButton}><Text style={styles.cancelText}>ยกเลิก</Text></Touchable>
            <Touchable onPress={confirmDelete} style={styles.deleteButton}><LinearGradient colors={['#c47c7b', '#a95758']} style={styles.deleteGradient}><MaterialIcon color="#fff" name="delete" size={18} /><Text style={styles.deleteText}>ลบถาวร</Text></LinearGradient></Touchable>
          </View>
        </View>
      </Pressable>
    </Modal>

    <LoadingAndSuccessModal phase={feedback?.phase ?? 'loading'} subtitle={feedback?.subtitle ?? ''} title={feedback?.title ?? ''} visible={Boolean(feedback)} />
  </UserShell>;
}

function HistoryItem({item, onDelete}: {item: WithId<ScanLog>; onDelete: () => void}) {
  const receipt = item.kind === 'receipt';
  const success = item.status === 'completed';
  return <View style={styles.item}>
    <View style={[styles.itemIcon, {backgroundColor: receipt ? '#ececf6' : '#e7efe3'}]}><MaterialIcon color={receipt ? C.finance : C.sage} name={receipt ? 'receipt_long' : 'calendar_month'} size={23} /></View>
    <View style={styles.itemBody}>
      <View style={styles.itemTitleRow}><Text style={styles.itemTitle}>{receipt ? 'สลิป / ใบเสร็จ' : 'ตารางเรียน'}</Text><View style={[styles.status, !success && styles.statusMuted]}><Text style={[styles.statusText, !success && styles.statusTextMuted]}>{statusText(item.status)}</Text></View></View>
      <Text numberOfLines={2} style={styles.itemSummary}>{scanSummary(item)}</Text>
      <View style={styles.itemMeta}><MaterialIcon color={C.muted} name="schedule" size={13} /><Text style={styles.itemDate}>{scanDate(item.createdAt)}</Text></View>
    </View>
    <Touchable accessibilityLabel={`ลบประวัติ${receipt ? 'การเงิน' : 'ตารางเรียน'}`} accessibilityRole="button" onPress={onDelete} style={({pressed}) => [styles.trash, pressed && styles.pressed]}><MaterialIcon color="#b56869" name="delete_outline" size={20} /></Touchable>
  </View>;
}

const styles = StyleSheet.create({
  cancelButton: {alignItems: 'center', backgroundColor: '#eef2ea', borderRadius: 13, flex: 1, justifyContent: 'center', minHeight: 46},
  cancelText: {color: C.pine, fontFamily: F.s, fontSize: 12},
  confirmActions: {flexDirection: 'row', gap: 9, marginTop: 20},
  confirmIcon: {alignItems: 'center', borderRadius: 22, height: 66, justifyContent: 'center', width: 66},
  confirmOverlay: {alignItems: 'center', backgroundColor: 'rgba(28,36,23,.58)', flex: 1, justifyContent: 'center', padding: 25},
  confirmPanel: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 24, maxWidth: 330, padding: 22, shadowColor: '#1d2819', shadowOffset: {height: 20, width: 0}, shadowOpacity: .3, shadowRadius: 34, width: '100%'},
  confirmText: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 7, textAlign: 'center'},
  confirmTitle: {color: C.pine, fontFamily: F.b, fontSize: 17, marginTop: 14},
  deleteButton: {borderRadius: 13, flex: 1, overflow: 'hidden'},
  deleteGradient: {alignItems: 'center', flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 46},
  deleteText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  empty: {alignItems: 'center', gap: 8, paddingHorizontal: 26, paddingVertical: 60},
  emptyIcon: {alignItems: 'center', backgroundColor: '#e8efe4', borderRadius: 24, height: 68, justifyContent: 'center', width: 68},
  emptyText: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, textAlign: 'center'},
  emptyTitle: {color: C.pine, fontFamily: F.b, fontSize: 14},
  filter: {alignItems: 'center', borderRadius: 11, flex: 1, minHeight: 38, justifyContent: 'center'},
  filterActive: {backgroundColor: '#fff', shadowColor: C.pine, shadowOffset: {height: 4, width: 0}, shadowOpacity: .08, shadowRadius: 9},
  filterText: {color: C.muted, fontFamily: F.s, fontSize: 12},
  filterTextActive: {color: C.sage},
  filters: {backgroundColor: '#e8eee5', borderRadius: 14, flexDirection: 'row', marginTop: 13, padding: 4},
  headerAction: {alignItems: 'center', backgroundColor: C.sage, borderRadius: 20, height: 41, justifyContent: 'center', shadowColor: C.pine, shadowOffset: {height: 6, width: 0}, shadowOpacity: .16, shadowRadius: 11, width: 41},
  item: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.96)', borderColor: '#e4e8e0', borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 11, marginTop: 9, padding: 12, shadowColor: C.pine, shadowOffset: {height: 7, width: 0}, shadowOpacity: .06, shadowRadius: 15},
  itemBody: {flex: 1, minWidth: 0},
  itemDate: {color: C.muted, fontFamily: F.r, fontSize: 12},
  itemIcon: {alignItems: 'center', borderRadius: 16, height: 48, justifyContent: 'center', width: 48},
  itemMeta: {alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 6},
  itemSummary: {color: '#667061', fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 3},
  itemTitle: {color: C.pine, flex: 1, fontFamily: F.b, fontSize: 12},
  itemTitleRow: {alignItems: 'center', flexDirection: 'row', gap: 6},
  list: {padding: 18, paddingBottom: 30},
  listCount: {color: C.muted, fontFamily: F.r, fontSize: 12},
  listEmpty: {flexGrow: 1},
  listTitle: {color: C.pine, fontFamily: F.b, fontSize: 13},
  listTitleRow: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2, marginTop: 17},
  pressed: {opacity: .7, transform: [{scale: .94}]},
  status: {backgroundColor: '#e4efe0', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 3},
  statusMuted: {backgroundColor: '#f1ece8'},
  statusText: {color: '#52754e', fontFamily: F.s, fontSize: 12},
  statusTextMuted: {color: '#9a7771'},
  summary: {alignItems: 'center', borderRadius: 19, flexDirection: 'row', minHeight: 108, overflow: 'hidden', padding: 17, shadowColor: C.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: .16, shadowRadius: 20},
  summaryLabel: {color: 'rgba(255,255,255,.78)', fontFamily: F.r, fontSize: 12},
  summaryMini: {alignItems: 'center', flex: 1},
  summaryMiniLabel: {color: 'rgba(255,255,255,.76)', fontFamily: F.r, fontSize: 12, marginTop: 2},
  summaryMiniValue: {color: '#fff', fontFamily: F.b, fontSize: 18},
  summarySplit: {backgroundColor: 'rgba(255,255,255,.25)', height: 48, marginHorizontal: 14, width: 1},
  summaryValue: {color: '#fff', fontFamily: F.b, fontSize: 30, lineHeight: 36},
  trash: {alignItems: 'center', backgroundColor: '#faefed', borderRadius: 15, height: 38, justifyContent: 'center', width: 38},
});
