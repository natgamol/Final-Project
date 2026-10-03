/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';

import {Touchable} from '@/components/touchable';
import {aiRecommendations, notifications} from '@/services/firestore';
import {loadLegacyPageData} from '@/services/legacy-data';
import {loadMonthlyBudget} from '@/services/monthly-budget';
import {buildNotificationFeed, itemsOf, type FeedItem} from '@/services/notification-feed';
import type {AiRecommendation, Notification, WithId} from '@/types/smartlife';
import {MaterialIcon, UserShell, type UserNavigate} from './user-ui';

type Page = 'smartlife_notifications' | 'smartlife_notifications_urgent' | 'smartlife_notifications_ai' | 'smartlife_notifications_finance' | 'smartlife_notifications_schedule';

type ViewModel = {
  ai: WithId<AiRecommendation>[];
  /** Everything the bell is currently saying: derived alerts plus stored ones. */
  feed: FeedItem[];
};

const tabs: {label: string; page: Page}[] = [
  {label: 'ทั้งหมด', page: 'smartlife_notifications'},
  {label: 'ด่วน', page: 'smartlife_notifications_urgent'},
  {label: 'AI', page: 'smartlife_notifications_ai'},
  {label: 'การเงิน', page: 'smartlife_notifications_finance'},
  {label: 'ตารางเรียน', page: 'smartlife_notifications_schedule'},
];

const pageMeta: Record<Page, {eyebrow: string; title: string; heroSubtitle: string; sectionTitle: string; sideLabel: string}> = {
  smartlife_notifications: {
    eyebrow: 'SmartLife Alert',
    title: 'การแจ้งเตือน',
    heroSubtitle: 'AI เตือนเรื่องเรียนและชีวิตประจำวันที่ควรดูตอนนี้',
    sectionTitle: 'ตอนนี้',
    sideLabel: 'ต้องจัดการก่อน',
  },
  smartlife_notifications_urgent: {
    eyebrow: 'Priority Alert',
    title: 'แจ้งเตือนด่วน',
    heroSubtitle: 'งานและคิวที่ต้องจัดการก่อนหายไปในวันนี้',
    sectionTitle: 'ด่วนตอนนี้',
    sideLabel: 'ต้องจัดการก่อน',
  },
  smartlife_notifications_ai: {
    eyebrow: 'AI Insight',
    title: 'AI แจ้งเตือน',
    heroSubtitle: 'ระบบวิเคราะห์พฤติกรรมและสุขภาพการเรียนของคุณ',
    sectionTitle: 'AI แจ้งเตือน',
    sideLabel: 'แนะนำจากพฤติกรรม',
  },
  smartlife_notifications_finance: {
    eyebrow: 'Money Alert',
    title: 'แจ้งเตือนการเงิน',
    heroSubtitle: 'ติดตามงบประมาณและรายจ่ายที่อาจเกินเงื่อนไข',
    sectionTitle: 'การเงิน',
    sideLabel: 'งบและรายจ่าย',
  },
  smartlife_notifications_schedule: {
    eyebrow: 'Schedule Alert',
    title: 'แจ้งเตือนตารางเรียน',
    heroSubtitle: 'รวมงานและคลาสที่ต้องเตรียมตัวในวันนี้',
    sectionTitle: 'ตารางเรียนวันนี้',
    sideLabel: 'ต้องเตรียมตัวก่อน',
  },
};

function toneFor(kind: Notification['kind']) {
  if (kind === 'urgent') return {bg: '#fff1ef', fg: '#d9675f', icon: 'schedule'};
  if (kind === 'finance') return {bg: '#eef5ed', fg: '#6f8f6d', icon: 'account_balance_wallet'};
  if (kind === 'schedule') return {bg: '#edf6ea', fg: '#6f8f6d', icon: 'calendar_month'};
  if (kind === 'ai') return {bg: '#f2f3ff', fg: '#8d91c5', icon: 'auto_awesome'};
  return {bg: '#eef5ed', fg: '#6f8f6d', icon: 'notifications'};
}

