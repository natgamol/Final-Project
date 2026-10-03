/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated as RNAnimated, Modal, PanResponder, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import Animated, {FadeIn, FadeOut, LinearTransition} from 'react-native-reanimated';
import {CalendarList, CalendarProvider, WeekCalendar, type DateData} from 'react-native-calendars';
import {Timestamp} from 'firebase/firestore';
import {useLocalSearchParams} from 'expo-router';


import {registerThaiCalendarLocale, THAI_MONTH_NAMES} from '@/lib/calendar-locale';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import GoogleCalendarSyncCard from '@/components/google-calendar-sync-card';
import AiActivityRecommendationCard from '@/components/ai-activity-recommendation-card';
import ConfirmDialog from '@/components/confirm-dialog';
import {activities, deleteCourseSeries, schedules} from '@/services/firestore';
import {recordTaskCompleted, recordTaskPostponed} from '@/services/behavior-tracking';
import {MaterialIcon, UserTabBar} from './user-ui';
import {showToast} from '@/components/app-toast';
import {useTourTarget} from '@/hooks/use-tour-target';
import {useTour} from '@/providers/tour-provider';

type Page = 'smartlife_calendar_day' | 'smartlife_calendar_week' | 'smartlife_calendar_month';
type PlannerTab = 'adaptive' | 'calendar' | 'notes';
type ViewMode = 'day' | 'week' | 'month' | 'year';
type EventItem = Record<string, unknown> & {
  id?: string;
  title?: string;
  color?: string;
  entityType?: 'activity' | 'schedule';
  location?: string;
  courseCode?: string;
  priority?: string;
  seriesId?: string;
  type?: string;
};
type Props = {
  onNavigate: (page: string) => void;
  page: Page;
  planner?: {activeTab: PlannerTab; onTabChange: (tab: PlannerTab) => void};
  uid: string;
};

const C = {
  accent: '#5f835f',
  accentSoft: '#dfe7dc',
  background: '#f4f5ef',
  blue: '#9297bb',
  card: '#ffffff',
  green: '#6f8f6d',
  label: '#2c341b',
  line: '#dfe7dc',
  secondary: '#8b9085',
  tertiary: '#b7bdb3',
};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

registerThaiCalendarLocale();

function pad(value: number) { return String(value).padStart(2, '0'); }
function toDate(value: unknown) {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as {toDate?: unknown}).toDate === 'function') return (value as {toDate: () => Date}).toDate();
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
/**
 * Until now the app had no way to move a scheduled activity at all: the
 * calendar could only complete or delete one, and the activity form only
 * creates. That gap is the reason `task_postponed` had never been recorded by
 * anything -- the action it names did not exist for the user to take. These
 * three offsets cover the postpones the adaptive proposal is actually about (a
 * morning slot pushed into the afternoon, or to the next day) without demanding
 * a full date picker.
 */
const POSTPONE_OPTIONS: {hint: string; label: string; shift: (from: Date) => Date}[] = [
  {hint: 'เลื่อนสั้น ๆ ให้ทำต่อทีหลัง', label: 'อีก 1 ชั่วโมง', shift: (from) => new Date(from.getTime() + 3600000)},
  {hint: 'ย้ายงานเช้าไปทำช่วงบ่าย', label: 'บ่ายนี้ 13:00', shift: (from) => atBangkokHour(from, 13)},
  {hint: 'ยกไปวันถัดไปเวลาเดิม', label: 'พรุ่งนี้เวลาเดิม', shift: (from) => new Date(from.getTime() + 86400000)},
];
function atBangkokHour(from: Date, hour: number) {
  const parts = bangkokParts(from);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 7));
}
function bangkokParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok'}).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute')};
}
function todayKey() { const part = bangkokParts(new Date()); return `${part.year}-${part.month}-${part.day}`; }
function dateKey(value: unknown) { const part = bangkokParts(toDate(value)); return `${part.year}-${part.month}-${part.day}`; }
function formatTime(value: unknown) { return new Intl.DateTimeFormat('th-TH', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok'}).format(toDate(value)); }
/**
 * The Buddhist year, computed rather than left to the locale.
 *
 * `th-TH` resolves to the Buddhist calendar on web's full-ICU build but to the
 * Gregorian one on Android's Hermes, so the same screen printed "กันยายน 2569"
 * in a browser and "กันยายน ค.ศ. 2026" in the app.
 */
function buddhistYear(value: string) { return Number(value.slice(0, 4)) + 543; }
function formatLongDate(value: string) { return `${new Intl.DateTimeFormat('th-TH', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Bangkok'}).format(new Date(`${value}T12:00:00+07:00`))} ${buddhistYear(value)}`; }
function formatMonth(value: string) { return `${new Intl.DateTimeFormat('th-TH', {month: 'long', timeZone: 'Asia/Bangkok'}).format(new Date(`${value}T12:00:00+07:00`))} ${buddhistYear(value)}`; }
function shortDay(value: string) { return new Intl.DateTimeFormat('th-TH', {weekday: 'short', timeZone: 'Asia/Bangkok'}).format(new Date(`${value}T12:00:00+07:00`)); }
function eventTitle(item: EventItem) { return typeof item.title === 'string' && item.title.trim() ? item.title : 'กิจกรรม'; }
function textEvent(value: unknown, fallback: string) { return typeof value === 'string' && value.trim() ? value : fallback; }
function priorityInfo(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const priority = value.toLowerCase();
  if (priority === 'urgent') return {backgroundColor: '#f8e4e1', color: '#b84e43', label: 'เร่งด่วน'};
  if (priority === 'important' || priority === 'high') return {backgroundColor: '#fbf0d9', color: '#9a6b18', label: 'สำคัญ'};
  return {backgroundColor: '#e8f0e5', color: '#5f835f', label: 'ทั่วไป'};
}
function offsetDate(value: string, amount: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount, 12));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function shift(value: string, mode: ViewMode, direction: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (mode === 'year') date.setUTCFullYear(date.getUTCFullYear() + direction);
  else if (mode === 'month') date.setUTCMonth(date.getUTCMonth() + direction);
  else date.setUTCDate(date.getUTCDate() + (mode === 'week' ? 7 : 1) * direction);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function rangeFor(value: string, mode: ViewMode) {
  const [year, month, day] = value.split('-').map(Number);
  if (mode === 'year') return {from: new Date(Date.UTC(year, 0, 1) - 7 * 3600000), to: new Date(Date.UTC(year + 1, 0, 1) - 7 * 3600000)};
  if (mode === 'month') return {from: new Date(Date.UTC(year, month - 1, 1) - 7 * 3600000), to: new Date(Date.UTC(year, month, 1) - 7 * 3600000)};
  if (mode === 'day') {
    const from = new Date(Date.UTC(year, month - 1, day) - 7 * 3600000);
    return {from, to: new Date(from.getTime() + 86400000)};
  }
  const base = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = base.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(Date.UTC(year, month - 1, day + mondayOffset) - 7 * 3600000);
  return {from: monday, to: new Date(monday.getTime() + 7 * 86400000)};
}
function miniMonthDays(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1, 12));
  const leading = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  return [...Array(leading).fill(null), ...Array.from({length: count}, (_, index) => `${year}-${pad(month + 1)}-${pad(index + 1)}`)];
}

