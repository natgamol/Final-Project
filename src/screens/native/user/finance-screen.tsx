/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Modal, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {router, useLocalSearchParams} from 'expo-router';
import {financeDate} from '@/lib/ux-time';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import {Touchable} from '@/components/touchable';
import {AnimatedNumber, Reveal} from '@/components/motion';
import {SpendingCharts} from '@/components/spending-charts';
import ConfirmDialog from '@/components/confirm-dialog';

import {thailandRange, thailandDateKey, thailandCalendarParts} from '@/lib/thailand-time';
import {calculateDailyAllowance, calculateFinanceBudgetInsight} from '@/services/dynamic-insights';
import {loadLegacyPageData} from '@/services/legacy-data';
import {currentMonthKey, loadMonthlyBudget} from '@/services/monthly-budget';
import {transactions} from '@/services/firestore';
import {EXPENSE_CATEGORIES, expenseCategoryIcon, normalizeExpenseCategory} from '@/config/expense-categories';
import {useTourTarget} from '@/hooks/use-tour-target';
import {useTour} from '@/providers/tour-provider';
import {MaterialIcon, UserGradientBackdrop, UserTabBar} from './user-ui';

type Page = 'smartlife_finance_day' | 'smartlife_finance_week' | 'smartlife_finance_month' | 'smartlife_finance_income' | 'smartlife_finance_expense';
type Props = {onNavigate: (page: string) => void; page: Page; uid: string};
type Item = Record<string, unknown>;
type Filter = 'all' | 'income' | 'expense';
type Period = 'day' | 'week' | 'month';
const C = {accent: '#626fa8', accentSoft: '#eceef8', ink: '#29351f', mist: '#f4f6f1', muted: '#89928a', red: '#db6762', redSoft: '#fde9e1', sage: '#618661', sageSoft: '#e2eddf'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};
const periods: {label: string; page: 'smartlife_finance_day' | 'smartlife_finance_week' | 'smartlife_finance_month'}[] = [{label: 'วัน', page: 'smartlife_finance_day'}, {label: 'สัปดาห์', page: 'smartlife_finance_week'}, {label: 'เดือน', page: 'smartlife_finance_month'}];
// Keep every finance receipt shortcut on the shared Smart Scan landing page.
// The scanner classifies the selected document after the user uploads it.
const SMART_SCAN_PAGE = 'smartlife_scan_finance';

function list(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === 'object') : []; }
function str(item: Item, key: string, fallback = '-') { const value = item[key]; return typeof value === 'string' && value.trim() ? value : fallback; }
function money(value: number) { return `${value < 0 ? '-' : ''}฿${Math.abs(value).toLocaleString('th-TH')}`; }
function date(value: unknown) { const result = new Date(String(value ?? '')); return Number.isNaN(result.getTime()) ? '-' : new Intl.DateTimeFormat('th-TH', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok'}).format(result); }
function periodText(page: Page) { return page === 'smartlife_finance_week' ? 'สัปดาห์นี้' : page === 'smartlife_finance_month' ? 'เดือนนี้' : 'วันนี้'; }
// The budget card always sets one monthly limit, whichever tab is open. Only
// the wording follows the tab, so the split it promises is the one the user is
// actually looking at instead of always naming the weekly frame.
function budgetCardTitle(period: Period) {
  if (period === 'day') return 'กำหนดงบรายวัน';
  if (period === 'month') return 'กำหนดขอบเขตการใช้';
  return 'กำหนดงบและกรอบรายสัปดาห์';
}
function budgetCardSubtitle(period: Period, budget: {amount: number; rolledOver: boolean} | null) {
  if (!budget) {
    if (period === 'day') return 'ตั้งวงเงิน แล้ว AI แบ่งเป็นงบรายวันให้';
    if (period === 'month') return 'ตั้งวงเงิน แล้ว AI คุมยอดรวมทั้งเดือน';
    return 'ตั้งวงเงิน แล้ว AI คุมยอดรวมเป็นรายสัปดาห์';
  }
  const limit = `วงเงินเดือน ${money(budget.amount)}${budget.rolledOver ? ' (ต่อจากเดือนก่อน รอยืนยัน)' : ''}`;
  if (period === 'day') return `${limit} · AI แบ่งให้เป็นงบรายวัน`;
  if (period === 'month') return `${limit} · AI คุมยอดรวมทั้งเดือน`;
  return `${limit} · AI แบ่งให้เป็นรายสัปดาห์`;
}
function periodForPage(page: string): 'day' | 'week' | 'month' {
  return page.includes('_month') ? 'month' : page.includes('_week') ? 'week' : 'day';
}

function shiftPeriod(value: Date, period: 'day' | 'week' | 'month', direction: -1 | 1) {
  const {year, month} = thailandCalendarParts(value);
  if (period === 'month') return new Date(Date.UTC(year, month + direction, 1, 5));
  return new Date(value.getTime() + direction * (period === 'week' ? 7 : 1) * 86400000);
}

function selectedRangeLabel(page: string, referenceDate: Date) {
  const period = periodForPage(page);
  const {from, to} = thailandRange(period, referenceDate);
  const formatter = new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok',
  });
  if (period === 'day') return formatter.format(from);
  if (period === 'month') {
    return new Intl.DateTimeFormat('th-TH', {
      month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok',
    }).format(from);
  }
  return `${formatter.format(from)} - ${formatter.format(to)}`;
}