function Header({onNavigate, meta}: {meta: typeof pageMeta[Page]; onNavigate: UserNavigate}) {
  return (
    <View style={styles.header}>
      <Touchable onPress={() => onNavigate('smartlife_ai_assistant')} style={styles.headerButton}>
        <MaterialIcon color="#26321f" name="chevron_left" size={22} />
      </Touchable>
      <View style={styles.headerTitle}>
        <Text style={styles.eyebrow}>{meta.eyebrow}</Text>
        <Text style={styles.title}>{meta.title}</Text>
      </View>
    </View>
  );
}

/**
 * Where tapping a notification should take the user, so they don't have to
 * manually switch tabs and hunt for the item it is about. Derived alerts
 * carry no per-record route to open, so this lands on the relevant tab
 * rather than a specific transaction/task -- still one fewer step than today.
 */
function targetPageFor(item: FeedItem): string | null {
  if (item.source === 'note') return 'smartlife_notes';
  if (item.source === 'calendar') return 'smartlife_calendar_day';
  if (item.source === 'finance' || item.kind === 'finance') return 'smartlife_finance_day';
  if (item.kind === 'schedule') return 'smartlife_calendar_day';
  if (item.kind === 'ai') return 'smartlife_ai_assistant';
  return null;
}

/**
 * Which alerts a tab shows. Derived alerts are matched on their source as well
 * as their kind, so a budget alert computed on this device lands under
 * "การเงิน" exactly like a stored one the server wrote.
 */
function feedForPage(page: Page, feed: FeedItem[]) {
  if (page === 'smartlife_notifications') return feed;
  if (page === 'smartlife_notifications_urgent') return feed.filter((item) => item.severity === 'urgent');
  if (page === 'smartlife_notifications_ai') return feed.filter((item) => item.kind === 'ai');
  if (page === 'smartlife_notifications_finance') return feed.filter((item) => item.source === 'finance' || item.kind === 'finance');
  return feed.filter((item) => item.source === 'calendar' || item.kind === 'schedule');
}

function pageCount(page: Page, model: ViewModel) {
  const count = feedForPage(page, model.feed).length;
  return page === 'smartlife_notifications' || page === 'smartlife_notifications_ai' ? count + model.ai.length : count;
}

function heroTitleFor(page: Page, count: number) {
  if (count === 0) {
    if (page === 'smartlife_notifications') return 'ยังไม่มีการแจ้งเตือน';
    if (page === 'smartlife_notifications_ai') return 'ยังไม่มีคำแนะนำจาก AI';
    if (page === 'smartlife_notifications_finance') return 'ยังไม่มีแจ้งเตือนการเงิน';
    if (page === 'smartlife_notifications_schedule') return 'ยังไม่มีแจ้งเตือนตารางเรียน';
    return 'ยังไม่มีรายการด่วน';
  }
  if (page === 'smartlife_notifications') return `มีเรื่องสำคัญ ${count} รายการ`;
  if (page === 'smartlife_notifications_ai') return `คำแนะนำจาก AI ${count} รายการ`;
  if (page === 'smartlife_notifications_finance') return `การเงินวันนี้ ${count} รายการ`;
  if (page === 'smartlife_notifications_schedule') return `ตารางเรียนวันนี้ ${count} รายการ`;
  return `รายการด่วน ${count} รายการ`;
}