export default function CalendarScreen({onNavigate, page, planner, uid}: Props) {
  const {maybeStartTour} = useTour();
  const {ref: importScheduleRef, onLayout: importScheduleOnLayout} = useTourTarget('calendar', 'import-schedule');
  useEffect(() => {
    maybeStartTour('calendar');
  }, [maybeStartTour]);
  const {width} = useWindowDimensions();
  const calendarWidth = Math.min(Math.max(width - 32, 310), width >= 900 ? 1168 : 680);
  const [today] = useState(todayKey);
  // A `date` in the address is a day someone was sent to -- the activity form
  // passes the one it just saved. It opens in day mode, so the new item is on
  // screen rather than selected somewhere beneath a week or month view.
  const params = useLocalSearchParams<{date?: string}>();
  const requestedDate = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;
  const [mode, setMode] = useState<ViewMode>(requestedDate ? 'day' : page === 'smartlife_calendar_month' ? 'month' : page === 'smartlife_calendar_week' ? 'week' : 'day');
  const [selectedDate, setSelectedDate] = useState(requestedDate ?? today);
  const [visibleDate, setVisibleDate] = useState(requestedDate ?? today);
  /**
   * The month the list is anchored to. Moved only by a deliberate navigation,
   * never by scrolling -- that separation is what stops the list from chasing
   * its own scroll position, while `visibleDate` still follows the swipe so
   * the header and the agenda track what is actually on screen.
   */
  const [monthAnchor, setMonthAnchor] = useState(requestedDate ?? today);
  /**
   * Bumped by every deliberate navigation, including one that re-selects the
   * month already anchored. Swiping moves the list without moving the anchor,
   * so after a swipe "วันนี้" sets an anchor that is already current -- without
   * this the effect below would not re-run and the list would stay where the
   * swipe left it.
   */
  const [reanchor, setReanchor] = useState(0);
  const monthList = useRef<{scrollToMonth?: (date: string) => void} | null>(null);
  /** Whether the user has actually dragged the month list since it was anchored. */
  const monthDragged = useRef(false);
  /** True while the list is still being pushed onto its anchor after a mount. */
  const settling = useRef(true);

  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [completingId, setCompletingId] = useState('');
  const [postponing, setPostponing] = useState<EventItem | null>(null);
  const [postponeBusy, setPostponeBusy] = useState(false);
  const [deleting, setDeleting] = useState<EventItem | null>(null);
  const [deleteError, setDeleteError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const {from, to} = rangeFor(visibleDate, mode);
      const [classItems, activityItems] = await Promise.all([schedules.between(uid, from, to), activities.between(uid, from, to)]);
      setEvents([
        ...classItems.map((item) => ({...item, entityType: 'schedule' as const})),
        ...activityItems.filter((item) => item.status !== 'completed' && item.status !== 'cancelled').map((item) => ({...item, entityType: 'activity' as const})),
      ].sort((a, b) => toDate(a.startAt).getTime() - toDate(b.startAt).getTime()));
    } finally {
      setLoading(false);
    }
  }, [mode, uid, visibleDate]);

  useEffect(() => { load().catch(() => { setEvents([]); setLoading(false); }); }, [load]);
  const refresh = useCallback(async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }, [load]);
  const grouped = useMemo(() => events.reduce<Record<string, EventItem[]>>((result, item) => {
    const key = dateKey(item.startAt);
    (result[key] ??= []).push(item);
    return result;
  }, {}), [events]);
  const selectedEvents = grouped[selectedDate] ?? [];
  // Only offer moves that are genuinely later than the slot being moved -- an
  // option that lands before the current start would not be a postpone.
  const postponeChoices = useMemo(() => {
    if (!postponing) return [];
    const from = toDate(postponing.startAt);
    return POSTPONE_OPTIONS
      .map((option) => ({hint: option.hint, label: option.label, startAt: option.shift(from)}))
      .filter((option) => option.startAt.getTime() > from.getTime());
  }, [postponing]);
  const dayStrip = useMemo(() => [-3, -2, -1, 0, 1, 2, 3].map((offset) => offsetDate(selectedDate, offset)), [selectedDate]);
  const yearMonths = useMemo(() => {
    const year = Number(visibleDate.slice(0, 4));
    return Array.from({length: 12}, (_, month) => ({month, days: miniMonthDays(year, month)}));
  }, [visibleDate]);

  const anchorTo = (value: string) => { setMonthAnchor(value); setReanchor((count) => count + 1); };
  const openDay = (value: string, showDetails = false) => {
    setSelectedDate(value);
    setVisibleDate(value);
    anchorTo(value);
    if (showDetails) setDetailsOpen(true);
  };
  useEffect(() => {
    if (!requestedDate) return;
    setMode('day');
    setSelectedDate(requestedDate);
    setVisibleDate(requestedDate);
    setMonthAnchor(requestedDate);
    setReanchor((count) => count + 1);
  }, [requestedDate]);
  // Swipe down on the day sheet's header to dismiss it. The handle drawn there
  // always promised this, but a plain Modal has no such gesture, so the pill
  // did nothing and only the X closed the sheet.
  //
  // Only the header takes the drag, not the whole sheet: below it is the event
  // list, a ScrollView, and a responder over it would fight every scroll.
  // A drag claims the responder only once it is clearly downward, so a tap on
  // the header still reaches whatever is under it.
  const [sheetDrag] = useState(() => new RNAnimated.Value(0));
  const sheetPan = useMemo(() => {
    const native = Platform.OS !== 'web';
    const settle = () => RNAnimated.spring(sheetDrag, {bounciness: 4, toValue: 0, useNativeDriver: native}).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_, gesture) => sheetDrag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        // Far enough, or flicked: finish the slide, then close. Otherwise the
        // sheet springs back to where it was.
        if (gesture.dy > 110 || gesture.vy > 0.85) {
          RNAnimated.timing(sheetDrag, {duration: 170, toValue: 640, useNativeDriver: native}).start(() => {
            setDetailsOpen(false);
            sheetDrag.setValue(0);
          });
        } else {
          settle();
        }
      },
      onPanResponderTerminate: settle,
    });
  }, [sheetDrag]);
  const navigate = (direction: number) => {
    const next = shift(visibleDate, mode, direction);
    setVisibleDate(next);
    setSelectedDate(next);
    anchorTo(next);
  };
  const goToday = () => { setSelectedDate(today); setVisibleDate(today); anchorTo(today); };

  /**
   * Puts the list back on its anchor month once the list has actually been
   * laid out.
   *
   * `CalendarList` positions itself with `initialScrollIndex` plus a
   * `getItemLayout` that is memoised with an empty dependency list, and it
   * applies both before the row has finished laying out. On WebKit that lands
   * short by a varying number of months -- cold loads came up on index 12, 4
   * and 14 of a 49-month window instead of the middle -- and because the list
   * then reports whatever month it stopped on, the header agreed with it and
   * the whole screen showed the wrong month. Re-asserting on layout costs
   * nothing when the list is already in the right place, because the library
   * skips a scroll of zero distance.
   */
  const anchorMonth = `${monthAnchor.slice(0, 7)}-01`;
  const settleOnAnchor = useCallback(() => {
    monthList.current?.scrollToMonth?.(anchorMonth);
  }, [anchorMonth]);

  /**
   * Pushes the list onto its anchor until the layout stops moving under it.
   *
   * One assertion is not enough and the library's own callback cannot drive
   * the retries: when a nudge lands on the same wrong month it reports
   * nothing, so a callback-driven loop stalls exactly where it needs to keep
   * going. A short timer does not care. Every attempt aims at the same fixed
   * offset, so once the list is right the repeats are no-ops -- the library
   * skips a scroll of zero distance -- and a drag ends it immediately so it
   * can never fight the user.
   */
  useEffect(() => {
    if (mode !== 'month') return undefined;
    monthDragged.current = false;
    settling.current = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const push = () => {
      // Runs for a few seconds because the list can still be laying out well
      // after mount on a slow load, and stopping early is exactly when it gets
      // left on the wrong month. A real drag ends it at once.
      if (monthDragged.current || attempts >= 24) {
        settling.current = false;
        return;
      }
      attempts += 1;
      settleOnAnchor();
      timer = setTimeout(push, 150);
    };
    push();
    return () => { clearTimeout(timer); settling.current = false; };
  }, [mode, reanchor, settleOnAnchor]);

  /**
   * Follows the list only once the user has actually dragged it.
   *
   * `CalendarList` reports `viewableItems[0]`, which during mount is not the
   * centred page at all -- it fires repeatedly with months scattered either
   * side, and whichever arrived last used to win, which is how the screen
   * ended up captioned two years off. Until a drag there is nothing to learn
   * from those reports: the month on display is the one the list was anchored
   * to. After a drag the user has moved it somewhere only the list knows, so
   * its reports are taken as they come.
   */
  const onMonthsVisible = (months: {dateString?: string}[]) => {
    const next = months[0]?.dateString;
    if (!next || !monthDragged.current) return;
    setVisibleDate((previous) => next.slice(0, 7) === previous.slice(0, 7) ? previous : next);
  };

  // A course row deletes the whole series, a one-off row deletes just itself,
  // so the confirmation has to say which. `deleting` holds the pending row and
  // `ConfirmDialog` renders from it; this used to be `Alert.alert`, which is an
  // empty function on react-native-web and so never ran the delete at all.
  const seriesKey = (event: EventItem) => typeof event.courseCode === 'string' && event.courseCode.trim()
    ? event.courseCode.replace(/\s+/g, '').toUpperCase()
    : eventTitle(event);
  const deleteEvent = useCallback((event: EventItem) => {
    if (!event.id || !event.entityType) return;
    setDeleting(event);
  }, []);

  const confirmDelete = useCallback(async () => {
    const event = deleting;
    if (!event?.id) return;
    setDeleting(null);
    const failed = () => { load().catch(() => undefined); setDeleteError(true); };
    if (event.entityType === 'schedule') {
      const courseCode = seriesKey(event);
      const seriesId = typeof event.seriesId === 'string' && event.seriesId.trim() ? event.seriesId : undefined;
      setEvents((current) => current.filter((item) => seriesId ? item.seriesId !== seriesId : seriesKey(item) !== courseCode));
      await deleteCourseSeries(uid, courseCode, seriesId).catch(failed);
      return;
    }
    setEvents((current) => current.filter((item) => item.id !== event.id));
    await activities.remove(uid, event.id as string).catch(failed);
  }, [deleting, load, uid]);

  const completeEvent = useCallback(async (event: EventItem) => {
    if (!event.id || event.entityType !== 'activity' || completingId) return;
    const id = event.id;
    setCompletingId(id);
    setEvents((current) => current.filter((item) => item.id !== id));
    try {
      await activities.update(uid, id, {status: 'completed'});
      // Adaptive scheduling learns which hours this user actually finishes work
      // in. Without this call `completionRate` stays at 0 forever and every
      // suggestion is generated from defaults instead of from the user.
      void recordTaskCompleted(id, {scheduledEndAt: toDate(event.endAt), scheduledStartAt: toDate(event.startAt)});
    } catch (error) {
      await load().catch(() => undefined);
      showToast('ทำเครื่องหมายไม่สำเร็จ', error instanceof Error ? error.message : 'กรุณาลองใหม่อีกครั้ง');
    } finally {
      setCompletingId('');
    }
  }, [completingId, load, uid]);

  const postponeEvent = useCallback(async (event: EventItem, toStart: Date) => {
    const id = event.id;
    if (!id || event.entityType !== 'activity' || postponeBusy) return;
    const fromStart = toDate(event.startAt);
    const durationMs = Math.max(900000, toDate(event.endAt).getTime() - fromStart.getTime());
    setPostponeBusy(true);
    try {
      await activities.update(uid, id, {
        endAt: Timestamp.fromDate(new Date(toStart.getTime() + durationMs)),
        startAt: Timestamp.fromDate(toStart),
      });
      // Recorded only after the move commits, so a rejected write never teaches
      // the engine a postponement that did not happen.
      void recordTaskPostponed(id, fromStart, toStart);
      setPostponing(null);
      await load();
    } catch (error) {
      showToast('เลื่อนไม่สำเร็จ', error instanceof Error ? error.message : 'กรุณาลองใหม่อีกครั้ง');
    } finally {
      setPostponeBusy(false);
    }
  }, [load, postponeBusy, uid]);

  const DayCell = ({date, state}: {date?: DateData; state?: string}) => {
    if (!date) return null;
    const key = date.dateString;
    const selected = key === selectedDate;
    const isToday = key === today;
    const dayEvents = grouped[key] ?? [];
    return (
      <Touchable accessibilityLabel={`${formatLongDate(key)} มี ${dayEvents.length} รายการ`} accessibilityRole="button" accessibilityState={{selected}} onPress={() => openDay(key)} style={({pressed}) => [styles.dayCell, pressed && styles.pressed]}>
        <View style={[styles.dayCircle, isToday && styles.todayCircle, selected && !isToday && styles.selectedCircle]}>
          <Text style={[styles.dayNumber, state === 'disabled' && styles.disabledDay, isToday && styles.todayNumber, selected && !isToday && styles.selectedNumber]}>{date.day}</Text>
        </View>
        <View style={styles.dots}>{dayEvents.slice(0, 3).map((event, index) => <View key={`${String(event.id)}-${index}`} style={[styles.dot, {backgroundColor: typeof event.color === 'string' ? event.color : index % 2 ? C.blue : C.green}]} />)}</View>
      </Touchable>
    );
  };

  const calendarTheme = {
    calendarBackground: 'transparent',
    backgroundColor: 'transparent',
    monthTextColor: C.label,
    textMonthFontFamily: F.b,
    textSectionTitleColor: C.secondary,
    textDayHeaderFontFamily: F.s,
    textDayHeaderFontSize: 10,
    arrowColor: C.accent,
  };

  const renderCalendarBody = () => {
    if (mode === 'month') return (
      <CalendarList
        calendarHeight={340}
        calendarWidth={calendarWidth}
        /* Anchored to a month the user actually chose, never to wherever the
           list has scrolled. Passing the scrolled-to date back in made
           `current` change on every scroll, and the library re-scrolls
           whenever `current` changes -- on iOS Safari that fought momentum
           scrolling and the view never came to rest. */
        current={anchorMonth}
        dayComponent={DayCell}
        firstDay={1}
        futureScrollRange={24}
        horizontal
        /* Remounted when the anchor month or the width changes, never from
           the scroll callback. The width matters because the library captures
           the page size into a `getItemLayout` memoised with an empty
           dependency list, so a width that settles after mount -- normal in a
           mobile browser, where the URL bar collapses -- would leave it
           measuring pages at the old size. */
        key={`${monthAnchor.slice(0, 7)}-${calendarWidth}`}
        onLayout={settleOnAnchor}
        ref={monthList}
        onScrollBeginDrag={() => { monthDragged.current = true; }}
        onVisibleMonthsChange={onMonthsVisible}
        pagingEnabled
        pastScrollRange={24}
        /* Deliberately not `staticHeader`: that header is absolutely
           positioned and only covers each page's own header when the theme
           has an opaque background. This calendar is transparent by design,
           so both were visible -- two month labels and two rows of weekday
           names. One header per page instead, with its month text dropped
           because the screen prints the Buddhist-era one just above; the
           weekday row it renders is the one the user sees. */
        renderHeader={() => null}
        showScrollIndicator={false}
        theme={calendarTheme}
      />
    );
    if (mode === 'week') return (
      <CalendarProvider date={visibleDate} onDateChanged={(value) => openDay(value)}>
        <WeekCalendar allowShadow={false} calendarWidth={calendarWidth} current={visibleDate} dayComponent={DayCell} firstDay={1} markedDates={{}} theme={calendarTheme} />
      </CalendarProvider>
    );
    if (mode === 'year') return (
      <View style={styles.yearGrid}>{yearMonths.map(({month, days}) => (
        <Touchable key={month} onPress={() => { const next = `${visibleDate.slice(0, 4)}-${pad(month + 1)}-01`; setSelectedDate(next); setVisibleDate(next); anchorTo(next); setMode('month'); }} style={styles.miniMonth}>
          <Text style={styles.miniMonthTitle}>{THAI_MONTH_NAMES[month]}</Text>
          <View style={styles.miniDays}>{days.map((key, index) => key ? (
            <View key={key} style={[styles.miniDay, key === today && styles.miniToday]}><Text style={[styles.miniDayText, key === today && styles.miniTodayText]}>{Number(key.slice(-2))}</Text>{grouped[key]?.length ? <View style={styles.miniDot} /> : null}</View>
          ) : <View key={`empty-${month}-${index}`} style={styles.miniDay} />)}</View>
        </Touchable>
      ))}</View>
    );
    return (
      <View style={styles.dayView}>
        <View style={styles.dayStrip}>{dayStrip.map((key) => {
          const active = key === selectedDate;
          const isToday = key === today;
          return (
            <Touchable key={key} onPress={() => openDay(key)} style={({pressed}) => [styles.dayStripItem, pressed && styles.pressed]}>
              <Text style={[styles.dayStripName, isToday && styles.redText]}>{shortDay(key)}</Text>
              <View style={[styles.dayStripCircle, active && styles.dayStripActive, isToday && styles.todayCircle]}><Text style={[styles.dayStripNumber, active && styles.dayStripNumberActive, isToday && styles.todayNumber]}>{Number(key.slice(-2))}</Text></View>
              {grouped[key]?.length ? <View style={[styles.dayStripDot, active && styles.dayStripDotActive]} /> : null}
            </Touchable>
          );
        })}</View>
        <DayTimeline date={selectedDate} events={selectedEvents} isToday={selectedDate === today} onOpen={() => setDetailsOpen(true)} />
      </View>
    );
  };

  const periodTitle = mode === 'year' ? `พ.ศ. ${Number(visibleDate.slice(0, 4)) + 543}` : mode === 'month' ? formatMonth(visibleDate) : formatLongDate(visibleDate);

  return (
    <ResponsiveSafeArea style={styles.safe}>
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />} showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            <View>
              <Touchable accessibilityLabel="ไปยังวันนี้" accessibilityRole="button" onPress={goToday}><Text style={styles.todayLink}>วันนี้</Text></Touchable>
              <Text style={styles.largeTitle}>ปฏิทิน</Text>
            </View>
            <View style={styles.topActions}>
              <Touchable accessibilityLabel="นำเข้าตารางเรียน" onLayout={importScheduleOnLayout} onPress={() => onNavigate('smartlife_scan_schedule')} ref={importScheduleRef} style={styles.circleButton}><MaterialIcon color={C.accent} name="document_scanner" size={22} /></Touchable>
              <Touchable accessibilityLabel="เพิ่มรายการ" accessibilityRole="button" onPress={() => onNavigate('smartlife_add_activity')} style={styles.circleButton}><MaterialIcon color={C.accent} name="add" size={24} /></Touchable>
            </View>
          </View>
          {planner ? <View accessibilityRole="tablist" style={styles.plannerTabs}>{([['calendar', 'ตาราง'], ['notes', 'โน้ต'], ['adaptive', 'Adaptive']] as [PlannerTab, string][]).map(([key, label]) => <Touchable accessibilityRole="tab" accessibilityState={{selected: planner.activeTab === key}} key={key} onPress={() => planner.onTabChange(key)} style={[styles.plannerTab, planner.activeTab === key && styles.plannerTabActive]}><Text style={[styles.plannerTabText, planner.activeTab === key && styles.plannerTabTextActive]}>{label}</Text></Touchable>)}</View> : null}

          <GoogleCalendarSyncCard onSynced={load} uid={uid} />
          <AiActivityRecommendationCard onNavigate={onNavigate} uid={uid} />

          <View accessibilityRole="tablist" style={styles.segment}>{(['day', 'week', 'month', 'year'] as ViewMode[]).map((item) => (
            <Touchable accessibilityRole="tab" accessibilityState={{selected: mode === item}} key={item} onPress={() => { setMode(item); setVisibleDate(selectedDate); anchorTo(selectedDate); }} style={[styles.segmentItem, mode === item && styles.segmentActive]}>
              <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>{item === 'day' ? 'วัน' : item === 'week' ? 'สัปดาห์' : item === 'month' ? 'เดือน' : 'ปี'}</Text>
            </Touchable>
          ))}</View>

          <View style={styles.periodHeader}>
            <Touchable accessibilityLabel="ช่วงก่อนหน้า" onPress={() => navigate(-1)} style={styles.chevron}><MaterialIcon color={C.accent} name="chevron_left" size={26} /></Touchable>
            <Text numberOfLines={1} style={styles.periodTitle}>{periodTitle}</Text>
            <Touchable accessibilityLabel="ช่วงถัดไป" onPress={() => navigate(1)} style={styles.chevron}><MaterialIcon color={C.accent} name="chevron_right" size={26} /></Touchable>
          </View>

          <View style={styles.calendarCard}>
            {renderCalendarBody()}
            {loading ? <View style={styles.calendarLoading}><ActivityIndicator color={C.accent} /><Text style={styles.loadingText}>กำลังโหลดปฏิทิน…</Text></View> : null}
          </View>

          {mode !== 'day' ? <View style={styles.agendaSection}><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>{selectedDate === today ? 'วันนี้' : formatLongDate(selectedDate)}</Text><Text style={styles.sectionSub}>{selectedEvents.length ? `${selectedEvents.length} รายการ` : 'ไม่มีกิจกรรม'}</Text></View><Touchable onPress={() => setDetailsOpen(true)}><Text style={styles.seeAll}>ดูทั้งหมด</Text></Touchable></View><AgendaList completingId={completingId} events={selectedEvents} onComplete={(event) => void completeEvent(event)} onDelete={deleteEvent} onOpen={() => setDetailsOpen(true)} onPostpone={setPostponing} /></View> : null}
        </ScrollView>


        <UserTabBar active={planner ? 'smartlife_planner' : 'smartlife_calendar_day'} onNavigate={onNavigate} />

        <Modal animationType="slide" onRequestClose={() => setDetailsOpen(false)} transparent visible={detailsOpen}>
          <View style={styles.overlay}>
            {/* With the X gone, the dimmed space above the sheet closes it as
                well. A desktop browser has no back button and a mouse user may
                never think to drag, so the sheet must not become a dead end. */}
            <Pressable accessibilityLabel="ปิดรายละเอียดวัน" onPress={() => setDetailsOpen(false)} style={StyleSheet.absoluteFill} />
            <RNAnimated.View style={[styles.sheet, {transform: [{translateY: sheetDrag}]}]}>
              <View {...sheetPan.panHandlers} accessibilityHint="ปัดลงเพื่อปิด">
                <View style={styles.handle} />
                <View style={styles.sheetHead}><View><Text style={styles.sheetTitle}>{formatLongDate(selectedDate)}</Text><Text style={styles.sheetSub}>{selectedEvents.length} รายการ</Text></View></View>
              </View>
              <ScrollView style={styles.sheetScroll}>{selectedEvents.length ? selectedEvents.map((event, index) => <EventRow completing={completingId === event.id} event={event} key={String(event.id ?? index)} onComplete={event.entityType === 'activity' ? () => void completeEvent(event) : undefined} onDelete={() => deleteEvent(event)} onPostpone={event.entityType === 'activity' ? () => setPostponing(event) : undefined} />) : <EmptyAgenda />}</ScrollView>
              <Touchable onPress={() => { setDetailsOpen(false); onNavigate('smartlife_add_activity'); }} style={styles.sheetAdd}><MaterialIcon color="#fff" name="add" size={20} /><Text style={styles.sheetAddText}>เพิ่มกิจกรรม</Text></Touchable>
            </RNAnimated.View>
          </View>
        </Modal>

        <Modal animationType="slide" onRequestClose={() => setPostponing(null)} transparent visible={Boolean(postponing)}>
          <View style={styles.overlay}>
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.sheetHead}>
                <View style={styles.postponeHeadCopy}>
                  <Text numberOfLines={1} style={styles.sheetTitle}>เลื่อน {postponing ? eventTitle(postponing) : ''}</Text>
                  <Text style={styles.sheetSub}>{postponing ? `เวลาเดิม ${formatTime(postponing.startAt)} น.` : ''}</Text>
                </View>
                <Touchable onPress={() => setPostponing(null)} style={styles.close}><MaterialIcon color={C.secondary} name="close" size={20} /></Touchable>
              </View>
              <View style={styles.postponeList}>
                {postponeChoices.map((choice) => (
                  <Touchable
                    accessibilityRole="button"
                    disabled={postponeBusy}
                    key={choice.label}
                    onPress={() => { if (postponing) void postponeEvent(postponing, choice.startAt); }}
                    style={({pressed}) => [styles.postponeChoice, postponeBusy && styles.postponeChoiceDisabled, pressed && styles.pressed]}
                  >
                    <View style={styles.postponeChoiceCopy}>
                      <Text style={styles.postponeChoiceLabel}>{choice.label}</Text>
                      <Text style={styles.postponeChoiceHint}>{choice.hint} · {formatTime(choice.startAt)} น.</Text>
                    </View>
                    <MaterialIcon color={C.secondary} name="chevron_right" size={20} />
                  </Touchable>
                ))}
                {postponeChoices.length ? null : <Text style={styles.postponeEmpty}>ช่วงเวลาที่เลือกได้ผ่านไปแล้วทั้งหมด</Text>}
              </View>
              <Text style={styles.postponeNote}>ระบบจะจดจำว่าคุณเลื่อนงานประเภทนี้ไปช่วงไหน เพื่อเสนอเวลาที่ตรงกับคุณมากขึ้นในครั้งถัดไป</Text>
            </View>
          </View>
        </Modal>

        <ConfirmDialog
          confirmLabel={deleting?.entityType === 'schedule' ? 'ลบทั้งหมด' : 'ลบ'}
          message={deleting?.entityType === 'schedule'
            ? `ตารางทั้งหมดของ ${deleting ? seriesKey(deleting) : ''} จะถูกลบออก`
            : deleting ? eventTitle(deleting) : ''}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
          title={deleting?.entityType === 'schedule' ? 'ลบวิชานี้ทั้งหมดหรือไม่?' : 'ลบกิจกรรมนี้หรือไม่?'}
          visible={Boolean(deleting)}
        />
        <ConfirmDialog
          cancelLabel="ปิด"
          confirmLabel="ลองใหม่"
          icon="refresh"
          message="กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่"
          onCancel={() => setDeleteError(false)}
          onConfirm={() => { setDeleteError(false); load().catch(() => undefined); }}
          title="ลบไม่สำเร็จ"
          tone="neutral"
          visible={deleteError}
        />
      </View>
    </ResponsiveSafeArea>
  );
}