// Icons come from the shared category list, so a category added there shows
// the right icon here without a second regex table drifting out of sync.
const categoryIcon = expenseCategoryIcon;

export default function FinanceScreen({onNavigate, page, uid}: Props) {
  const {maybeStartTour} = useTour();
  const {ref: periodTabsRef, onLayout: periodTabsOnLayout} = useTourTarget('finance', 'period-tabs');
  const {ref: rangeBarRef, onLayout: rangeBarOnLayout} = useTourTarget('finance', 'range-bar');
  const scrollViewRef = useRef<ScrollView>(null);
  useEffect(() => {
    // Scroll to the very top before the tour measures the period-tabs bar so
    // that measureInWindow returns the element's real on-screen position, not a
    // position shifted by however far down the user has already scrolled.
    scrollViewRef.current?.scrollTo({y: 0, animated: false});
    maybeStartTour('finance');
  }, [maybeStartTour]);
  const [data, setData] = useState<Item | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadVersion = useRef(0);
  const [monthlyBudget, setMonthlyBudget] = useState<{amount: number; rolledOver: boolean} | null>(null);
  const [monthData, setMonthData] = useState<Item | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const params = useLocalSearchParams<{period?: string; date?: string; filter?: string}>();
  const period: Period = params.period === 'week' || params.period === 'month' || params.period === 'day' ? params.period : periodForPage(page);
  const referenceDate = useMemo(() => financeDate(params.date), [params.date, page]);
  const filter: Filter = params.filter === 'income' || params.filter === 'expense' || params.filter === 'all' ? params.filter : page === 'smartlife_finance_income' ? 'income' : page === 'smartlife_finance_expense' ? 'expense' : 'all';
  const selectRange = (nextPeriod = period, nextDate = referenceDate, nextFilter = filter) => {
    router.push({pathname: '/[section]/[page]', params: {section: 'user', page: 'smartlife_finance_day', period: nextPeriod, date: thailandDateKey(nextDate), filter: nextFilter}});
  };
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const [recategorizing, setRecategorizing] = useState<Item | null>(null);
  const [categoryError, setCategoryError] = useState(false);
  const periodPage = `smartlife_finance_${period}` as 'smartlife_finance_day' | 'smartlife_finance_week' | 'smartlife_finance_month';
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoadError(false);
    setData(null);
    try {
    const [pageData, savedBudget, monthPage] = await Promise.all([
      loadLegacyPageData(uid, `user/${periodPage}`, referenceDate) as Promise<Item>,
      loadMonthlyBudget(uid, currentMonthKey()),
      // The weekly and monthly windows are month-scoped whatever tab is open,
      // so the month's spending is fetched unless this tab already is it.
      period === 'month' ? Promise.resolve(null)
        : (loadLegacyPageData(uid, 'user/smartlife_finance_month') as Promise<Item>),
    ]);
    if (version !== loadVersion.current) return;
    setData(pageData);
    setMonthData(monthPage);
    setMonthlyBudget(savedBudget ? {amount: savedBudget.amount, rolledOver: Boolean(savedBudget.rolledOverFrom)} : null);
    } catch (error) {
      console.error('[Finance] Data load failed', error);
      if (version === loadVersion.current) setLoadError(true);
    }
  }, [period, periodPage, referenceDate, uid]);
  useEffect(() => { void load(); return () => { loadVersion.current += 1; }; }, [load]);
  const refresh = useCallback(async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }, [load]);
  const all = useMemo(() => list(data?.transactions), [data]);
  const income = all.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const expense = all.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const balance = income - expense;
  const shown = filter === 'income' ? all.filter((item) => item.type === 'income') : filter === 'expense' ? all.filter((item) => item.type === 'expense') : all;
  const mainAmount = filter === 'income' ? income : filter === 'expense' ? expense : balance;
  const mainLabel = filter === 'income' ? `รายรับ${periodText(periodPage)}` : filter === 'expense' ? `รายจ่าย${periodText(periodPage)}` : 'ยอดสุทธิ รายรับ − รายจ่าย';
  // The budget read-out for whichever period is on screen. Every figure comes
  // from the calculators the dashboard and the notification bell already use,
  // so the three surfaces cannot quote different numbers. Only the current
  // period gets one: the insight is anchored to today, so it would be wrong
  // against a range the user has paged back to.
  const isCurrentPeriod = thailandRange(period, referenceDate).from.getTime() === thailandRange(period, new Date()).from.getTime();
  const monthTransactions = useMemo(() => list(period === 'month' ? data?.transactions : monthData?.transactions).map((item) => ({
    amount: Number(item.amount ?? 0),
    occurredAt: item.occurredAt as never,
    type: item.type === 'income' ? 'income' as const : 'expense' as const,
  })), [data, monthData, period]);
  const budgetLine = useMemo(() => {
    if (!isCurrentPeriod) return null;
    const monthlyAmount = monthlyBudget?.amount ?? 0;
    const insight = calculateFinanceBudgetInsight({monthlyBudget: monthlyAmount, transactions: monthTransactions});
    if (!insight) return {over: false, title: 'ยังไม่ได้ตั้งงบเดือนนี้', detail: 'ตั้งวงเงินแล้วหน้านี้จะบอกยอดที่ใช้ได้ของแต่ละช่วง'};
    if (period === 'day') {
      const allowance = calculateDailyAllowance({monthlyBudget: monthlyAmount, transactions: monthTransactions});
      if (!allowance) return null;
      return allowance.overBudget
        ? {over: true, title: `เกินงบเดือนนี้ ${money(Math.abs(allowance.remainingBudget))}`, detail: `ใช้ไปแล้ว ${money(insight.spentSoFar)} จากลิมิต ${money(insight.monthlyBudget)}`}
        : {over: false, title: `งบวันนี้ใช้ได้อีก ${money(allowance.amount)}`, detail: `เหลือทั้งเดือน ${money(allowance.remainingBudget)} ใน ${insight.daysRemainingIncludingToday} วันที่เหลือ`};
    }
    if (period === 'week') {
      return insight.weeklyRemainingBudget < 0
        ? {over: true, title: `เกินงบสัปดาห์นี้ ${money(Math.abs(insight.weeklyRemainingBudget))}`, detail: `ใช้ ${money(insight.weekSpent)} จากงบสัปดาห์ ${money(insight.weeklyBudget)}`}
        : {over: false, title: `งบสัปดาห์นี้เหลือ ${money(insight.weeklyRemainingBudget)}`, detail: `ใช้ไป ${insight.weeklyUsagePercent}% ของงบสัปดาห์ ${money(insight.weeklyBudget)}`};
    }
    return insight.remainingBudget < 0
      ? {over: true, title: `เกินงบเดือนนี้ ${money(Math.abs(insight.remainingBudget))}`, detail: `ใช้ ${money(insight.spentSoFar)} จากลิมิต ${money(insight.monthlyBudget)}`}
      : {over: false, title: `งบเดือนนี้เหลือ ${money(insight.remainingBudget)}`, detail: `ใช้ไป ${money(insight.spentSoFar)} จากลิมิต ${money(insight.monthlyBudget)}`};
  }, [isCurrentPeriod, monthTransactions, monthlyBudget, period]);
  const categoryTotals = useMemo(() => Array.from(all.filter((item) => item.type === 'expense').reduce((map, item) => { const category = normalizeExpenseCategory(str(item, 'category', '')); map.set(category, (map.get(category) ?? 0) + Number(item.amount ?? 0)); return map; }, new Map<string, number>()).entries()).slice(0, 3), [all]);
  // `Alert.alert` is an empty function on react-native-web, so this dialog --
  // and the delete behind its confirm button -- never appeared there at all.
  const confirmDeleteTransaction = () => {
    const id = str(deleting ?? {}, 'id', '');
    setDeleting(null);
    if (!id) return;
    setData((current) => current ? {...current, transactions: list(current.transactions).filter((entry) => str(entry, 'id', '') !== id)} : current);
    transactions.remove(uid, id).catch((error) => { console.error('[Finance] Delete failed', error); load().catch(() => undefined); setDeleteError(true); });
  };
  // The scan screen lets the category be corrected before saving; this is the
  // same correction after the fact, for a row whose category turned out wrong
  // once it was sitting in the charts. `transactions.update` and the Firestore
  // rules already permitted `category`, so only the control was missing.
  const saveCategory = (category: string) => {
    const item = recategorizing;
    setRecategorizing(null);
    const id = str(item ?? {}, 'id', '');
    if (!id || !item || str(item, 'category', '') === category) return;
    const apply = (current: Item | null) => current ? {...current, transactions: list(current.transactions).map((entry) => str(entry, 'id', '') === id ? {...entry, category} : entry)} : current;
    setData(apply);
    setMonthData(apply);
    transactions.update(uid, id, {category}).catch((error) => { console.error('[Finance] Category update failed', error); load().catch(() => undefined); setCategoryError(true); });
  };
  const headerAction = filter === 'income'
    ? {icon: 'add', label: 'เพิ่มรายรับ', page: 'smartlife_add_income'}
    : filter === 'expense'
      ? {icon: 'add', label: 'เพิ่มรายจ่าย', page: 'smartlife_add_expense'}
      : {icon: 'receipt_long', label: 'สแกนใบเสร็จ', page: SMART_SCAN_PAGE};

  return <ResponsiveSafeArea style={styles.safe}><View style={styles.screen}><UserGradientBackdrop />
    <ScrollView ref={scrollViewRef} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.sage} />} showsVerticalScrollIndicator={false}>
      {/* Refactored UI: finance overview follows the period-and-filter dashboard shown in the new design. */}
