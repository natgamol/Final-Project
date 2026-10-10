/* eslint-disable react-hooks/set-state-in-effect */
import {forwardRef, useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import {AnimatedNumber, Reveal} from '@/components/motion';
import {AuroraGradient, Sheen} from '@/components/color-motion';
import AiActivityRecommendationCard from '@/components/ai-activity-recommendation-card';
import SleepLogCard from '@/components/sleep-log-card';
import {SpendingDonut} from '@/components/spending-charts';
import {LinearGradient} from 'expo-linear-gradient';
import {Timestamp} from 'firebase/firestore';

import {loadLegacyPageData, runLegacyDataAction} from '@/services/legacy-data';
import {calculateDailyAllowance, type DailyAllowance} from '@/services/dynamic-insights';
import {loadMonthlyBudget} from '@/services/monthly-budget';
import {fundsOverage, monthFundsFrom} from '@/services/transaction-funds';
import {buildNotificationFeed, isRankable, itemsOf as items, millis, priorityReasons, priorityScore, string, unreadCount, type FeedItem} from '@/services/notification-feed';
import {activities as activitiesStore, notes as notesStore} from '@/services/firestore';
import {recordTaskCompleted} from '@/services/behavior-tracking';
import {aggregateSpending, type SpendingTransactionInput} from '@/services/spending-analytics';
import {updateAndroidHomeWidget} from '@/services/android-home-widget';
import {MaterialIcon, UserGradientBackdrop, UserTabBar} from './user-ui';
import {useCurrentClock} from '@/hooks/use-current-clock';
import {useTourScreen, useTourTarget} from '@/hooks/use-tour-target';
import {bangkokGreeting} from '@/lib/ux-time';
import {showToast} from '@/components/app-toast';

/**
 * Page data arrives already serialised to ISO strings, so the slot times the
 * adaptive engine learns from have to be parsed back rather than read as
 * Firestore timestamps.
 */
function dateOf(value: unknown) {
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type Props = {onNavigate: (page: string) => void; uid: string};
type Item = Record<string, unknown>;

const colors = {pine: '#2c341b', sage: '#6f8f6d', sageDark: '#5f835f', sageSoft: '#dfe7dc', mist: '#f4f5ef', paper: '#ffffff', muted: '#8b9085', finance: '#9297bb', financeSoft: '#eceef7', note: '#bb9293', noteSoft: '#f3e8e8', night: '#5a3d82'};
const showDevTools = __DEV__ || process.env.EXPO_PUBLIC_SMARTLIFE_SHOW_DEV_TOOLS === 'true';

function time(value: unknown) { const date = new Date(String(value ?? '')); return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('th-TH', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok'}).format(date); }
function money(value: number) { return `฿${value.toLocaleString('th-TH')}`; }
function dayKey(date: Date) { return new Intl.DateTimeFormat('en-CA', {day: '2-digit', month: '2-digit', timeZone: 'Asia/Bangkok', year: 'numeric'}).format(date); }
function shortDateLabel(date: Date) { return new Intl.DateTimeFormat('th-TH', {timeZone: 'Asia/Bangkok', weekday: 'short'}).format(date); }
function dayNumber(date: Date) { return new Intl.DateTimeFormat('th-TH', {day: 'numeric', timeZone: 'Asia/Bangkok'}).format(date); }

const SoftPress = forwardRef<View, {children: React.ReactNode; onLayout?: () => void; onPress: () => void; style?: object}>(
  function SoftPress({children, onLayout, onPress, style}, ref) {
    return <Touchable onLayout={onLayout} onPress={onPress} ref={ref} style={({pressed}) => [style, pressed && styles.pressed]}>{children}</Touchable>;
  },
);

function StatCard({value, label}: {value: string | number; label: string}) {
  return <View style={styles.statCard}>{typeof value === 'number' ? <AnimatedNumber adjustsFontSizeToFit minimumFontScale={.7} numberOfLines={1} style={styles.statValue} value={value} /> : <Text adjustsFontSizeToFit minimumFontScale={.7} numberOfLines={1} style={styles.statValue}>{value}</Text>}<Text style={styles.statLabel}>{label}</Text></View>;
}

const QUICK_ACTIONS = [
  {bg: '#f3e8e8', fg: '#bb7777', icon: 'check_box', label: 'เพิ่มงาน', page: 'smartlife_add_task'},
  {bg: '#e3f0ef', fg: '#3f8a82', icon: 'location_on', label: 'นัดหมาย', page: 'smartlife_add_appointment'},
  {bg: '#e5efe2', fg: '#52734b', icon: 'document_scanner', label: 'สแกน', page: 'smartlife_scan_schedule'},
  {bg: '#eceef7', fg: '#6572ad', icon: 'edit_note', label: 'โน้ต', page: 'smartlife_add_note'},
];

/**
 * A first-time (and repeat) visitor with nothing pending had no obvious place
 * to start -- every card on this screen was informational, not an action.
 * This row is the answer to "where do I even tap": four unmissable buttons
 * for the things people open the app to do most often.
 */
function QuickActions({onNavigate}: {onNavigate: (page: string) => void}) {
  return <View style={styles.quickActionsPanel}>
    {QUICK_ACTIONS.map((action) => <Touchable key={action.page} onPress={() => onNavigate(action.page)} style={({pressed}) => [styles.quickAction, pressed && styles.pressed]}>
      <View style={[styles.quickActionIcon, {backgroundColor: action.bg}]}><MaterialIcon color={action.fg} name={action.icon} size={22} /></View>
      <Text style={styles.quickActionLabel}>{action.label}</Text>
    </Touchable>)}
  </View>;
}

export default function DashboardScreen({onNavigate, uid}: Props) {
  const clockNow = useCurrentClock();
  const {ref: bellRef, onLayout: bellOnLayout} = useTourTarget('dashboard', 'bell');
  const {ref: aiCardRef, onLayout: aiCardOnLayout} = useTourTarget('dashboard', 'ai-card');
  const {ref: weeklySpendingRef, onLayout: weeklySpendingOnLayout} = useTourTarget('dashboard', 'weekly-spending');
  useTourScreen('dashboard');
  const [data, setData] = useState<Item | null>(null);
  const [sleepSheetOpen, setSleepSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [completingId, setCompletingId] = useState('');
  const [allowance, setAllowance] = useState<DailyAllowance | null>(null);
  const [budgetAmount, setBudgetAmount] = useState(0);
  // Held beside the monthly amount so the feed and the allowance tile read the
  // limits the user set rather than an even split of the month.
  const [budgetLimits, setBudgetLimits] = useState<{daily?: number; weekly?: number}>({});
  const [monthTransactions, setMonthTransactions] = useState<{amount: number; occurredAt: never; type: 'expense' | 'income'}[]>([]);
  const [weekTransactions, setWeekTransactions] = useState<SpendingTransactionInput[]>([]);
  // `user/index` is a one-day window, so its transactions cannot answer what is
  // left of the monthly limit. The month's spending and the saved limit are
  // fetched alongside it, and neither failing may stop the dashboard loading.
  const load = useCallback(async () => {
    const [pageData, monthData, weekData, savedBudget] = await Promise.all([
      loadLegacyPageData(uid, 'user/index') as Promise<Item>,
      (loadLegacyPageData(uid, 'user/smartlife_finance_month') as Promise<{transactions?: unknown}>)
        .catch((error) => { console.error('[Dashboard] Month transactions load failed', error); return null; }),
      (loadLegacyPageData(uid, 'user/smartlife_finance_week') as Promise<{transactions?: unknown}>)
        .catch((error) => { console.error('[Dashboard] Week transactions load failed', error); return null; }),
      loadMonthlyBudget(uid).catch((error) => { console.error('[Dashboard] Saved budget load failed', error); return null; }),
    ]);
    const monthly = savedBudget?.amount ?? 0;
    const spending = items(monthData?.transactions).map((item) => ({
      amount: Number(item.amount ?? 0),
      occurredAt: item.occurredAt as never,
      type: item.type === 'income' ? 'income' as const : 'expense' as const,
    }));
    setWeekTransactions(items(weekData?.transactions).map((item) => ({
      amount: item.amount,
      category: string(item, 'category', 'อื่น ๆ'),
      occurredAt: item.occurredAt,
      type: item.type,
    })));
    setBudgetAmount(monthly);
    setMonthTransactions(spending);
    setBudgetLimits({daily: savedBudget?.dailyAmount, weekly: savedBudget?.weeklyAmount});
    setAllowance(calculateDailyAllowance({dailyBudget: savedBudget?.dailyAmount, monthlyBudget: monthly, transactions: spending, weeklyBudget: savedBudget?.weeklyAmount}));
    setData(pageData);
  }, [uid]);
  useEffect(() => { load().catch(() => setData({})); }, [load]);
  const refresh = useCallback(async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }, [load]);
  const seedAiDynamicData = useCallback(async () => {
    setSeeding(true);
    try {
      const result = await runLegacyDataAction(uid, 'user/index', {action: 'seed-ai-dynamic-test-data'});
      await load();
      const summary = result && typeof result === 'object' ? Object.entries(result).map(([key, value]) => `${key}: ${value}`).join('\n') : '';
      showToast('เพิ่มข้อมูลสำเร็จ', summary || 'เพิ่มข้อมูลทดสอบเรียบร้อยแล้ว', 'success');
    } catch (error) {
      showToast('เพิ่มข้อมูลไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setSeeding(false);
    }
  }, [load, uid]);

  const profile = (data?.profile ?? {}) as Item;
  const schedules = useMemo(() => items(data?.schedules).sort((a, b) => new Date(String(a.startAt)).getTime() - new Date(String(b.startAt)).getTime()), [data]);
  const activities = useMemo(() => items(data?.activities), [data]);
  const notes = useMemo(() => items(data?.notes), [data]);
  const transactions = useMemo(() => items(data?.transactions), [data]);
  const weeklySpending = useMemo(() => aggregateSpending(weekTransactions, 'week'), [weekTransactions]);
  const notifications = useMemo(() => items(data?.notifications), [data]);
  // The badge counts what is true right now: derived alerts while their
  // condition holds, plus stored notifications that are genuinely unread. It
  // reads from the same feed the notification list renders, so the number on
  // the bell and the rows behind it can never disagree.
  const feed = useMemo<FeedItem[]>(() => buildNotificationFeed({
    activities: data?.activities,
    dailyBudget: budgetLimits.daily,
    monthlyBudget: budgetAmount,
    weeklyBudget: budgetLimits.weekly,
    monthTransactions,
    notes: data?.notes,
    stored: notifications as never,
    todayExpenses: items(data?.transactions).filter((item) => item.type === 'expense').map((item) => ({amount: Number(item.amount ?? 0)})),
  }), [budgetAmount, budgetLimits.daily, budgetLimits.weekly, data, monthTransactions, notifications]);
  const workNotes = useMemo(() => notes.filter((item) => item.status !== 'completed' && /งาน|task|assignment|homework/i.test(string(item, 'category', ''))), [notes]);
  // `pending` drives the priority card, the focus tile and the "งานที่ต้องทำ"
  // count, so a sleep log has to be filtered out here too -- otherwise a logged
  // night is ranked as an overdue to-do with a "เสร็จ" button on it.
  const pending = useMemo(() => [
    ...activities.filter((item) => item.status !== 'completed' && isRankable(item)).map((item): Item => ({...item, __entity: 'activity'})),
    ...workNotes.map((item): Item => ({...item, __entity: 'note'})),
  ], [activities, workNotes]);
  // Both budget surfaces read from the same allowance, so the tile and the
  // assistant's instant answer can never quote different numbers.
  const allowanceValue = allowance ? money(allowance.amount) : '—';
  // The limit is one ceiling and the money actually taken in is another;
  // spending can pass both, and only the first was ever reported. The second
  // uses the same funds rule as the bell's alert and the pre-save prompt.
  const fundsOver = fundsOverage(monthFundsFrom(monthTransactions));
  const allowanceAnswer = !allowance ? 'ตั้งงบเดือนนี้ก่อน'
    : allowance.overBudget ? `เกินงบที่ตั้งไว้ ${money(Math.abs(allowance.remainingBudget))}${fundsOver ? ` และเกินเงินที่มีทั้งหมด ${money(fundsOver)}` : ''}`
    : `ตอบทันที: วันนี้ใช้ได้อีก ${money(allowance.amount)}`;
  // The card headlines the same allowance as the tile above it -- it used to
  // show a day's income minus expenses, which sat at ฿0 next to a tile saying
  // ฿392. The bar behind it is the share of the month's limit still unspent,
  // rather than the old balance-over-income ratio that measured nothing.
  const monthBudgetLeftPercent = allowance && allowance.monthlyBudget > 0
    ? Math.min(100, Math.max(0, allowance.remainingBudget / allowance.monthlyBudget * 100))
    : 0;
  const unread = unreadCount(feed);
  const urgent = useMemo(() => [...pending].sort((a, b) => priorityScore(b) - priorityScore(a) || millis(a) - millis(b)).slice(0, 2), [pending]);
  useEffect(() => {
    if (!data) return;
    const now = new Date();
    const today = dayKey(now);
    const nextSchedule = schedules.find((item) => dayKey(new Date(String(item.startAt ?? ''))) === today && new Date(String(item.startAt ?? '')).getTime() >= now.getTime()) ?? schedules[0];
    const topTask = urgent[0] ?? pending[0];
    const headline = nextSchedule ? string(nextSchedule, 'title', 'SmartLife วันนี้') : 'SmartLife วันนี้';
    const subheadline = nextSchedule ? `${time(nextSchedule.startAt)} · ${string(nextSchedule, 'location', string(nextSchedule, 'courseCode', 'ตารางวันนี้'))}` : 'ไม่มีตารางเรียนที่กำลังจะถึง';
    const focusTitle = topTask ? `โฟกัส: ${string(topTask, 'title')}` : 'วันนี้ยังไม่มีงานที่ต้องโฟกัส';
    const budgetLabel = allowance ? `งบวันนี้ ${allowanceValue}` : 'งบวันนี้ยังไม่ได้ตั้ง';
    const updatedAtLabel = `อัปเดต ${time(now.toISOString())}`;
    updateAndroidHomeWidget({
      budgetLabel,
      dateLabel: shortDateLabel(now),
      dayNumber: dayNumber(now),
      focusTitle,
      headline,
      subheadline,
      updatedAtLabel,
    }).catch((error) => console.warn('[Dashboard] Android widget sync failed', error));
  }, [allowance, allowanceValue, data, pending, schedules, urgent]);
  const markComplete = useCallback(async (item: Item) => {
    const id = string(item, 'id', '');
    const entity = string(item, '__entity', 'activity');
    if (!id || completingId) return;
    setCompletingId(id);
    const key = entity === 'note' ? 'notes' : 'activities';
    setData((current) => current ? {...current, [key]: items(current[key]).map((entry) => string(entry, 'id', '') === id ? {...entry, completedAt: new Date().toISOString(), status: 'completed'} : entry)} : current);
    try {
      if (entity === 'note') await notesStore.update(uid, id, {completedAt: Timestamp.fromDate(new Date()), status: 'completed'});
      else {
        await activitiesStore.update(uid, id, {status: 'completed'});
        // Only activities live in the adaptive engine's schedule; notes have no
        // slot for it to learn a preferred hour from.
        void recordTaskCompleted(id, {scheduledEndAt: dateOf(item.endAt), scheduledStartAt: dateOf(item.startAt)});
      }
    } catch (error) {
      await load().catch(() => undefined);
      showToast('อัปเดตงานไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setCompletingId('');
    }
  }, [completingId, load, uid]);

  return <ResponsiveSafeArea style={styles.safe}><View style={styles.screen}><UserGradientBackdrop />
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.sage} />} showsVerticalScrollIndicator={false}>
      <View style={styles.topRow}>
        <SoftPress onPress={() => onNavigate('smartlife_profile')} style={styles.profileRow}><View style={styles.avatar}><View style={styles.avatarGlow} />{string(profile, 'avatarUrl', '') ? <Image source={{uri: string(profile, 'avatarUrl', '')}} style={styles.avatarImage} /> : <Text style={styles.avatarText}>{string(profile, 'displayName', 'SL').slice(0, 2).toUpperCase()}</Text>}</View><View style={styles.greeting}><Text numberOfLines={1} style={styles.hello}>{bangkokGreeting(new Date(clockNow))}</Text><Text ellipsizeMode="tail" numberOfLines={1} style={styles.name}>{string(profile, 'displayName', 'เพื่อน')}</Text></View></SoftPress>
        <View style={styles.topRowActions}>
          {/* A full card (even a softened one) at the top of the screen still
              reads as "the most important thing here" by position alone. A
              small persistent icon next to the bell is found the same way the
              bell is -- always on screen, nothing to scroll past -- without
              claiming the screen's most prominent slot for a twice-a-day habit. */}
          <SoftPress onPress={() => setSleepSheetOpen(true)} style={styles.sleepButton}><MaterialIcon color={colors.night} name="bedtime" size={22} /></SoftPress>
          <SoftPress onLayout={bellOnLayout} onPress={() => onNavigate('smartlife_notifications')} ref={bellRef} style={styles.bell}><MaterialIcon name="notifications" size={24} />{unread > 0 ? <View style={styles.unread}><Text style={styles.unreadText}>{unread > 9 ? '9+' : unread}</Text></View> : null}</SoftPress>
        </View>
      </View>

      {!data ? <View style={styles.loading}><ActivityIndicator color={colors.sage} size="large" /><Text style={styles.muted}>กำลังโหลดข้อมูลจาก Firebase</Text></View> : <>
        <Reveal index={0} slide={false}>
        <SoftPress onLayout={aiCardOnLayout} onPress={() => onNavigate('smartlife_ai_assistant')} ref={aiCardRef} style={styles.aiCard}><AuroraGradient colors={['#769674', '#8fa69a', '#9297bb', '#a8b7aa']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} /><Sheen radius={18} />
          <View style={styles.aiTop}><View style={styles.aiHeading}><MaterialIcon color="#fff" name="smart_toy" size={21} /><Text style={styles.aiTitle}>AI Assistant</Text></View>
            {/* Its own tap target: opens the assistant and starts listening right
              away, instead of landing on a blank chat the user then has to tap
              the mic in again to actually use. */}
            <Touchable accessibilityLabel="พูดกับ AI ผู้ช่วยด้วยเสียง" onPress={() => onNavigate('smartlife_ai_assistant?autoListen=1')} style={({pressed}) => [styles.mic, pressed && styles.pressed]}>
              <MaterialIcon name="mic" size={21} />
            </Touchable>
          </View>
          <Touchable onPress={() => onNavigate(`smartlife_ai_assistant?autoAsk=${encodeURIComponent('วันนี้ฉันมีเรียนกี่โมง?')}`)} style={({pressed}) => [styles.prompt, pressed && styles.pressed]}>
            <Text numberOfLines={1} style={styles.promptText}>“วันนี้ฉันมีเรียนกี่โมง?”</Text><MaterialIcon color="#fff" name="chevron_right" size={22} />
          </Touchable>
          <View style={styles.quickAnswer}><Text style={styles.quickQuestion}>“เหลือเงินกินข้าวเท่าไหร่?”</Text><View style={styles.quickAnswerRight}><Text style={styles.quickValue}>{allowanceAnswer}</Text><MaterialIcon color={colors.pine} name="chevron_right" size={16} /></View></View>
        </SoftPress>
        </Reveal>
        <Reveal index={1}>
        <View style={{marginBottom: 15}}><AiActivityRecommendationCard onNavigate={onNavigate} uid={uid} /></View>
        </Reveal>

        <Reveal index={2}>
        <View style={[styles.priorityCard, {overflow: 'hidden'}]}><LinearGradient colors={['rgba(255,255,255,.98)', '#eef4ea']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />
          <View style={styles.priorityHeader}><View style={styles.priorityTitleRow}><MaterialIcon color={colors.sageDark} name="auto_awesome" size={18} /><Text style={styles.priorityTitle}>AI จัดลำดับวันนี้</Text></View><View style={styles.dynamicBadge}><Text style={styles.dynamicText}>Dynamic</Text></View></View>
          <Text style={styles.priorityCaption}>ระบบดันสอบและงานด่วนขึ้นก่อนตามบริบทของวัน</Text>
          {urgent.length ? urgent.map((item, index) => <View key={string(item, 'id', String(index))} style={styles.priorityItem}><View style={[styles.rank, index === 1 && styles.rankSoft]}><Text style={styles.rankText}>{index + 1}</Text></View><View style={styles.priorityCopy}><Text numberOfLines={1} style={styles.priorityItemTitle}>{string(item, 'title')}</Text><Text style={styles.priorityItemSub}>{time(item.startAt)} · {string(item, 'type', 'งานสำคัญ')} · คะแนน {priorityScore(item)}</Text><View style={styles.reasonWrap}>{priorityReasons(item).map((reason) => <View key={reason} style={styles.reasonChip}><Text style={styles.reasonText}>{reason}</Text></View>)}</View></View><View style={styles.priorityActions}><View style={styles.urgency}><Text style={styles.urgencyText}>{index === 0 ? 'ด่วน' : 'สำคัญ'}</Text></View><Touchable accessibilityLabel={`ทำ ${string(item, 'title')} ให้เสร็จ`} disabled={Boolean(completingId)} onPress={() => void markComplete(item)} style={({pressed}) => [styles.doneButton, pressed && styles.pressed]}>{completingId === string(item, 'id', '') ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={15} />}<Text style={styles.doneText}>เสร็จ</Text></Touchable></View></View>) : <View style={styles.priorityItem}><View style={styles.rank}><MaterialIcon color="#fff" name="check" size={15} /></View><View style={styles.priorityCopy}><Text style={styles.priorityItemTitle}>วันนี้ไม่มีงานด่วน</Text><Text style={styles.priorityItemSub}>AI จะอัปเดตเมื่อมีรายการใหม่</Text></View></View>}
        </View>
        </Reveal>

        <Reveal index={3}>
        <QuickActions onNavigate={onNavigate} />
        </Reveal>

        {showDevTools && pending.length === 0 && transactions.length === 0 ? <Touchable disabled={seeding} onPress={seedAiDynamicData} style={({pressed}) => [styles.seedCard, pressed && styles.pressed, seeding && {opacity: .6}]}><View style={styles.seedIcon}><MaterialIcon color="#8a611c" name="database" size={20} /></View><View style={{flex: 1}}><View style={styles.seedHeadingRow}><Text style={styles.seedTitle}>เติมข้อมูลทดสอบ AI Dynamic</Text><View style={styles.devTag}><Text style={styles.devTagText}>DEV</Text></View></View><Text style={styles.seedSub}>เพิ่มตาราง งาน โน้ต และการเงินเข้า Firebase ของบัญชีนี้</Text></View><Text style={styles.seedAction}>{seeding ? 'กำลังเพิ่ม...' : 'เพิ่มเลย'}</Text></Touchable> : null}

        <Reveal index={4}>
        <View style={styles.stats}><StatCard label="คลาสเรียน" value={schedules.length} /><StatCard label="งานที่ต้องทำ" value={pending.length} /><StatCard label={allowance ? 'งบคงเหลือวันนี้' : 'ยังไม่ได้ตั้งงบ'} value={allowanceValue} /></View>
        </Reveal>

        <Reveal index={5}>
        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>ตารางวันนี้</Text><SoftPress onPress={() => onNavigate('smartlife_calendar_day')}><Text style={styles.seeAll}>ดูทั้งหมด</Text></SoftPress></View>
        <View style={styles.scheduleCard}>{schedules.length ? schedules.slice(0, 3).map((item, index) => <View key={string(item, 'id', String(index))} style={[styles.classRow, index > 0 && styles.classBorder]}><View style={styles.timePill}><Text style={styles.classTime}>{time(item.startAt)}</Text></View><View style={[styles.courseLine, {backgroundColor: string(item, 'color', index % 2 ? colors.finance : colors.sage)}]} /><View style={styles.courseCopy}><Text style={styles.courseTitle}>{string(item, 'title')}</Text><View style={styles.roomRow}><MaterialIcon color="#899284" name="location_on" size={14} /><Text style={styles.roomText}>{string(item, 'location', string(item, 'courseCode'))}</Text></View></View></View>) : <View style={styles.empty}><MaterialIcon color="#a4ada0" name="event_available" size={30} /><Text style={styles.emptyText}>วันนี้ยังไม่มีคลาสเรียน</Text></View>}</View>
        </Reveal>

        <Reveal index={6}>
        <View style={styles.focusGrid}>
          <SoftPress onPress={() => onNavigate('smartlife_finance_day')} style={styles.focusCard}><View style={styles.panelHeading}><MaterialIcon color={colors.finance} name="account_balance_wallet" size={17} /><Text style={styles.panelTitle}>งบใช้ได้วันนี้</Text></View><View style={styles.budgetLine}>{allowance ? <AnimatedNumber format={money} style={styles.budgetValue} value={allowance.amount} /> : <Text style={styles.budgetValue}>{allowanceValue}</Text>}<Text style={styles.budgetUnit}>{allowance ? '/ วันนี้' : 'ยังไม่ได้ตั้งงบ'}</Text></View><View style={styles.progress}><View style={[styles.progressFill, {width: `${monthBudgetLeftPercent}%`}]} /></View><View style={styles.tagWrap}>{transactions.filter((item) => item.type === 'expense').slice(0, 3).map((item, index) => <View key={string(item, 'id', String(index))} style={styles.tag}><Text numberOfLines={1} style={styles.tagText}>{string(item, 'category', 'ทั่วไป')} {money(Number(item.amount ?? 0))}</Text></View>)}</View></SoftPress>
        </View>
        </Reveal>

        <Reveal index={7}>
        {notes[0] ? <SoftPress onPress={() => onNavigate('smartlife_notes_study')} style={styles.noteLink}><View style={styles.noteIcon}><MaterialIcon color={colors.note} name="note_alt" size={20} /></View><View style={{flex: 1}}><Text style={styles.noteEyebrow}>โน้ตที่เชื่อมกับตารางวันนี้</Text><Text numberOfLines={1} style={styles.noteTitle}>{string(notes[0], 'title')}</Text></View><MaterialIcon color={colors.sageDark} name="chevron_right" size={23} /></SoftPress> : null}
        </Reveal>

        <Reveal index={8}>
        <View style={styles.weeklySpendingCard}>
          <View style={styles.weeklySpendingHead}><View><Text style={styles.weeklySpendingEyebrow}>สรุปการใช้เงิน</Text><Text style={styles.weeklySpendingTitle}>รายจ่ายสัปดาห์นี้</Text></View><Touchable accessibilityLabel="ดูรายละเอียดรายจ่ายรายสัปดาห์" onLayout={weeklySpendingOnLayout} onPress={() => onNavigate('smartlife_finance_week')} ref={weeklySpendingRef} style={styles.weeklySpendingLink}><Text style={styles.weeklySpendingLinkText}>ดูทั้งหมด</Text><MaterialIcon color={colors.sageDark} name="chevron_right" size={18} /></Touchable></View>
          <SpendingDonut byCategory={weeklySpending.byCategory} compact total={weeklySpending.total} />
        </View>
        </Reveal>
      </>}
    </ScrollView>
    <UserTabBar active="index" onNavigate={onNavigate} />
    <Modal animationType="slide" onRequestClose={() => setSleepSheetOpen(false)} transparent visible={sleepSheetOpen}>
      <Pressable accessibilityLabel="ปิดบันทึกการนอน" onPress={() => setSleepSheetOpen(false)} style={styles.sleepBackdrop}>
        <View onStartShouldSetResponder={() => true} style={styles.sleepSheet}>
          <View style={styles.sleepHandle} />
          <SleepLogCard onLogged={() => { void load(); }} uid={uid} variant="log" />
        </View>
      </Pressable>
    </Modal>
  </View></ResponsiveSafeArea>;
}

const shadow = {shadowColor: colors.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: .08, shadowRadius: 22};
const font = {regular: 'Prompt_400Regular', medium: 'Prompt_500Medium', semibold: 'Prompt_600SemiBold', bold: 'Prompt_700Bold', extra: 'Prompt_800ExtraBold'};
const styles = StyleSheet.create({
  devTag: {backgroundColor: '#f4b23e', borderRadius: 6, marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1},
  devTagText: {color: '#5a3d06', fontFamily: font.extra, fontSize: 9, letterSpacing: .5},
  seedAction: {color: colors.sageDark, fontFamily: font.bold, fontSize: 12},
  // Dashed amber border (instead of the app's usual solid sage) plus the DEV
  // tag next to the title so this can't be mistaken for a real feature card
  // during a demo -- it only renders when EXPO_PUBLIC_SMARTLIFE_SHOW_DEV_TOOLS is on.
  seedCard: {...shadow, alignItems: 'center', backgroundColor: '#fffbf0', borderColor: '#e8b95c', borderRadius: 17, borderStyle: 'dashed', borderWidth: 1.5, flexDirection: 'row', gap: 10, marginBottom: 15, padding: 13},
  seedHeadingRow: {alignItems: 'center', flexDirection: 'row'},
  seedIcon: {alignItems: 'center', backgroundColor: '#fbe8c4', borderRadius: 13, height: 40, justifyContent: 'center', width: 40},
  seedSub: {color: colors.muted, fontFamily: font.regular, fontSize: 12, marginTop: 1},
  seedTitle: {color: colors.pine, fontFamily: font.bold, fontSize: 12},
  aiCard: {...shadow, backgroundColor: '#88a188', borderRadius: 18, marginBottom: 15, minHeight: 142, overflow: 'hidden', padding: 16},
  aiHeading: {alignItems: 'center', flexDirection: 'row', gap: 10},
  aiTitle: {color: '#fff', fontFamily: font.bold, fontSize: 17},
  aiTop: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  avatar: {...shadow, alignItems: 'center', backgroundColor: '#834b51', borderColor: '#fff', borderRadius: 25, borderWidth: 2, flexShrink: 0, height: 50, justifyContent: 'center', overflow: 'hidden', width: 50},
  // The photo was already arriving in `data.profile` -- `user/index` loads the
  // whole users document -- but this header only ever drew initials, so a user
  // who had set a picture still saw letters here while the profile page showed
  // the photo. The circle already clips, so the image just fills it.
  avatarImage: {height: '100%', width: '100%'},
  avatarGlow: {backgroundColor: '#d8b3a5', borderRadius: 22, height: 32, opacity: .34, position: 'absolute', right: -8, top: -6, width: 32},
  avatarText: {color: '#fff', fontFamily: font.bold, fontSize: 15},
  // The bell keeps its own square and is never allowed to shrink or be
  // pushed out of the row: a long display name may only eat the space left
  // over, not the one control in the header.
  bell: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 25, flexGrow: 0, flexShrink: 0, height: 50, justifyContent: 'center', width: 50},
  sleepBackdrop: {backgroundColor: 'rgba(20,31,20,.42)', flex: 1, justifyContent: 'flex-end'},
  sleepButton: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 21, flexGrow: 0, flexShrink: 0, height: 42, justifyContent: 'center', width: 42},
  sleepHandle: {alignSelf: 'center', backgroundColor: '#d8e0d6', borderRadius: 4, height: 4, marginBottom: 4, width: 42},
  sleepSheet: {backgroundColor: '#f4f7f4', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 16, paddingBottom: 30, width: '100%'},
  budgetLine: {alignItems: 'baseline', flexDirection: 'row', marginTop: 11},
  budgetUnit: {color: colors.muted, fontFamily: font.regular, fontSize: 12, marginLeft: 4},
  budgetValue: {color: colors.pine, fontFamily: font.extra, fontSize: 24},
  classBorder: {borderTopColor: 'rgba(44,52,27,.08)', borderTopWidth: 1},
  classRow: {alignItems: 'center', flexDirection: 'row', minHeight: 70, paddingHorizontal: 13},
  classTime: {color: colors.sageDark, fontFamily: font.bold, fontSize: 12},
  collapsed: {alignItems: 'center', backgroundColor: '#eef2e9', borderRadius: 11, flexDirection: 'row', gap: 8, marginTop: 10, paddingHorizontal: 11, paddingVertical: 9},
  collapsedText: {color: '#7b8476', flex: 1, fontFamily: font.regular, fontSize: 12, lineHeight: 18},
  content: {padding: 22, paddingBottom: 28},
  courseCopy: {flex: 1},
  courseLine: {borderRadius: 3, height: 38, marginHorizontal: 11, width: 4},
  courseTitle: {color: colors.pine, fontFamily: font.semibold, fontSize: 13},
  dynamicBadge: {backgroundColor: '#e8f0e4', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5},
  dynamicText: {color: colors.sageDark, fontFamily: font.semibold, fontSize: 12},
  doneButton: {alignItems: 'center', backgroundColor: colors.sageDark, borderRadius: 10, flexDirection: 'row', gap: 2, minHeight: 29, paddingHorizontal: 7},
  doneText: {color: '#fff', fontFamily: font.bold, fontSize: 12},
  empty: {alignItems: 'center', gap: 8, paddingVertical: 22},
  emptyText: {color: colors.muted, fontFamily: font.regular, fontSize: 12},
  focusCard: {...shadow, backgroundColor: '#fff', borderRadius: 17, flex: 1, minHeight: 154, padding: 13},
  focusGrid: {flexDirection: 'row', gap: 11, marginBottom: 15, marginTop: 11},
  hello: {color: '#8a9282', fontFamily: font.regular, fontSize: 12},
  loading: {alignItems: 'center', gap: 12, paddingVertical: 100},
  mic: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.95)', borderColor: 'rgba(255,255,255,.55)', borderRadius: 22, borderWidth: 5, height: 44, justifyContent: 'center', width: 44},
  muted: {color: colors.muted, fontFamily: font.regular, fontSize: 12},
  name: {color: colors.pine, fontFamily: font.extra, fontSize: 19, marginTop: -1},
  noteEyebrow: {color: colors.note, fontFamily: font.semibold, fontSize: 12},
  noteIcon: {alignItems: 'center', backgroundColor: colors.noteSoft, borderRadius: 12, height: 39, justifyContent: 'center', width: 39},
  noteLink: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 17, flexDirection: 'row', gap: 11, marginBottom: 4, padding: 13},
  noteTitle: {color: colors.pine, fontFamily: font.semibold, fontSize: 12, marginTop: 1},
  panelHeading: {alignItems: 'center', flexDirection: 'row', gap: 6},
  panelTitle: {color: colors.pine, fontFamily: font.bold, fontSize: 12},
  pressed: {opacity: .85, transform: [{scale: .985}]},
  priorityCaption: {color: colors.muted, fontFamily: font.regular, fontSize: 12, marginBottom: 8, marginTop: 3},
  priorityCard: {...shadow, backgroundColor: '#fff', borderRadius: 18, marginBottom: 15, padding: 14},
  priorityCopy: {flex: 1},
  priorityHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  priorityItem: {alignItems: 'center', backgroundColor: '#f6f8f3', borderColor: 'rgba(44,52,27,.06)', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 9, marginTop: 7, padding: 9},
  priorityActions: {alignItems: 'flex-end', gap: 6},
  priorityItemSub: {color: colors.muted, fontFamily: font.regular, fontSize: 12, marginTop: 1},
  priorityItemTitle: {color: colors.pine, fontFamily: font.semibold, fontSize: 12},
  priorityTitle: {color: colors.pine, fontFamily: font.bold, fontSize: 14},
  priorityTitleRow: {alignItems: 'center', flexDirection: 'row', gap: 7},
  progress: {backgroundColor: '#e6e6ec', borderRadius: 99, height: 6, marginTop: 9, overflow: 'hidden'},
  progressFill: {backgroundColor: colors.finance, borderRadius: 99, height: 6},
  // `minWidth: 0` is what actually lets the name truncate on web, where a
  // flex item defaults to min-width:auto and refuses to shrink below its
  // content -- which is how a 30-character name ran off the screen edge.
  greeting: {flex: 1, minWidth: 0},
  profileRow: {alignItems: 'center', flex: 1, flexDirection: 'row', gap: 12, minWidth: 0},
  prompt: {alignItems: 'center', backgroundColor: 'rgba(72,105,72,.24)', borderColor: 'rgba(44,52,27,.08)', borderRadius: 14, borderWidth: 1, flexDirection: 'row', height: 41, justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 13},
  promptText: {color: '#fff', flex: 1, fontFamily: font.regular, fontSize: 12},
  quickAction: {alignItems: 'center', borderRadius: 14, flex: 1, gap: 6, paddingVertical: 10},
  quickActionIcon: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 22, height: 46, justifyContent: 'center', width: 46},
  quickActionLabel: {color: colors.pine, fontFamily: font.semibold, fontSize: 11},
  quickActionsPanel: {...shadow, backgroundColor: '#fff', borderRadius: 18, flexDirection: 'row', gap: 4, marginBottom: 15, padding: 10},
  quickAnswer: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.45)', borderRadius: 11, flexDirection: 'row', justifyContent: 'space-between', marginTop: 7, paddingHorizontal: 11, paddingVertical: 7},
  quickAnswerRight: {alignItems: 'center', flexDirection: 'row', gap: 2},
  quickQuestion: {color: colors.pine, fontFamily: font.regular, fontSize: 12},
  quickValue: {color: colors.pine, fontFamily: font.bold, fontSize: 12},
  rank: {alignItems: 'center', backgroundColor: colors.pine, borderRadius: 9, height: 26, justifyContent: 'center', width: 26},
  rankSoft: {backgroundColor: colors.sage},
  rankText: {color: '#fff', fontFamily: font.bold, fontSize: 12},
  reasonChip: {backgroundColor: '#edf3ea', borderRadius: 99, paddingHorizontal: 7, paddingVertical: 3},
  reasonText: {color: colors.sageDark, fontFamily: font.semibold, fontSize: 12},
  reasonWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5},
  roomRow: {alignItems: 'center', flexDirection: 'row', marginTop: 3},
  roomText: {color: '#899284', fontFamily: font.regular, fontSize: 12},
  safe: {backgroundColor: '#eef1e9', flex: 1},
  scheduleCard: {...shadow, backgroundColor: '#fff', borderRadius: 18, marginBottom: 16, overflow: 'hidden'},
  screen: {backgroundColor: colors.mist, flex: 1},
  sectionHeading: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10},
  sectionTitle: {color: colors.pine, fontFamily: font.bold, fontSize: 15},
  seeAll: {color: colors.sageDark, fontFamily: font.semibold, fontSize: 12},
  statCard: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 17, flex: 1, height: 101, justifyContent: 'center'},
  statLabel: {color: colors.muted, fontFamily: font.regular, fontSize: 12, marginTop: 1, textAlign: 'center'},
  statValue: {color: colors.pine, fontFamily: font.extra, fontSize: 19, marginTop: 4},
  stats: {flexDirection: 'row', gap: 10, marginBottom: 17},
  tag: {backgroundColor: colors.financeSoft, borderRadius: 99, maxWidth: '100%', paddingHorizontal: 7, paddingVertical: 3},
  tagText: {color: '#73799f', fontFamily: font.medium, fontSize: 12},
  tagWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 9},
  timePill: {alignItems: 'center', backgroundColor: '#edf3ea', borderRadius: 10, minWidth: 48, paddingHorizontal: 7, paddingVertical: 6},
  topRow: {alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'space-between', marginBottom: 15},
  topRowActions: {alignItems: 'center', flexDirection: 'row', gap: 9},
  unread: {alignItems: 'center', backgroundColor: '#f35659', borderColor: '#fff', borderRadius: 8, borderWidth: 2, height: 16, justifyContent: 'center', minWidth: 16, position: 'absolute', right: 4, top: 4},
  unreadText: {color: '#fff', fontFamily: font.bold, fontSize: 12},
  urgency: {backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4},
  urgencyText: {color: colors.note, fontFamily: font.semibold, fontSize: 12},
  weeklySpendingCard: {...shadow, backgroundColor: '#fff', borderColor: 'rgba(111,143,109,.16)', borderRadius: 19, borderWidth: 1, marginBottom: 5, marginTop: 12, padding: 14},
  weeklySpendingEyebrow: {color: colors.finance, fontFamily: font.bold, fontSize: 12},
  weeklySpendingHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  weeklySpendingLink: {alignItems: 'center', flexDirection: 'row', gap: 2, paddingVertical: 5},
  weeklySpendingLinkText: {color: colors.sageDark, fontFamily: font.semibold, fontSize: 12},
  weeklySpendingTitle: {color: colors.pine, fontFamily: font.extra, fontSize: 15, marginTop: 1},
});