function Hero({meta, model, page}: {meta: typeof pageMeta[Page]; model: ViewModel; page: Page}) {
  const urgent = model.feed.filter((item) => item.severity === 'urgent').length;
  const ai = model.ai.length + model.feed.filter((item) => item.kind === 'ai').length;
  const today = model.feed.length + model.ai.length;
  const current = pageCount(page, model);
  return (
    <LinearGradient colors={['#6f966f', '#8fac94']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.hero}>
      <View style={styles.heroTop}>
        <View style={{flex: 1}}>
          <Text style={styles.heroTitle}>{heroTitleFor(page, current)}</Text>
          <Text style={styles.heroSubtitle}>{meta.heroSubtitle}</Text>
        </View>
        <View style={styles.heroBell}><MaterialIcon color="#ffffff" name="notifications" size={24} /></View>
      </View>
      <View style={styles.metricGrid}>
        <Metric label="ด่วน" value={urgent} />
        <Metric label="AI" value={ai} />
        <Metric label="วันนี้" value={today} />
      </View>
    </LinearGradient>
  );
}

function Metric({label, value}: {label: string; value: number}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function Tabs({page, onNavigate}: {onNavigate: UserNavigate; page: Page}) {
  return (
    <View style={styles.tabs}>
      {tabs.map((tab) => {
        const active = tab.page === page;
        return (
          <Touchable key={tab.page} onPress={() => onNavigate(tab.page)} style={[styles.tab, active && styles.tabActive]}>
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
          </Touchable>
        );
      })}
    </View>
  );
}

function SectionHeader({meta}: {meta: typeof pageMeta[Page]}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{meta.sectionTitle}</Text>
      <Text style={styles.sectionSide}>{meta.sideLabel}</Text>
    </View>
  );
}

const sourceLabel: Record<FeedItem['source'], string> = {
  calendar: 'ตารางและงาน',
  finance: 'งบประมาณ',
  note: 'โน้ต',
  stored: 'ระบบ',
};

function FeedCard({item, onPress}: {item: FeedItem; onPress: () => void}) {
  const tone = toneFor(item.kind);
  const urgent = item.severity === 'urgent';
  return (
    <Touchable onPress={onPress} style={[styles.itemCard, {borderColor: urgent ? '#f2d7d2' : '#e7ece2'}]}>
      <View style={[styles.itemIcon, {backgroundColor: tone.bg}]}>
        <MaterialIcon color={tone.fg} name={tone.icon} size={18} />
      </View>
      <View style={{flex: 1}}>
        <Text numberOfLines={2} style={styles.itemTitle}>{item.title || 'การแจ้งเตือน SmartLife'}</Text>
        <Text numberOfLines={3} style={styles.itemText}>{item.message || 'ไม่มีรายละเอียด'}</Text>
        <View style={styles.chips}>
          <Chip tone={urgent ? 'red' : 'green'}>{urgent ? 'ด่วน' : 'ควรดู'}</Chip>
          <Chip tone="green">{sourceLabel[item.source]}</Chip>
          {item.reasons.map((reason) => <Chip key={reason} tone="green">{reason}</Chip>)}
          {item.unread ? <Chip tone="purple">ใหม่</Chip> : null}
        </View>
      </View>
    </Touchable>
  );
}

function AiCard({item}: {item: WithId<AiRecommendation>}) {
  return (
    <View style={styles.itemCard}>
      <View style={[styles.itemIcon, {backgroundColor: '#f2f3ff'}]}>
        <MaterialIcon color="#8d91c5" name="auto_awesome" size={18} />
      </View>
      <View style={{flex: 1}}>
        <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
        <Text numberOfLines={2} style={styles.itemText}>{item.explanation}</Text>
        <View style={styles.chips}>
          <Chip tone="purple">AI</Chip>
          {item.contextSources.slice(0, 2).map((source) => <Chip key={source} tone="green">{source}</Chip>)}
        </View>
      </View>
    </View>
  );
}

function Chip({children, tone}: {children: string; tone: 'green' | 'purple' | 'red'}) {
  const style = tone === 'red' ? styles.chipRed : tone === 'purple' ? styles.chipPurple : styles.chipGreen;
  return <Text style={[styles.chip, style]}>{children}</Text>;
}

