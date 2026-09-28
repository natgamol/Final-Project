import {useCallback, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {
  monthKeyFromMillis,
  monthRange,
  shiftMonth,
  summarizeFinance,
  type AdminTransactionInput,
} from '@/admin/analytics';
import {adminUserScans, adminUserTransactions, type AdminScanRecord} from '@/services/admin-user-data';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  AdminCard,
  C,
  Empty,
  ErrorBlock,
  F,
  LoadingBlock,
  Pill,
  SectionHead,
  ShareBar,
  SmallButton,
  StatTile,
  Tag,
  dateTimeFromMillis,
  money,
  monthLabel,
  percent,
  styles as ui,
} from '../admin-ui';
import {useAdminWorkspace} from '../admin-workspace';
import {useAsyncData} from '../use-async-data';
import UserPicker, {useSelectedUser, userLabel} from '../user-picker';

const CATEGORY_PALETTE = ['#6f966f', '#6572b1', '#c4943d', '#b98080', '#8a9a7b', '#a9b1a4'];
const PAGE_SIZE = 15;

const SOURCE_LABELS: Record<string, string> = {
  bank_auto_listener: 'ธนาคารอัตโนมัติ',
  line_auto_listener: 'LINE อัตโนมัติ',
  line_paste: 'วางจาก LINE',
  line_share: 'แชร์จาก LINE',
  manual_entry: 'กรอกเอง',
  receipt_scan: 'สแกนใบเสร็จ',
};

const PROVIDER_LABELS: Record<string, [string, string]> = {
  'google-vision': ['Google Vision', '#6572b1'],
  'google-vision-fallback': ['Vision (สำรอง)', '#8a9a7b'],
  iapp: ['iApp', C.amber],
  'iapp-document': ['iApp Document', C.amber],
};

type FinancePayload = {
  scans: AdminScanRecord[];
  transactions: AdminTransactionInput[];
};

/**
 * Per-user income, expense, and derived savings, plus read-only OCR review.
 *
 * SmartLife has no account entity and no stored savings balance, so figures are
 * per user and savings is income minus expense for the selected month.
 */
