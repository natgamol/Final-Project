import {useCallback, useMemo, useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';
import {Calendar} from 'react-native-calendars';

import {
  dayKeyFromMillis,
  groupEventsByDay,
  monthKeyFromMillis,
  monthRange,
  shiftMonth,
  summarizeActivities,
  type AdminEventInput,
} from '@/admin/analytics';
import {registerThaiCalendarLocale} from '@/lib/calendar-locale';
import {adminUserCalendar} from '@/services/admin-user-data';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  AdminCard,
  C,
  Empty,
  ErrorBlock,
  F,
  LoadingBlock,
  SectionHead,
  SmallButton,
  StatTile,
  Tag,
  dateTimeFromMillis,
  monthLabel,
  percent,
  styles as ui,
  timeFromMillis,
} from '../admin-ui';
import {useAdminWorkspace} from '../admin-workspace';
import {useAsyncData} from '../use-async-data';
import UserPicker, {useSelectedUser, userLabel} from '../user-picker';

registerThaiCalendarLocale();

const STATUS_LABELS: Record<string, [string, string]> = {
  cancelled: ['ยกเลิก', C.red],
  completed: ['เสร็จแล้ว', '#5a8d5d'],
  'in-progress': ['กำลังทำ', '#6572b1'],
  planned: ['วางแผนไว้', C.amber],
};

const TYPE_LABELS: Record<string, string> = {
  activity: 'กิจกรรม',
  appointment: 'นัดหมาย',
  schedule: 'คาบเรียน',
  task: 'งาน',
};

function eventColor(event: AdminEventInput) {
  if (event.entity === 'schedule') return '#6572b1';
  const status = (event.status ?? '').toLowerCase();
  if (status === 'completed') return '#5a8d5d';
  if (status === 'cancelled') return C.red;
  return C.sage;
}

/**
 * Per-user calendar for administrators.
 *
 * The selected month lives in the shared workspace store, not in this
 * component, so switching users keeps the admin on the same month instead of
 * snapping back to today.
 */