export default function NotificationsScreen({page, uid, onNavigate}: {page: Page; uid: string; onNavigate: UserNavigate}) {
  const [model, setModel] = useState<ViewModel | null>(null);
  const meta = pageMeta[page];

  // The same three sources the dashboard bell counts, gathered here so the list
  // and the badge are computed from one feed rather than two.
  const load = useCallback(async () => {
    const [pageData, monthData, savedBudget, stored, ai] = await Promise.all([
      (loadLegacyPageData(uid, 'user/index') as Promise<Record<string, unknown>>)
        .catch((error) => { console.error('[Notifications] Day data load failed', error); return {} as Record<string, unknown>; }),
      (loadLegacyPageData(uid, 'user/smartlife_finance_month') as Promise<{transactions?: unknown}>)
        .catch((error) => { console.error('[Notifications] Month transactions load failed', error); return null; }),
      loadMonthlyBudget(uid).catch((error) => { console.error('[Notifications] Saved budget load failed', error); return null; }),
      notifications.list(uid).catch(() => []),
      page === 'smartlife_notifications_ai' || page === 'smartlife_notifications' ? aiRecommendations.list(uid).catch(() => []) : Promise.resolve([]),
    ]);
    const feed = buildNotificationFeed({
      activities: pageData.activities,
      dailyBudget: savedBudget?.dailyAmount,
      monthlyBudget: savedBudget?.amount ?? 0,
      weeklyBudget: savedBudget?.weeklyAmount,
      monthTransactions: itemsOf(monthData?.transactions).map((item) => ({
        amount: Number(item.amount ?? 0),
        occurredAt: item.occurredAt as never,
        type: item.type === 'income' ? 'income' : 'expense',
      })),
      notes: pageData.notes,
      stored,
      todayExpenses: itemsOf(pageData.transactions)
        .filter((item) => item.type === 'expense')
        .map((item) => ({amount: Number(item.amount ?? 0)})),
    });
    setModel({ai, feed});

    // Opening the list is reading it. Stored notices only ever turned read when
    // one was tapped, and tapping one navigates away, so a user who opened the
    // list and looked never cleared anything and the bell's number never fell.
    //
    // Scoped to this page's own feed rather than the eight rows it draws: the
    // cap is a display limit, and a stored notice sorted past it would
    // otherwise stay unread with no way to reach it, keeping the badge up for
    // good. Derived alerts are left alone -- they count while their condition
    // holds, which is the point of them.
    //
    // The rows on screen keep their "ใหม่" chip for this visit. Flipping them
    // now would erase the only cue to which ones are new at the moment the
    // reader arrives; the badge does not live on this screen, and the
    // dashboard reads the flags fresh when it is next shown.
    const unseen = feedForPage(page, feed).filter((item) => item.source === 'stored' && item.unread);
    if (unseen.length) {
      Promise.all(unseen.map((item) => notifications.markRead(uid, item.id.replace('stored:', ''))))
        .catch((error) => console.error('[Notifications] Marking the list read failed', error));
    }
  }, [page, uid]);

  useEffect(() => {
    load().catch(() => setModel({ai: [], feed: []}));
  }, [load]);

  const visibleAi = useMemo(() => model?.ai.slice(0, page === 'smartlife_notifications_ai' ? 4 : 2) ?? [], [model?.ai, page]);
  const visibleItems = useMemo(() => feedForPage(page, model?.feed ?? []).slice(0, 8), [model?.feed, page]);

  // Only stored notifications have a read flag to set; a derived alert is
  // cleared by resolving what caused it, not by tapping it.
  const markRead = async (item: FeedItem) => {
    if (item.source !== 'stored') return;
    const id = item.id.replace('stored:', '');
    await notifications.markRead(uid, id);
    setModel((current) => current ? {
      ai: current.ai,
      feed: current.feed.map((entry) => entry.id === item.id ? {...entry, unread: false} : entry),
    } : current);
  };

  const openItem = (item: FeedItem) => {
    void markRead(item);
    const target = targetPageFor(item);
    if (target) onNavigate(target);
  };

  return (
    <UserShell active="index" onNavigate={onNavigate}>
      <Header meta={meta} onNavigate={onNavigate} />
      {model === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#6f966f" size="large" />
          <Text style={styles.emptyText}>กำลังโหลดการแจ้งเตือน...</Text>
        </View>
      ) : (
        <>
          <Hero meta={meta} model={model} page={page} />
          <Tabs onNavigate={onNavigate} page={page} />
          <SectionHeader meta={meta} />
          <View style={styles.list}>
            {visibleItems.length ? visibleItems.map((item) => (
              <FeedCard item={item} key={item.id} onPress={() => openItem(item)} />
            )) : null}
            {(page === 'smartlife_notifications_ai' || page === 'smartlife_notifications') && visibleAi.length ? visibleAi.map((item) => (
              <AiCard item={item} key={item.id} />
            )) : null}
            {!visibleItems.length && !visibleAi.length ? <Text style={styles.emptyText}>ไม่มีการแจ้งเตือนในหมวดนี้</Text> : null}
          </View>
        </>
      )}
    </UserShell>
  );
}