export default function AdminFinanceView() {
  const {monthKey, selectedUid, setMonthKey} = useAdminWorkspace();
  const selected = useSelectedUser();
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [showScans, setShowScans] = useState(false);

  const {from, to} = useMemo(() => monthRange(monthKey), [monthKey]);
  const load = useCallback(async (): Promise<FinancePayload> => {
    const uid = selectedUid as string;
    const [transactions, scans] = await Promise.all([
      adminUserTransactions(uid, from, to),
      adminUserScans(uid),
    ]);
    return {scans, transactions};
  }, [from, selectedUid, to]);

  const {data, error, loading, reload} = useAsyncData(
    `finance|${selectedUid ?? ''}|${monthKey}`,
    load,
    Boolean(selectedUid),
  );

  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const scans = useMemo(() => data?.scans ?? [], [data]);
  const summary = useMemo(() => summarizeFinance(transactions), [transactions]);

  /** OCR history is not month-scoped, so narrow it to the selected month here. */
  const monthScans = useMemo(() => scans.filter((scan) => {
    const at = scan.createdAtMs;
    return typeof at === 'number' && at >= from.getTime() && at < to.getTime();
  }), [from, scans, to]);

  const filtered = useMemo(() => transactions.filter((item) => {
    if (typeFilter === 'all') return true;
    return (item.type ?? '').toLowerCase() === typeFilter;
  }), [transactions, typeFilter]);

  const shown = filtered.slice(0, visible);
  const scansNeedingReview = monthScans.filter((scan) => scan.needsReview || scan.status === 'failed').length;

  return (
    <>
      <LinearGradient colors={['#777da5', '#9297bb']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={ui.insight}>
        <MaterialIcon color="#fff" name="account_balance_wallet" size={29} />
        <View style={{flex: 1}}>
          <Text style={ui.insightTitle}>การเงินรายผู้ใช้</Text>
          <Text style={ui.insightSub}>รายรับ รายจ่าย เงินคงเหลือ และใบเสร็จที่สแกนด้วย OCR</Text>
        </View>
      </LinearGradient>

      <UserPicker subtitle="ติดตามรายรับ รายจ่าย และเงินคงเหลือของผู้ใช้แต่ละคน" />

      {!selectedUid ? (
        <AdminCard><Empty icon="account_balance_wallet" label="เลือกผู้ใช้ด้านบนเพื่อดูข้อมูลการเงิน" /></AdminCard>
      ) : (
        <>
          <AdminCard>
            <View style={local.monthBar}>
              <Touchable
                accessibilityLabel="เดือนก่อนหน้า"
                onPress={() => setMonthKey(shiftMonth(monthKey, -1))}
                style={({pressed}) => [local.monthNav, pressed && ui.pressed]}
              >
                <MaterialIcon color={C.pine} name="chevron_left" size={22} />
              </Touchable>
              <View style={{alignItems: 'center', flex: 1}}>
                <Text style={local.monthTitle}>{monthLabel(monthKey)}</Text>
                <Text style={local.monthSub}>การเงินของ {userLabel(selected)}</Text>
              </View>
              <Touchable
                accessibilityLabel="เดือนถัดไป"
                onPress={() => setMonthKey(shiftMonth(monthKey, 1))}
                style={({pressed}) => [local.monthNav, pressed && ui.pressed]}
              >
                <MaterialIcon color={C.pine} name="chevron_right" size={22} />
              </Touchable>
            </View>
            <View style={local.monthActions}>
              <SmallButton icon="today" label="เดือนปัจจุบัน" onPress={() => setMonthKey(monthKeyFromMillis(Date.now()))} tone="green" />
              <SmallButton icon="refresh" label="รีเฟรช" loading={loading} onPress={reload} tone="purple" />
            </View>
          </AdminCard>

          {error ? <ErrorBlock message={error} onRetry={reload} /> : null}
          {loading && !data ? <LoadingBlock label="กำลังโหลดข้อมูลการเงิน" /> : null}

          {!error && !loading ? (
            <>
              <AdminCard>
                <SectionHead meta={`${summary.transactionCount} รายการ`} title="สรุปรายรับ-รายจ่าย" />
                <View style={ui.tileRow}>
                  <StatTile label="รายรับ" tone="green" value={money(summary.income)} />
                  <StatTile label="รายจ่าย" tone="red" value={money(summary.expense)} />
                </View>
                <View style={ui.tileRow}>
                  <StatTile
                    hint="รายรับ − รายจ่าย"
                    label="คงเหลือ / เงินออม"
                    tone={summary.net >= 0 ? 'green' : 'red'}
                    value={money(summary.net)}
                  />
                  <StatTile
                    hint={summary.income > 0 ? 'ของรายรับ' : 'ไม่มีรายรับในเดือนนี้'}
                    label="อัตราการออม"
                    tone={summary.savingsRate >= 0 ? 'purple' : 'red'}
                    value={percent(summary.savingsRate)}
                  />
                </View>
                {summary.needsReview ? (
                  <Text style={local.warnNotice}>
                    มี {summary.needsReview} รายการที่ระบบตั้งค่าสถานะว่าต้องตรวจสอบ ยอดรวมด้านบนรวมรายการเหล่านี้ไว้ด้วย
                  </Text>
                ) : null}
              </AdminCard>

              <AdminCard>
                <SectionHead meta={`${summary.topExpenseCategories.length} หมวด`} title="รายจ่ายตามหมวด" />
                {summary.topExpenseCategories.length ? (
                  <>
                    <ShareBar
                      segments={summary.topExpenseCategories.map((item, index) => ({
                        color: CATEGORY_PALETTE[index % CATEGORY_PALETTE.length],
                        key: item.category,
                        share: item.share,
                      }))}
                    />
                    {summary.topExpenseCategories.map((item, index) => (
                      <View key={item.category} style={local.categoryRow}>
                        <View style={[ui.colorDot, {backgroundColor: CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]}]} />
                        <Text style={local.categoryLabel}>{item.category}</Text>
                        <Text style={local.categoryCount}>{item.count} รายการ</Text>
                        <Text style={local.categoryAmount}>{money(item.amount)}</Text>
                        <Text style={local.categoryShare}>{percent(item.share)}</Text>
                      </View>
                    ))}
                  </>
                ) : <Empty icon="pie_chart" label="ยังไม่มีรายจ่ายในเดือนนี้" />}
              </AdminCard>

              <AdminCard>
                <SectionHead
                  meta={`${monthScans.length} สแกนในเดือนนี้`}
                  title="OCR / ใบเสร็จที่สแกน"
                />
                <Text style={local.ocrNote}>
                  ผู้ดูแลดูผลการสแกนของผู้ใช้ได้อย่างเดียว การอัปโหลดใบเสร็จยังทำได้เฉพาะเจ้าของบัญชีเท่านั้น
                </Text>
                <View style={ui.tileRow}>
                  <StatTile hint="ในเดือนนี้" label="รายการจาก OCR" tone="purple" value={String(summary.fromOcr)} />
                  <StatTile label="ต้องตรวจสอบ" tone={scansNeedingReview ? 'amber' : 'green'} value={String(scansNeedingReview)} />
                </View>

                <Touchable onPress={() => setShowScans((value) => !value)} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
                  <MaterialIcon color={C.pine} name={showScans ? 'expand_less' : 'expand_more'} size={16} />
                  <Text style={ui.refreshButtonText}>{showScans ? 'ซ่อนประวัติการสแกน' : 'ดูประวัติการสแกน'}</Text>
                </Touchable>

                {showScans ? (
                  monthScans.length ? monthScans.map((scan) => {
                    const [providerLabel, providerColor] = PROVIDER_LABELS[scan.provider] ?? ['ไม่ระบุผู้ให้บริการ', C.muted];
                    const failed = scan.status === 'failed';
                    return (
                      <View key={scan.id} style={local.scanRow}>
                        <View style={[local.scanIcon, {backgroundColor: failed ? C.redSoft : '#eef0fb'}]}>
                          <MaterialIcon
                            color={failed ? C.red : '#6572b1'}
                            name={scan.kind === 'receipt' ? 'receipt_long' : 'document_scanner'}
                            size={18}
                          />
                        </View>
                        <View style={{flex: 1}}>
                          <Text style={local.scanTitle}>
                            {scan.kind === 'receipt' ? 'สแกนใบเสร็จ' : 'สแกนตารางเรียน'}
                          </Text>
                          <Text style={local.scanMeta}>{dateTimeFromMillis(scan.createdAtMs)}</Text>
                          <View style={local.scanTags}>
                            <Tag backgroundColor={`${providerColor}1f`} color={providerColor} label={providerLabel} />
                            <Tag
                              backgroundColor={failed ? C.redSoft : '#e8f0e5'}
                              color={failed ? C.red : '#5a8d5d'}
                              label={scan.status}
                            />
                            {typeof scan.confidence === 'number' ? (
                              <Tag label={`ความแม่นยำ ${percent(scan.confidence)}`} />
                            ) : null}
                            {scan.needsReview ? <Tag backgroundColor={C.amberSoft} color={C.amber} label="ต้องตรวจสอบ" /> : null}
                          </View>
                        </View>
                      </View>
                    );
                  }) : <Empty icon="document_scanner" label="ไม่มีการสแกนในเดือนนี้" />
                ) : null}
              </AdminCard>

              <AdminCard>
                <SectionHead meta={`${filtered.length} รายการ`} title="รายการธุรกรรม" />
                <View style={ui.pillRow}>
                  <Pill label="ทั้งหมด" onPress={() => { setTypeFilter('all'); setVisible(PAGE_SIZE); }} selected={typeFilter === 'all'} />
                  <Pill label="รายรับ" onPress={() => { setTypeFilter('income'); setVisible(PAGE_SIZE); }} selected={typeFilter === 'income'} />
                  <Pill label="รายจ่าย" onPress={() => { setTypeFilter('expense'); setVisible(PAGE_SIZE); }} selected={typeFilter === 'expense'} />
                </View>

                {!shown.length ? <Empty icon="receipt_long" label="ไม่มีธุรกรรมตามตัวกรองนี้" /> : null}

                {shown.map((item) => {
                  const income = (item.type ?? '').toLowerCase() === 'income';
                  const needsReview = (item.status ?? '').toLowerCase() === 'needs_review';
                  return (
                    <View key={item.id} style={local.txRow}>
                      <View style={[local.txIcon, {backgroundColor: income ? '#e8f0e5' : C.redSoft}]}>
                        <MaterialIcon
                          color={income ? '#5a8d5d' : C.red}
                          name={income ? 'arrow_downward' : 'arrow_upward'}
                          size={18}
                        />
                      </View>
                      <View style={{flex: 1}}>
                        <Text numberOfLines={1} style={local.txTitle}>{item.merchant || item.category || 'ไม่ระบุ'}</Text>
                        <Text style={local.txMeta}>
                          {item.category || 'ไม่ระบุหมวด'} · {dateTimeFromMillis(item.occurredAtMs)}
                        </Text>
                        <View style={local.scanTags}>
                          <Tag label={SOURCE_LABELS[item.source ?? ''] ?? 'ไม่ระบุที่มา'} />
                          {item.scanId ? <Tag backgroundColor="#eef0fb" color="#6572b1" label="จาก OCR" /> : null}
                          {needsReview ? <Tag backgroundColor={C.amberSoft} color={C.amber} label="ต้องตรวจสอบ" /> : null}
                        </View>
                      </View>
                      <Text style={[local.txAmount, {color: income ? '#5a8d5d' : C.red}]}>
                        {income ? '+' : '-'}{money(Math.abs(Number(item.amount) || 0))}
                      </Text>
                    </View>
                  );
                })}

                {filtered.length > shown.length ? (
                  <Touchable onPress={() => setVisible((current) => current + PAGE_SIZE)} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
                    <MaterialIcon color={C.pine} name="expand_more" size={16} />
                    <Text style={ui.refreshButtonText}>ดูเพิ่มอีก {Math.min(PAGE_SIZE, filtered.length - shown.length)} รายการ</Text>
                  </Touchable>
                ) : null}
              </AdminCard>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

const local = StyleSheet.create({
  categoryAmount: {color: C.pine, fontFamily: F.b, fontSize: 12, minWidth: 74, textAlign: 'right'},
  categoryCount: {color: C.muted, fontFamily: F.r, fontSize: 12},
  categoryLabel: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12},
  categoryRow: {alignItems: 'center', borderBottomColor: 'rgba(44,52,27,.06)', borderBottomWidth: 1, flexDirection: 'row', gap: 8, paddingVertical: 9},
  categoryShare: {color: C.muted, fontFamily: F.s, fontSize: 12, minWidth: 36, textAlign: 'right'},
  monthActions: {flexDirection: 'row', gap: 8, marginTop: 10},
  monthBar: {alignItems: 'center', flexDirection: 'row', gap: 8},
  monthNav: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, height: 38, justifyContent: 'center', width: 38},
  monthSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  monthTitle: {color: C.pine, fontFamily: F.b, fontSize: 14},
  ocrNote: {backgroundColor: C.purpleSoft, borderRadius: 10, color: '#4d568c', fontFamily: F.m, fontSize: 12, lineHeight: 18, marginTop: 9, padding: 9},
  scanIcon: {alignItems: 'center', borderRadius: 13, height: 38, justifyContent: 'center', width: 38},
  scanMeta: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  scanRow: {alignItems: 'flex-start', backgroundColor: '#f5f8f2', borderRadius: 13, flexDirection: 'row', gap: 10, marginTop: 9, padding: 11},
  scanTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6},
  scanTitle: {color: C.pine, fontFamily: F.s, fontSize: 12},
  txAmount: {fontFamily: F.b, fontSize: 12},
  txIcon: {alignItems: 'center', borderRadius: 13, height: 38, justifyContent: 'center', width: 38},
  txMeta: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  txRow: {alignItems: 'flex-start', backgroundColor: '#f5f8f2', borderRadius: 13, flexDirection: 'row', gap: 10, marginTop: 9, padding: 11},
  txTitle: {color: C.pine, fontFamily: F.s, fontSize: 12},
  warnNotice: {backgroundColor: C.amberSoft, borderRadius: 10, color: '#8a6b28', fontFamily: F.m, fontSize: 12, marginTop: 12, padding: 9},
});