<Reveal index={0}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>{filter === 'income' ? `รายรับ${periodText(periodPage)}` : filter === 'expense' ? `รายจ่าย${periodText(periodPage)}` : `สรุป${periodText(periodPage)}`}</Text><Text style={styles.title}>การเงิน</Text></View><Touchable accessibilityLabel={headerAction.label} onPress={() => onNavigate(headerAction.page)} style={styles.receiptButton}><MaterialIcon color="#fff" name={headerAction.icon} size={22} /></Touchable></View>
</Reveal>
<Reveal index={1}>
      <View onLayout={periodTabsOnLayout} ref={periodTabsRef} style={styles.periodBar}>{periods.map((item) => <Touchable key={item.page} onPress={() => { selectRange(periodForPage(item.page), referenceDate); }} style={[styles.periodItem, periodPage === item.page && styles.periodActive]}><Text style={[styles.periodText, periodPage === item.page && styles.periodTextActive]}>{item.label}</Text></Touchable>)}</View>
</Reveal>
<Reveal index={2}>
      <View onLayout={rangeBarOnLayout} ref={rangeBarRef} style={styles.rangeBar}>
        <Touchable accessibilityLabel="Previous period" onPress={() => selectRange(period, shiftPeriod(referenceDate, period, -1))} style={styles.rangeButton}>
          <MaterialIcon color={C.ink} name="chevron_left" size={22} />
        </Touchable>
        <Touchable accessibilityLabel="Return to current period" onPress={() => selectRange(period, new Date())} style={styles.rangeLabel}>
          <Text style={styles.rangeHint}>D / W / M</Text>
          <Text style={styles.rangeToday}>{selectedRangeLabel(periodPage, referenceDate)}</Text>
        </Touchable>
        <Touchable accessibilityLabel="Next period" onPress={() => selectRange(period, shiftPeriod(referenceDate, period, 1))} style={styles.rangeButton}>
          <MaterialIcon color={C.ink} name="chevron_right" size={22} />
        </Touchable>
      </View>