const styles = StyleSheet.create({
  chip: {borderRadius: 99, fontFamily: 'Prompt_600SemiBold', fontSize: 12, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3},
  chipGreen: {backgroundColor: '#edf4e9', color: '#66835f'},
  chipPurple: {backgroundColor: '#eef0ff', color: '#8d91c5'},
  chipRed: {backgroundColor: '#ffe8e5', color: '#d9675f'},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8},
  emptyText: {color: '#8b9487', fontFamily: 'Prompt_500Medium', fontSize: 12, textAlign: 'center'},
  eyebrow: {color: '#668d65', fontFamily: 'Prompt_800ExtraBold', fontSize: 12, lineHeight: 18},
  header: {alignItems: 'center', flexDirection: 'row', gap: 10},
  headerButton: {alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 14, height: 44, justifyContent: 'center', width: 44},
  headerTitle: {flex: 1},
  hero: {borderRadius: 18, gap: 12, marginTop: 12, padding: 16},
  heroBell: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.18)', borderRadius: 16, height: 52, justifyContent: 'center', width: 52},
  heroSubtitle: {color: 'rgba(255,255,255,.84)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 4},
  heroTitle: {color: '#ffffff', fontFamily: 'Prompt_800ExtraBold', fontSize: 18},
  heroTop: {alignItems: 'center', flexDirection: 'row', gap: 12},
  itemCard: {alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#e7ece2', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 12, minHeight: 82, padding: 13},
  itemIcon: {alignItems: 'center', borderRadius: 14, height: 44, justifyContent: 'center', width: 44},
  itemText: {color: '#7d8778', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  itemTitle: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12},
  list: {gap: 10, marginTop: 10},
  loading: {alignItems: 'center', gap: 12, paddingVertical: 80},
  metric: {backgroundColor: 'rgba(255,255,255,.16)', borderRadius: 12, flex: 1, minHeight: 58, padding: 10},
  metricGrid: {flexDirection: 'row', gap: 9},
  metricLabel: {color: 'rgba(255,255,255,.8)', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  metricValue: {color: '#ffffff', fontFamily: 'Prompt_800ExtraBold', fontSize: 20, lineHeight: 25, marginTop: 4},
  sectionHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 8},
  sectionSide: {color: '#789071', fontFamily: 'Prompt_500Medium', fontSize: 12},
  sectionTitle: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 14},
  tab: {backgroundColor: '#ffffff', borderRadius: 99, paddingHorizontal: 13, paddingVertical: 8},
  tabActive: {backgroundColor: '#26321f'},
  tabText: {color: '#789071', fontFamily: 'Prompt_700Bold', fontSize: 12},
  tabTextActive: {color: '#ffffff'},
  tabs: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
  title: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 24, lineHeight: 30},
});