export default function AdminCalendarView() {
  const {monthKey, selectedUid, setMonthKey} = useAdminWorkspace();
  const selected = useSelectedUser();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminEventInput | null>(null);

  const {from, to} = useMemo(() => monthRange(monthKey), [monthKey]);
  const load = useCallback(
    () => adminUserCalendar(selectedUid as string, from, to),
    [from, selectedUid, to],
  );
  const {data, error, loading, reload} = useAsyncData(
    `calendar|${selectedUid ?? ''}|${monthKey}`,
    load,
    Boolean(selectedUid),
  );

  const events = useMemo(() => data ?? [], [data]);
  const byDay = useMemo(() => groupEventsByDay(events), [events]);
  const summary = useMemo(() => summarizeActivities(events), [events]);

  const marked = useMemo(() => {
    const result: Record<string, {dots: {color: string; key: string}[]; selected?: boolean; selectedColor?: string}> = {};
    Object.entries(byDay).forEach(([day, list]) => {
      result[day] = {
        dots: list.slice(0, 4).map((event, index) => ({color: eventColor(event), key: `${event.id}-${index}`})),
      };
    });
    if (selectedDay) {
      result[selectedDay] = {...(result[selectedDay] ?? {dots: []}), selected: true, selectedColor: C.pine};
    }
    return result;
  }, [byDay, selectedDay]);

  const dayEvents = selectedDay ? byDay[selectedDay] ?? [] : [];

  const goToToday = useCallback(() => {
    const today = Date.now();
    setMonthKey(monthKeyFromMillis(today));
    setSelectedDay(dayKeyFromMillis(today));
  }, [setMonthKey]);

  return (
    <>
      <LinearGradient colors={['#4d7049', '#789a75']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={ui.insight}>
        <MaterialIcon color="#fff" name="calendar_month" size={29} />
        <View style={{flex: 1}}>
          <Text style={ui.insightTitle}>ปฏิทินรายผู้ใช้</Text>
          <Text style={ui.insightSub}>กิจกรรม งาน นัดหมาย และตารางเรียนของผู้ใช้แต่ละคน</Text>
        </View>
      </LinearGradient>

      <UserPicker subtitle="เลือกผู้ใช้เพื่อดูปฏิทินกิจกรรมของคนนั้น เดือนที่เลือกจะคงอยู่เมื่อสลับผู้ใช้" />

      {!selectedUid ? (
        <AdminCard><Empty icon="event" label="เลือกผู้ใช้ด้านบนเพื่อดูปฏิทิน" /></AdminCard>
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
                <Text style={local.monthSub}>ปฏิทินของ {userLabel(selected)}</Text>
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
              <SmallButton icon="today" label="ไปเดือนปัจจุบัน" onPress={goToToday} tone="green" />
              <SmallButton icon="refresh" label="รีเฟรช" loading={loading} onPress={reload} tone="purple" />
            </View>

            <Calendar
              current={`${monthKey}-01`}
              key={monthKey}
              markedDates={marked}
              markingType="multi-dot"
              onDayPress={(day: {dateString: string}) => setSelectedDay(day.dateString)}
              onMonthChange={(month: {dateString: string}) => setMonthKey(month.dateString.slice(0, 7))}
              /* The locale registers Thai month names but not the era, so the
                 library printed "กันยายน 2026" directly under this screen's own
                 "กันยายน 2569" header. Reuse `monthLabel` so both agree on the
                 Buddhist year the rest of the app shows. */
              renderHeader={(headerDate: Date | {toString(): string}) => {
                const value = new Date(headerDate as Date);
                const key = Number.isNaN(value.getTime())
                  ? monthKey
                  : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
                return <Text style={local.calendarHeader}>{monthLabel(key)}</Text>;
              }}
              theme={{
                arrowColor: C.pine,
                monthTextColor: C.pine,
                selectedDayBackgroundColor: C.pine,
                textDayFontFamily: F.m,
                textDayHeaderFontFamily: F.s,
                textMonthFontFamily: F.b,
                todayTextColor: C.sage,
              }}
            />
          </AdminCard>

          {error ? <ErrorBlock message={error} onRetry={reload} /> : null}
          {loading && !events.length ? <LoadingBlock label="กำลังโหลดปฏิทินของผู้ใช้" /> : null}

          {!error && !loading ? (
            <AdminCard>
              <SectionHead meta={`${summary.total} รายการ`} title="สรุปทั้งเดือน" />
              <View style={ui.tileRow}>
                <StatTile label="กิจกรรม/งาน" value={String(summary.total - summary.scheduleCount)} />
                <StatTile label="คาบเรียน" tone="purple" value={String(summary.scheduleCount)} />
                <StatTile hint="เฉพาะกิจกรรม" label="ทำเสร็จ" tone="green" value={percent(summary.completionRate)} />
              </View>
              <View style={local.legend}>
                {Object.entries(summary.byType).map(([type, count]) => (
                  <Tag backgroundColor="#f5f8f2" key={type} label={`${TYPE_LABELS[type] ?? type} ${count}`} />
                ))}
              </View>
            </AdminCard>
          ) : null}

          <AdminCard>
            <SectionHead
              meta={selectedDay ? `${dayEvents.length} รายการ` : undefined}
              title={selectedDay ? `กิจกรรมวันที่ ${selectedDay}` : 'แตะวันในปฏิทินเพื่อดูรายละเอียด'}
            />
            {!selectedDay ? (
              <Empty icon="touch_app" label="ยังไม่ได้เลือกวัน" />
            ) : !dayEvents.length ? (
              <Empty icon="event_busy" label="ไม่มีกิจกรรมในวันนี้" />
            ) : (
              dayEvents.map((event) => {
                const [statusLabel, statusColor] = STATUS_LABELS[(event.status ?? '').toLowerCase()] ?? ['', C.muted];
                return (
                  <Touchable
                    key={`${event.entity}-${event.id}`}
                    onPress={() => setDetail(event)}
                    style={({pressed}) => [local.eventRow, pressed && ui.pressed]}
                  >
                    <View style={[local.eventStripe, {backgroundColor: eventColor(event)}]} />
                    <View style={{flex: 1}}>
                      <Text numberOfLines={1} style={local.eventTitle}>{event.title}</Text>
                      <Text style={local.eventMeta}>
                        {timeFromMillis(event.startAtMs)} - {timeFromMillis(event.endAtMs)}
                        {event.location ? ` · ${event.location}` : ''}
                      </Text>
                      <View style={local.eventTags}>
                        <Tag label={TYPE_LABELS[event.type ?? ''] ?? event.type ?? 'กิจกรรม'} />
                        {statusLabel ? <Tag backgroundColor={`${statusColor}1a`} color={statusColor} label={statusLabel} /> : null}
                      </View>
                    </View>
                    <MaterialIcon color={C.muted} name="chevron_right" size={20} />
                  </Touchable>
                );
              })
            )}
          </AdminCard>
        </>
      )}

      <Modal animationType="slide" onRequestClose={() => setDetail(null)} transparent visible={Boolean(detail)}>
        <Pressable onPress={() => setDetail(null)} style={local.modalBackdrop}>
          <Pressable onPress={() => undefined} style={local.modalSheet}>
            <View style={local.modalHandle} />
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={local.modalTitle}>{detail?.title}</Text>
              <View style={local.eventTags}>
                <Tag label={TYPE_LABELS[detail?.type ?? ''] ?? detail?.type ?? 'กิจกรรม'} />
                {detail?.entity === 'schedule' ? <Tag backgroundColor="#E8EAF3" color="#6572b1" label="ตารางเรียน" /> : null}
              </View>
              <DetailRow icon="schedule" label="เริ่ม" value={dateTimeFromMillis(detail?.startAtMs)} />
              <DetailRow icon="schedule" label="สิ้นสุด" value={dateTimeFromMillis(detail?.endAtMs)} />
              <DetailRow
                icon="flag"
                label="สถานะ"
                value={detail?.entity === 'schedule'
                  ? 'คาบเรียนประจำ (ไม่มีสถานะ)'
                  : STATUS_LABELS[(detail?.status ?? '').toLowerCase()]?.[0] ?? '-'}
              />
              <DetailRow icon="place" label="สถานที่" value={detail?.location || '-'} />
              <DetailRow icon="notes" label={detail?.entity === 'schedule' ? 'รหัสวิชา' : 'บันทึก'} value={detail?.note || '-'} />
              <DetailRow icon="tag" label="รหัสรายการ" value={detail?.id ?? '-'} />
            </ScrollView>
            <Touchable onPress={() => setDetail(null)} style={({pressed}) => [local.modalClose, pressed && ui.pressed]}>
              <Text style={local.modalCloseText}>ปิด</Text>
            </Touchable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function DetailRow({icon, label, value}: {icon: string; label: string; value: string}) {
  return (
    <View style={local.detailRow}>
      <MaterialIcon color={C.sage} name={icon} size={18} />
      <Text style={local.detailLabel}>{label}</Text>
      <Text style={local.detailValue}>{value}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  calendarHeader: {color: C.pine, fontFamily: F.b, fontSize: 13},
  detailLabel: {color: C.muted, fontFamily: F.s, fontSize: 12, width: 76},
  detailRow: {alignItems: 'center', borderBottomColor: 'rgba(44,52,27,.07)', borderBottomWidth: 1, flexDirection: 'row', gap: 9, paddingVertical: 12},
  detailValue: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12, textAlign: 'right'},
  eventMeta: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  eventRow: {alignItems: 'center', backgroundColor: '#f5f8f2', borderRadius: 13, flexDirection: 'row', gap: 10, marginTop: 9, minHeight: 64, padding: 11},
  eventStripe: {borderRadius: 3, width: 4, alignSelf: 'stretch'},
  eventTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6},
  eventTitle: {color: C.pine, fontFamily: F.s, fontSize: 12},
  legend: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12},
  modalBackdrop: {backgroundColor: 'rgba(20,28,14,.42)', flex: 1, justifyContent: 'flex-end'},
  modalClose: {alignItems: 'center', backgroundColor: C.pine, borderRadius: 14, justifyContent: 'center', marginTop: 12, minHeight: 46},
  modalCloseText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  modalHandle: {alignSelf: 'center', backgroundColor: '#d6ded1', borderRadius: 3, height: 5, marginBottom: 12, width: 44},
  modalSheet: {backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '80%', padding: 20},
  modalTitle: {color: C.pine, fontFamily: F.x, fontSize: 17},
  monthActions: {flexDirection: 'row', gap: 8, marginBottom: 6, marginTop: 10},
  monthBar: {alignItems: 'center', flexDirection: 'row', gap: 8},
  monthNav: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, height: 38, justifyContent: 'center', width: 38},
  monthSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  monthTitle: {color: C.pine, fontFamily: F.b, fontSize: 14},
});