</Reveal>
<Reveal index={3}>
      <View style={styles.filterBar}>{(['all', 'income', 'expense'] as Filter[]).map((item) => <Touchable key={item} onPress={() => selectRange(period, referenceDate, item)} style={[styles.filterItem, filter === item && styles.filterActive]}><Text style={[styles.filterText, filter === item && styles.filterTextActive]}>{item === 'all' ? 'ภาพรวม' : item === 'income' ? 'รายรับ' : 'รายจ่าย'}</Text></Touchable>)}</View>
</Reveal>
      {loadError ? <View style={styles.loading}><Text style={styles.loadingText}>โหลดข้อมูลไม่สำเร็จ จึงยังสรุปยอดไม่ได้ ไม่ใช่ยอดเป็นศูนย์</Text><Touchable accessibilityRole="button" onPress={() => void load()} style={styles.sheetCancel}><Text style={styles.sheetCancelText}>ลองอีกครั้ง</Text></Touchable></View> : !data ? <View style={styles.loading}><ActivityIndicator color={C.sage} size="large" /><Text style={styles.loadingText}>กำลังโหลดข้อมูลจาก Firebase</Text></View> : <>
<Reveal index={4}>
        <View style={styles.balanceCard}><View style={styles.balanceCircle} /><View style={styles.balanceTop}><View><View style={styles.balanceLabelRow}><MaterialIcon color={C.accent} name="credit_card" size={14} /><Text style={styles.balanceLabel}>{mainLabel}</Text></View><AnimatedNumber format={money} style={styles.balanceAmount} value={mainAmount} /><Text style={styles.balancePeriod}>/ {periodText(periodPage)}</Text></View></View><View style={styles.progress}><View style={[styles.progressFill, {width: `${Math.min(expense / Math.max(income, expense, 1) * 100, 100)}%`}]} /></View><View style={styles.categoryTags}>{categoryTotals.length ? categoryTotals.map(([category, amount]) => <View key={category} style={styles.categoryTag}><Text style={styles.categoryTagText}>{category} {money(amount)}</Text></View>) : <View style={styles.categoryTag}><Text style={styles.categoryTagText}>ยังไม่มีค่าใช้จ่าย</Text></View>}</View></View>
</Reveal>
<Reveal index={5}>
        {budgetLine ? <Touchable onPress={() => onNavigate('smartlife_monthly_budget')} style={[styles.budgetStrip, budgetLine.over && styles.budgetStripOver]}>
          <View style={[styles.budgetStripIcon, budgetLine.over && styles.budgetStripIconOver]}><MaterialIcon color={budgetLine.over ? C.red : C.sage} name={budgetLine.over ? 'error' : 'savings'} size={17} /></View>
          <View style={{flex: 1}}><Text style={[styles.budgetStripTitle, budgetLine.over && styles.budgetStripTitleOver]}>{budgetLine.title}</Text><Text style={styles.budgetStripDetail}>{budgetLine.detail}</Text></View>
          <MaterialIcon color={C.muted} name="chevron_right" size={20} />
        </Touchable> : null}
</Reveal>
<Reveal index={6}>
        <View style={styles.summaryRow}>{filter === 'income' ? <><Summary amount={income} icon="north" label="รับแล้ว" tone="income" /><Summary amount={Math.max(0, income - shown.reduce((sum, item) => sum + Number(item.amount ?? 0), 0))} icon="schedule" label="รอรับ" tone="neutral" /></> : filter === 'expense' ? <><Summary amount={expense} icon="south" label="ใช้ไปแล้ว" tone="expense" /><Summary amount={Math.max(0, balance)} icon="schedule" label="เหลือ" tone="neutral" /></> : <><Summary amount={income} icon="north" label="รายรับ" tone="income" /><Summary amount={expense} icon="south" label="รายจ่าย" tone="expense" /></>}</View>
</Reveal>

<Reveal index={7}>
        {/* Directly under the totals they relate to. These sat below the
            charts, the budget card and the LINE card, which put them off the
            first screen on a phone: the action people came to do was the one
            thing they had to go looking for. */}
        {filter !== 'expense' ? <Touchable onPress={() => onNavigate('smartlife_add_income')} style={[styles.menuCard, {backgroundColor: '#eef3ea'}]}>
          <View style={[styles.menuIcon, {backgroundColor: C.sage}]}><MaterialIcon color="#fff" name="add_card" size={20} /></View>
          <View style={{flex: 1}}>
            <Text style={styles.menuTitle}>เพิ่มรายรับ</Text>
            <Text style={styles.menuSubtitle}>กรอกจำนวน หมวดหมู่ วันที่ และโน้ตด้วยตัวเอง</Text>
          </View>
          <MaterialIcon color={C.ink} name="chevron_right" size={21} />
        </Touchable> : null}
        {filter !== 'income' ? <Touchable onPress={() => onNavigate('smartlife_add_expense')} style={[styles.menuCard, {backgroundColor: '#fcedea'}]}>
          <View style={[styles.menuIcon, {backgroundColor: '#c96e68'}]}><MaterialIcon color="#fff" name="add_card" size={20} /></View>
          <View style={{flex: 1}}>
            <Text style={styles.menuTitle}>เพิ่มรายจ่ายเอง</Text>
            <Text style={styles.menuSubtitle}>เลือกหมวดหลัก หรือตั้งชื่อหมวดรายจ่ายของคุณเอง</Text>
          </View>
          <MaterialIcon color={C.ink} name="chevron_right" size={21} />
        </Touchable> : null}
</Reveal>

<Reveal index={8}>
        {period !== 'day' ? <SpendingCharts period={period} referenceDate={referenceDate} transactions={all} /> : null}
</Reveal>

<Reveal index={9}>
        <Touchable onPress={() => onNavigate('smartlife_monthly_budget')} style={[styles.menuCard, {backgroundColor: '#faecea', marginTop: 16}]}>
            <View style={[styles.menuIcon, {backgroundColor: '#d89182'}]}><MaterialIcon color="#fff" name="savings" size={20} /></View>
            <View style={{flex: 1}}>
              <Text style={styles.menuTitle}>{budgetCardTitle(period)}</Text>
              <Text style={styles.menuSubtitle}>{budgetCardSubtitle(period, monthlyBudget)}</Text>
            </View>
            <MaterialIcon color={C.ink} name="chevron_right" size={21} />
        </Touchable>
</Reveal>

<Reveal index={10}>
        <Touchable onPress={() => onNavigate('smartlife_line_bank')} style={[styles.menuCard, {backgroundColor: '#eef3ea'}]}>
            <View style={[styles.menuIcon, {backgroundColor: '#72956f'}]}><MaterialIcon color="#fff" name="notifications_active" size={20} /></View>
            <View style={{flex: 1}}>
              <Text style={styles.menuTitle}>อ่านแจ้งเตือนการเงิน</Text>
              <Text style={styles.menuSubtitle}>LINE และแอปธนาคารที่รองรับ • ตรวจเฉพาะรายการที่ไม่ชัดเจน</Text>
            </View>
            <MaterialIcon color={C.ink} name="chevron_right" size={21} />
        </Touchable>
</Reveal>

        {filter !== 'income' ? <Touchable onPress={() => onNavigate(SMART_SCAN_PAGE)} style={[styles.menuCard, {backgroundColor: '#eceef7'}]}>
          <View style={[styles.menuIcon, {backgroundColor: '#7a85b3'}]}><MaterialIcon color="#fff" name="receipt_long" size={20} /></View>
          <View style={{flex: 1}}>
            <Text style={styles.menuTitle}>สแกนใบเสร็จ</Text>
            <Text style={styles.menuSubtitle}>ให้ AI แยกหมวดรายจ่ายให้อัตโนมัติ</Text>
          </View>
          <MaterialIcon color={C.ink} name="chevron_right" size={21} />
        </Touchable> : null}

        <View style={styles.sectionHead}><Text style={styles.sectionTitle}>{filter === 'income' ? 'รายการรายรับ' : filter === 'expense' ? 'รายการรายจ่าย' : 'รายการล่าสุด'}</Text>{filter === 'income' ? <Touchable onPress={() => onNavigate('smartlife_add_income')}><Text style={styles.allLink}>เพิ่มรายรับ</Text></Touchable> : filter === 'expense' ? <Touchable onPress={() => onNavigate('smartlife_add_expense')}><Text style={styles.allLink}>เพิ่มรายจ่าย</Text></Touchable> : null}</View>
        <View style={styles.transactionList}>{shown.length ? shown.map((item, index) => <TransactionRow item={item} key={str(item, 'id', String(index))} onDelete={() => setDeleting(item)} onRecategorize={() => setRecategorizing(item)} />) : <View style={styles.empty}><MaterialIcon color="#a1aaa0" name="receipt_long" size={32} /><Text style={styles.emptyText}>ยังไม่มีรายการในช่วงนี้</Text></View>}</View>
      </>}
    </ScrollView><UserTabBar active="smartlife_finance_day" onNavigate={onNavigate} />
    <ConfirmDialog
      confirmLabel="ลบถาวร"
      message="ข้อมูลจะถูกลบออกจาก Firebase อย่างถาวร"
      onCancel={() => setDeleting(null)}
      onConfirm={confirmDeleteTransaction}
      title="ลบรายการการเงินนี้หรือไม่?"
      visible={Boolean(deleting)}
    />
    <ConfirmDialog
      cancelLabel="ปิด"
      confirmLabel="ลองใหม่"
      icon="refresh"
      message="ลองใหม่อีกครั้ง"
      onCancel={() => setDeleteError(false)}
      onConfirm={() => { setDeleteError(false); load().catch(() => undefined); }}
      title="ลบไม่สำเร็จ"
      tone="neutral"
      visible={deleteError}
    />
    <ConfirmDialog
      cancelLabel="ปิด"
      confirmLabel="ลองใหม่"
      icon="refresh"
      message="หมวดหมู่ยังเป็นค่าเดิม ลองใหม่อีกครั้ง"
      onCancel={() => setCategoryError(false)}
      onConfirm={() => { setCategoryError(false); load().catch(() => undefined); }}
      title="เปลี่ยนหมวดหมู่ไม่สำเร็จ"
      tone="neutral"
      visible={categoryError}
    />
    <CategorySheet
      current={normalizeExpenseCategory(str(recategorizing ?? {}, 'category', ''))}
      onClose={() => setRecategorizing(null)}
      onSelect={saveCategory}
      visible={Boolean(recategorizing)}
    />
  </View></ResponsiveSafeArea>;
}