// `onDelete` is threaded through the same way `onComplete` and `onPostpone`
// already were. `EventRow` has always known how to draw the trash button; it
// simply was never handed a handler here, so deleting from the agenda meant
// opening the day sheet first to reach the identical row.
function AgendaList({completingId, events, onComplete, onDelete, onOpen, onPostpone}: {completingId: string; events: EventItem[]; onComplete: (event: EventItem) => void; onDelete: (event: EventItem) => void; onOpen: () => void; onPostpone: (event: EventItem) => void}) {
  if (!events.length) return <EmptyAgenda />;
  return <Animated.View layout={LinearTransition.duration(200)} style={styles.eventList}>{events.map((event, index) => <EventRow completing={completingId === event.id} event={event} key={String(event.id ?? index)} onComplete={event.entityType === 'activity' ? () => onComplete(event) : undefined} onDelete={() => onDelete(event)} onPostpone={event.entityType === 'activity' ? () => onPostpone(event) : undefined} onPress={onOpen} />)}</Animated.View>;
}

const HOUR_HEIGHT = 62;
const TIMELINE_HEIGHT = HOUR_HEIGHT * 24;
function timelineMinute(value: unknown) {
  const part = bangkokParts(toDate(value));
  const hour = Math.min(Number(part.hour) || 0, 23);
  return hour * 60 + (Number(part.minute) || 0);
}
function softEventColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}24` : '#e9efe6';
}
function DayTimeline({date, events, isToday, onOpen}: {date: string; events: EventItem[]; isToday: boolean; onOpen: () => void}) {
  const scrollRef = useRef<ScrollView>(null);
  const didScroll = useRef(false);
  const nowMinute = timelineMinute(new Date());
  const firstEventMinute = events.length ? Math.min(...events.map((event) => timelineMinute(event.startAt))) : 8 * 60;
  const initialMinute = isToday ? nowMinute : firstEventMinute;

  useEffect(() => { didScroll.current = false; }, [date, events.length]);
  const scrollToRelevantTime = () => {
    if (didScroll.current) return;
    didScroll.current = true;
    const y = Math.max(0, (initialMinute / 60) * HOUR_HEIGHT - HOUR_HEIGHT * 1.35);
    scrollRef.current?.scrollTo({animated: false, y});
  };

  return <View style={styles.timelineFrame}>
    <View style={styles.timelineHeader}><View><Text style={styles.timelineDate}>{isToday ? 'วันนี้' : formatLongDate(date)}</Text><Text style={styles.timelineHint}>เลื่อนเพื่อดูตารางตลอด 24 ชั่วโมง</Text></View><View style={styles.timelineCount}><Text style={styles.timelineCountText}>{events.length} รายการ</Text></View></View>
    <ScrollView contentContainerStyle={styles.timelineScrollContent} nestedScrollEnabled onContentSizeChange={scrollToRelevantTime} ref={scrollRef} showsVerticalScrollIndicator={false} style={styles.timelineScroll}>
      <View style={{height: TIMELINE_HEIGHT}}>
        {Array.from({length: 24}, (_, hour) => <View key={hour} style={[styles.hourRow, {top: hour * HOUR_HEIGHT}]}><Text style={styles.hourLabel}>{pad(hour)}:00</Text><View style={styles.hourLine} /></View>)}
        {events.map((event, index) => {
          const start = timelineMinute(event.startAt);
          const duration = Math.max(30, Math.min(24 * 60 - start, Math.round((toDate(event.endAt).getTime() - toDate(event.startAt).getTime()) / 60000)));
          const color = typeof event.color === 'string' ? event.color : event.entityType === 'schedule' ? C.green : C.blue;
          return <Touchable accessibilityLabel={`${eventTitle(event)} ${formatTime(event.startAt)} ถึง ${formatTime(event.endAt)}`} key={String(event.id ?? index)} onPress={onOpen} style={({pressed}) => [styles.timelineEvent, {backgroundColor: softEventColor(color), borderLeftColor: color, height: Math.max(42, duration / 60 * HOUR_HEIGHT - 3), top: start / 60 * HOUR_HEIGHT + 1}, pressed && styles.pressed]}>
            <Text numberOfLines={1} style={styles.timelineEventTitle}>{eventTitle(event)}</Text><Text numberOfLines={1} style={styles.timelineEventMeta}>{formatTime(event.startAt)}–{formatTime(event.endAt)}{event.location ? ` · ${String(event.location)}` : ''}</Text>
          </Touchable>;
        })}
        {isToday ? <View pointerEvents="none" style={[styles.nowLine, {top: nowMinute / 60 * HOUR_HEIGHT}]}><View style={styles.nowDot} /><Text style={styles.nowLabel}>{formatTime(new Date())}</Text><View style={styles.nowRule} /></View> : null}
      </View>
    </ScrollView>
  </View>;
}

function EventRow({completing = false, event, onComplete, onDelete, onPostpone, onPress}: {completing?: boolean; event: EventItem; onComplete?: () => void; onDelete?: () => void; onPostpone?: () => void; onPress?: () => void}) {
  const color = typeof event.color === 'string' ? event.color : event.entityType === 'schedule' ? C.green : C.blue;
  const priority = priorityInfo(event.priority);
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(200)}>
    <Touchable disabled={!onPress} onPress={onPress} style={({pressed}) => [styles.eventRow, pressed && styles.pressed]}>
      <View style={[styles.eventColor, {backgroundColor: color}]} />
      <View style={styles.eventTime}><Text style={styles.eventStart}>{formatTime(event.startAt)}</Text><Text style={styles.eventEnd}>{formatTime(event.endAt)}</Text></View>
      <View style={styles.eventCopy}><Text numberOfLines={1} style={styles.eventTitle}>{eventTitle(event)}</Text><View style={styles.eventMetaRow}><Text numberOfLines={1} style={styles.eventMeta}>{textEvent(event.location, textEvent(event.courseCode, textEvent(event.type, 'กิจกรรม')))}</Text>{priority ? <View style={[styles.priorityBadge, {backgroundColor: priority.backgroundColor}]}><Text style={[styles.priorityBadgeText, {color: priority.color}]}>{priority.label}</Text></View> : null}</View></View>
      <View style={styles.eventActions}>{onPostpone ? <Touchable accessibilityLabel={`เลื่อน ${eventTitle(event)}`} disabled={completing} onPress={(pressEvent) => { pressEvent.stopPropagation(); onPostpone(); }} style={styles.postponeEventButton}><MaterialIcon color={C.secondary} name="schedule" size={15} /><Text style={styles.postponeEventText}>เลื่อน</Text></Touchable> : null}{onComplete ? <Touchable accessibilityLabel={`ทำ ${eventTitle(event)} ให้เสร็จ`} disabled={completing} onPress={(pressEvent) => { pressEvent.stopPropagation(); onComplete(); }} style={styles.completeEventButton}>{completing ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={16} />}<Text style={styles.completeEventText}>เสร็จ</Text></Touchable> : null}{onDelete ? <Touchable accessibilityLabel={`ลบ ${eventTitle(event)}`} onPress={(pressEvent) => { pressEvent.stopPropagation(); onDelete(); }} style={styles.deleteButton}><MaterialIcon color={C.accent} name="delete_outline" size={20} /></Touchable> : !onComplete ? <MaterialIcon color={C.tertiary} name="chevron_right" size={20} /> : null}</View>
    </Touchable>
    </Animated.View>
  );
}

function EmptyAgenda() {
  return <View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcon color={C.tertiary} name="event_available" size={28} /></View><Text style={styles.emptyTitle}>ไม่มีกิจกรรม</Text><Text style={styles.emptySub}>เวลาว่างของคุณจะแสดงอยู่ตรงนี้</Text></View>;
}

const styles = StyleSheet.create({
  safe: {backgroundColor: C.background, flex: 1},
  screen: {backgroundColor: C.background, flex: 1},
  content: {alignSelf: 'center', gap: 12, maxWidth: 1200, paddingBottom: 28, paddingHorizontal: 16, paddingTop: 8, width: '100%'},
  topBar: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  todayLink: {color: C.accent, fontFamily: F.b, fontSize: 12},
  topActions: {flexDirection: 'row', gap: 8},
  circleButton: {alignItems: 'center', backgroundColor: C.card, borderRadius: 22, height: 44, justifyContent: 'center', width: 44},
  largeTitle: {color: C.label, fontFamily: F.x, fontSize: 24},
  plannerTabs: {backgroundColor: '#e3e3e8', borderRadius: 16, flexDirection: 'row', padding: 4},
  plannerTab: {alignItems: 'center', borderRadius: 12, flex: 1, paddingVertical: 9},
  plannerTabActive: {backgroundColor: C.card, boxShadow: '0 1px 3px rgba(0,0,0,.16)'},
  plannerTabText: {color: C.secondary, fontFamily: F.m, fontSize: 12},
  plannerTabTextActive: {color: C.label, fontFamily: F.s},
  segment: {backgroundColor: '#e3e3e8', borderRadius: 9, flexDirection: 'row', padding: 2},
  segmentItem: {alignItems: 'center', borderRadius: 7, flex: 1, justifyContent: 'center', minHeight: 32},
  segmentActive: {backgroundColor: C.card, boxShadow: '0 1px 3px rgba(0,0,0,.18)'},
  segmentText: {color: C.secondary, fontFamily: F.m, fontSize: 12},
  segmentTextActive: {color: C.label, fontFamily: F.s},
  periodHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  periodTitle: {color: C.label, flex: 1, fontFamily: F.b, fontSize: 17, textAlign: 'center'},
  chevron: {alignItems: 'center', height: 36, justifyContent: 'center', width: 40},
  calendarCard: {backgroundColor: C.card, borderRadius: 18, minHeight: 120, overflow: 'hidden'},
  calendarLoading: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.86)', gap: 8, justifyContent: 'center', ...StyleSheet.absoluteFill},
  loadingText: {color: C.secondary, fontFamily: F.r, fontSize: 12},
  dayCell: {alignItems: 'center', height: 43, justifyContent: 'flex-start', width: 38},
  dayCircle: {alignItems: 'center', borderRadius: 15, height: 30, justifyContent: 'center', width: 30},
  todayCircle: {backgroundColor: C.accent},
  selectedCircle: {backgroundColor: '#e5e5ea'},
  dayNumber: {color: C.label, fontFamily: F.m, fontSize: 12},
  todayNumber: {color: '#fff', fontFamily: F.b},
  selectedNumber: {color: C.label, fontFamily: F.b},
  disabledDay: {color: C.tertiary},
  dots: {flexDirection: 'row', gap: 2, marginTop: 3},
  dot: {borderRadius: 2, height: 4, width: 4},
  dayView: {paddingTop: 4},
  dayStrip: {borderBottomColor: C.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 8},
  dayStripItem: {alignItems: 'center', flex: 1, minHeight: 62},
  dayStripName: {color: C.secondary, fontFamily: F.m, fontSize: 12},
  redText: {color: C.accent},
  dayStripCircle: {alignItems: 'center', borderRadius: 16, height: 32, justifyContent: 'center', marginTop: 3, width: 32},
  dayStripActive: {backgroundColor: '#e5e5ea'},
  dayStripNumber: {color: C.label, fontFamily: F.s, fontSize: 13},
  dayStripNumberActive: {fontFamily: F.b},
  dayStripDot: {backgroundColor: C.blue, borderRadius: 2, height: 4, marginTop: 3, width: 4},
  dayStripDotActive: {backgroundColor: C.accent},
  timelineFrame: {backgroundColor: '#fbfcf9'},
  timelineHeader: {alignItems: 'center', borderBottomColor: C.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10},
  timelineDate: {color: C.label, fontFamily: F.b, fontSize: 12},
  timelineHint: {color: C.secondary, fontFamily: F.r, fontSize: 12, marginTop: 2},
  timelineCount: {backgroundColor: C.accentSoft, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5},
  timelineCountText: {color: C.accent, fontFamily: F.b, fontSize: 12},
  timelineScroll: {height: 470},
  timelineScrollContent: {paddingBottom: 2},
  hourRow: {alignItems: 'flex-start', flexDirection: 'row', height: HOUR_HEIGHT, left: 0, position: 'absolute', right: 0},
  hourLabel: {color: C.tertiary, fontFamily: F.m, fontSize: 12, paddingRight: 8, textAlign: 'right', transform: [{translateY: -6}], width: 54},
  hourLine: {borderTopColor: '#e5e9e2', borderTopWidth: StyleSheet.hairlineWidth, flex: 1},
  timelineEvent: {borderLeftWidth: 4, borderRadius: 9, left: 60, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 6, position: 'absolute', right: 10, zIndex: 2},
  timelineEventTitle: {color: C.label, fontFamily: F.b, fontSize: 12},
  timelineEventMeta: {color: C.secondary, fontFamily: F.m, fontSize: 12, marginTop: 2},
  nowLine: {alignItems: 'center', flexDirection: 'row', left: 43, position: 'absolute', right: 0, zIndex: 5},
  nowDot: {backgroundColor: C.accent, borderRadius: 5, height: 9, width: 9},
  nowLabel: {backgroundColor: C.accent, borderRadius: 8, color: '#fff', fontFamily: F.b, fontSize: 12, marginLeft: -2, overflow: 'hidden', paddingHorizontal: 5, paddingVertical: 2},
  nowRule: {backgroundColor: C.accent, flex: 1, height: 2},
  yearGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', padding: 12},
  miniMonth: {paddingVertical: 5, width: '47%'},
  miniMonthTitle: {color: C.accent, fontFamily: F.b, fontSize: 12, marginBottom: 6},
  miniDays: {flexDirection: 'row', flexWrap: 'wrap'},
  miniDay: {alignItems: 'center', height: 21, justifyContent: 'center', position: 'relative', width: '14.285%'},
  miniDayText: {color: C.label, fontFamily: F.m, fontSize: 12},
  miniToday: {backgroundColor: C.accent, borderRadius: 10},
  miniTodayText: {color: '#fff', fontFamily: F.b},
  miniDot: {backgroundColor: C.blue, borderRadius: 2, bottom: 1, height: 3, position: 'absolute', width: 3},
  agendaSection: {gap: 8},
  sectionHeader: {alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2},
  sectionTitle: {color: C.label, fontFamily: F.b, fontSize: 15},
  sectionSub: {color: C.secondary, fontFamily: F.r, fontSize: 12, marginTop: 1},
  seeAll: {color: C.accent, fontFamily: F.s, fontSize: 12},
  eventList: {backgroundColor: C.card, borderRadius: 16, overflow: 'hidden'},
  eventRow: {alignItems: 'center', borderBottomColor: C.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 70, paddingHorizontal: 12, paddingVertical: 10},
  eventColor: {alignSelf: 'stretch', borderRadius: 2, marginRight: 10, width: 4},
  eventTime: {alignItems: 'flex-end', marginRight: 12, width: 48},
  eventStart: {color: C.label, fontFamily: F.s, fontSize: 12},
  eventEnd: {color: C.secondary, fontFamily: F.r, fontSize: 12, marginTop: 2},
  eventCopy: {flex: 1},
  eventActions: {alignItems: 'center', flexDirection: 'row', gap: 5},
  completeEventButton: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 11, flexDirection: 'row', gap: 3, minHeight: 34, paddingHorizontal: 9},
  completeEventText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  eventTitle: {color: C.label, fontFamily: F.s, fontSize: 12},
  eventMeta: {color: C.secondary, flexShrink: 1, fontFamily: F.r, fontSize: 12},
  eventMetaRow: {alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 3},
  priorityBadge: {borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2},
  priorityBadgeText: {fontFamily: F.b, fontSize: 12},
  empty: {alignItems: 'center', backgroundColor: C.card, gap: 4, justifyContent: 'center', minHeight: 150, padding: 22},
  emptyIcon: {alignItems: 'center', backgroundColor: C.background, borderRadius: 24, height: 48, justifyContent: 'center', width: 48},
  emptyTitle: {color: C.label, fontFamily: F.s, fontSize: 12, marginTop: 4},
  emptySub: {color: C.secondary, fontFamily: F.r, fontSize: 12},
  overlay: {backgroundColor: 'rgba(0,0,0,.25)', flex: 1, justifyContent: 'flex-end'},
  sheet: {backgroundColor: C.background, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '78%', minHeight: 340, padding: 16},
  handle: {alignSelf: 'center', backgroundColor: '#c7c7cc', borderRadius: 3, height: 5, marginBottom: 16, width: 36},
  sheetHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12},
  sheetTitle: {color: C.label, fontFamily: F.b, fontSize: 16},
  sheetSub: {color: C.secondary, fontFamily: F.r, fontSize: 12, marginTop: 2},
  close: {alignItems: 'center', backgroundColor: '#e5e5ea', borderRadius: 17, height: 34, justifyContent: 'center', width: 34},
  sheetScroll: {marginBottom: 12},
  deleteButton: {alignItems: 'center', height: 36, justifyContent: 'center', width: 36},
  sheetAdd: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 14, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 48},
  sheetAddText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  postponeChoice: {alignItems: 'center', backgroundColor: '#f6f8f4', borderRadius: 14, flexDirection: 'row', gap: 10, minHeight: 58, paddingHorizontal: 13},
  postponeChoiceCopy: {flex: 1, minWidth: 0},
  postponeChoiceDisabled: {opacity: .55},
  postponeChoiceHint: {color: C.tertiary, fontFamily: F.s, fontSize: 12, marginTop: 2},
  postponeChoiceLabel: {color: C.label, fontFamily: F.b, fontSize: 13},
  postponeEmpty: {color: C.tertiary, fontFamily: F.s, fontSize: 12, paddingVertical: 12, textAlign: 'center'},
  postponeEventButton: {alignItems: 'center', backgroundColor: '#eef2ea', borderRadius: 11, flexDirection: 'row', gap: 3, minHeight: 30, paddingHorizontal: 9},
  postponeEventText: {color: C.secondary, fontFamily: F.b, fontSize: 12},
  postponeHeadCopy: {flex: 1, minWidth: 0, paddingRight: 10},
  postponeList: {gap: 8, marginTop: 12},
  postponeNote: {color: C.tertiary, fontFamily: F.s, fontSize: 12, lineHeight: 18, marginTop: 14},
  pressed: {opacity: .62},
});