function Summary({amount, icon, label, tone}: {amount: number; icon: string; label: string; tone: 'income' | 'expense' | 'neutral'}) { const color = tone === 'income' ? C.sage : tone === 'expense' ? C.red : C.ink; return <View style={styles.summary}><View style={styles.summaryHead}><MaterialIcon color={tone === 'expense' ? C.accent : C.sage} name={icon} size={15} /><Text style={styles.summaryLabel}>{label}</Text></View><AnimatedNumber format={money} style={[styles.summaryAmount, {color}]} value={amount} /></View>; }
function TransactionRow({item, onDelete, onRecategorize}: {item: Item; onDelete: () => void; onRecategorize: () => void}) { const isIncome = item.type === 'income'; const category = normalizeExpenseCategory(str(item, 'category', '')); return <View style={styles.transaction}><Touchable accessibilityLabel={isIncome ? undefined : `เปลี่ยนหมวดหมู่ ปัจจุบัน ${category}`} accessibilityRole={isIncome ? undefined : 'button'} disabled={isIncome} onPress={onRecategorize} style={styles.transactionMain}><View style={[styles.transactionIcon, {backgroundColor: isIncome ? C.sageSoft : C.redSoft}]}><MaterialIcon color={isIncome ? C.sage : C.red} name={isIncome ? 'north' : categoryIcon(category)} size={18} /></View><View style={{flex: 1}}><Text numberOfLines={1} style={styles.transactionTitle}>{str(item, 'merchant', category)}</Text><View style={styles.transactionSubRow}><Text style={styles.transactionSub}>{category} · {date(item.occurredAt)}</Text>{isIncome ? null : <MaterialIcon color="#b3bcb2" name="edit" size={10} />}</View></View></Touchable><Text style={[styles.transactionAmount, {color: isIncome ? C.sage : C.red}]}>{isIncome ? '+' : '-'}{money(Number(item.amount ?? 0))}</Text><Touchable accessibilityLabel="ลบรายการ" onPress={onDelete} style={styles.delete}><MaterialIcon color="#ca7771" name="close" size={15} /></Touchable></View>; }

/** The saved-transaction twin of the scan screen's picker, on the same list. */
function CategorySheet({current, onClose, onSelect, visible}: {current: string; onClose: () => void; onSelect: (category: string) => void; visible: boolean}) {
  return <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
    <Touchable accessibilityLabel="ปิดตัวเลือกหมวดหมู่" onPress={onClose} style={styles.sheetOverlay}>
      <View onStartShouldSetResponder={() => true} style={styles.sheet}>
        <Text style={styles.sheetTitle}>หมวดหมู่การใช้จ่าย</Text>
        <Text style={styles.sheetHint}>เลือกหมวดหมู่ใหม่ กราฟและสรุปจะอัปเดตตาม</Text>
        <ScrollView contentContainerStyle={styles.sheetOptions} style={styles.sheetScroll}>
          {EXPENSE_CATEGORIES.map((entry) => { const active = entry.label === current; return <Touchable accessibilityLabel={`ตั้งหมวดหมู่ ${entry.label}`} accessibilityRole="button" accessibilityState={{selected: active}} key={entry.label} onPress={() => onSelect(entry.label)} style={[styles.sheetOption, active && styles.sheetOptionActive]}><MaterialIcon color={active ? '#fff' : '#6d786c'} name={entry.icon} size={14} /><Text style={[styles.sheetOptionText, active && styles.sheetOptionTextActive]}>{entry.label}</Text></Touchable>; })}
        </ScrollView>
        <Touchable accessibilityLabel="ยกเลิก" onPress={onClose} style={styles.sheetCancel}><Text style={styles.sheetCancelText}>ยกเลิก</Text></Touchable>
      </View>
    </Touchable>
  </Modal>;
}

const shadow = {shadowColor: C.ink, shadowOffset: {height: 8, width: 0}, shadowOpacity: .07, shadowRadius: 18};
const styles = StyleSheet.create({
  budgetStrip: {alignItems: 'center', backgroundColor: '#fff', borderColor: C.sageSoft, borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 10, marginTop: 12, padding: 12},
  budgetStripDetail: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2},
  budgetStripIcon: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, height: 36, justifyContent: 'center', width: 36},
  budgetStripIconOver: {backgroundColor: C.redSoft},
  budgetStripOver: {borderColor: C.redSoft},
  budgetStripTitle: {color: C.ink, fontFamily: F.b, fontSize: 12},
  budgetStripTitleOver: {color: C.red},
  allLink: {color: C.accent, fontFamily: F.b, fontSize: 12}, balanceAmount: {color: C.ink, fontFamily: F.x, fontSize: 30, marginTop: 2}, balanceCard: {...shadow, backgroundColor: '#fff', borderRadius: 21, marginTop: 10, overflow: 'hidden', padding: 15}, balanceCircle: {backgroundColor: C.accentSoft, borderBottomLeftRadius: 58, height: 72, position: 'absolute', right: 0, top: 0, width: 72}, balanceLabel: {color: C.ink, fontFamily: F.b, fontSize: 12}, balanceLabelRow: {alignItems: 'center', flexDirection: 'row', gap: 6}, balancePeriod: {color: C.muted, fontFamily: F.s, fontSize: 12, marginLeft: 92, marginTop: -14}, budgetPlanner: {alignItems: 'center', backgroundColor: '#fff0e8', borderColor: '#f0cfc1', borderRadius: 18, borderWidth: 1, flexDirection: 'row', gap: 10, marginTop: 13, padding: 12}, budgetPlannerIcon: {alignItems: 'center', backgroundColor: '#c87964', borderRadius: 20, boxShadow: '0 5px 11px rgba(176,99,79,.20)', height: 40, justifyContent: 'center', width: 40}, budgetPlannerText: {color: '#8e6256', fontFamily: F.r, fontSize: 12, marginTop: 2}, budgetPlannerTitle: {color: '#56372e', fontFamily: F.b, fontSize: 12}, balanceTop: {flexDirection: 'row', justifyContent: 'space-between'}, categoryTag: {backgroundColor: '#f1f3ef', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5}, categoryTagText: {color: '#697669', fontFamily: F.b, fontSize: 12}, categoryTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10}, content: {padding: 20, paddingBottom: 26}, delete: {alignItems: 'center', height: 28, justifyContent: 'center', marginLeft: 2, width: 22}, empty: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, gap: 6, paddingVertical: 28}, emptyText: {color: C.muted, fontFamily: F.r, fontSize: 12}, eyebrow: {color: C.sage, fontFamily: F.b, fontSize: 12}, filterActive: {backgroundColor: C.accent}, filterBar: {backgroundColor: '#fff', borderRadius: 16, flexDirection: 'row', marginTop: 9, padding: 5}, filterItem: {alignItems: 'center', borderRadius: 12, flex: 1, paddingVertical: 8}, filterText: {color: C.muted, fontFamily: F.b, fontSize: 12}, filterTextActive: {color: '#fff'}, header: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, insight: {alignItems: 'center', backgroundColor: '#eef1fa', borderRadius: 18, flexDirection: 'row', gap: 10, marginTop: 14, padding: 12}, insightIcon: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 20, height: 40, justifyContent: 'center', width: 40}, insightText: {color: '#7c8790', fontFamily: F.r, fontSize: 12, marginTop: 2}, insightTitle: {color: C.ink, fontFamily: F.b, fontSize: 12}, loading: {alignItems: 'center', gap: 9, paddingVertical: 80}, loadingText: {color: C.muted, fontFamily: F.r, fontSize: 12}, periodActive: {backgroundColor: C.ink}, periodBar: {backgroundColor: '#fff', borderRadius: 16, flexDirection: 'row', marginTop: 12, padding: 5}, periodItem: {alignItems: 'center', borderRadius: 12, flex: 1, paddingVertical: 9}, periodText: {color: C.muted, fontFamily: F.b, fontSize: 12}, periodTextActive: {color: '#fff'}, progress: {backgroundColor: '#e4e5ec', borderRadius: 99, height: 7, marginTop: 16, overflow: 'hidden'}, progressFill: {backgroundColor: C.accent, borderRadius: 99, height: 7}, rangeBar: {alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 8}, rangeButton: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, height: 36, justifyContent: 'center', width: 36}, rangeHint: {color: C.accent, fontFamily: F.b, fontSize: 12}, rangeLabel: {alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 36}, rangeToday: {color: C.ink, fontFamily: F.b, fontSize: 12, marginTop: 1}, receiptButton: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 28, boxShadow: '0 7px 17px rgba(69,77,125,.25)', height: 54, justifyContent: 'center', width: 54}, safe: {backgroundColor: C.mist, flex: 1}, screen: {backgroundColor: C.mist, flex: 1}, sectionHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, marginTop: 17}, sectionTitle: {color: C.ink, fontFamily: F.x, fontSize: 14}, summary: {...shadow, backgroundColor: '#fff', borderRadius: 18, flex: 1, minHeight: 84, padding: 13}, summaryAmount: {fontFamily: F.x, fontSize: 19, marginTop: 6}, summaryHead: {alignItems: 'center', flexDirection: 'row', gap: 5}, summaryLabel: {color: C.muted, fontFamily: F.s, fontSize: 12}, summaryRow: {flexDirection: 'row', gap: 10, marginTop: 12}, title: {color: C.ink, fontFamily: F.x, fontSize: 24}, transaction: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, flexDirection: 'row', gap: 10, minHeight: 61, paddingHorizontal: 12, paddingVertical: 10}, transactionAmount: {fontFamily: F.x, fontSize: 12}, transactionIcon: {alignItems: 'center', borderRadius: 13, height: 38, justifyContent: 'center', width: 38}, transactionList: {gap: 9}, transactionMain: {alignItems: 'center', flex: 1, flexDirection: 'row', gap: 10}, transactionSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2}, transactionSubRow: {alignItems: 'center', flexDirection: 'row', gap: 4}, transactionTitle: {color: C.ink, fontFamily: F.b, fontSize: 12}, sheet: {backgroundColor: '#fbfcf7', borderRadius: 24, maxHeight: '80%', maxWidth: 460, padding: 18, width: '92%'}, sheetCancel: {alignItems: 'center', borderRadius: 14, marginTop: 12, paddingVertical: 11}, sheetCancelText: {color: C.muted, fontFamily: F.b, fontSize: 12}, sheetHint: {color: '#8b948a', fontFamily: F.r, fontSize: 12, marginBottom: 12, marginTop: 3}, sheetOption: {alignItems: 'center', backgroundColor: '#f1f3ef', borderRadius: 99, flexDirection: 'row', gap: 6, paddingHorizontal: 11, paddingVertical: 8}, sheetOptionActive: {backgroundColor: '#5f875f'}, sheetOptionText: {color: '#6d786c', fontFamily: F.b, fontSize: 12}, sheetOptionTextActive: {color: '#fff'}, sheetOptions: {flexDirection: 'row', flexWrap: 'wrap', gap: 7}, sheetOverlay: {alignItems: 'center', backgroundColor: 'rgba(32, 40, 31, .58)', flex: 1, justifyContent: 'center', padding: 16}, sheetScroll: {maxHeight: 360}, sheetTitle: {color: C.ink, fontFamily: F.x, fontSize: 15},
  menuCard: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 12, marginTop: 10, padding: 14, borderColor: 'rgba(0,0,0,0.04)', borderWidth: 1 },
  menuIcon: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44, shadowColor: C.ink, shadowOffset: {width: 0, height: 5}, shadowOpacity: 0.1, shadowRadius: 11 },
  menuTitle: { color: C.ink, fontFamily: F.b, fontSize: 13 },
  menuSubtitle: { color: '#7c8790', fontFamily: F.r, fontSize: 12, marginTop: 2 },
});
