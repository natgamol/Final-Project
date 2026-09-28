import {useCallback, useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {buildUserSeries} from '@/admin/analytics';
import {adminOverviewCounts, OVERVIEW_USER_LIMIT} from '@/services/admin-overview';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  AdminCard,
  C,
  Empty,
  ErrorBlock,
  F,
  FeatureSection,
  LoadingBlock,
  Row,
  SectionHead,
  SummaryAction,
  UserBarChart,
  date,
  items,
  number,
  styles as ui,
  text,
} from '../admin-ui';
import {useAdminUsers, useAdminWorkspace} from '../admin-workspace';
import {useAsyncData} from '../use-async-data';
import {userLabel} from '../user-picker';
import type {AdminViewProps} from './view-props';

const CHART_USERS = 6;

/** Gradients follow the original admin palette: sage, clay, and the AI indigo. */
const SECTION_GRADIENTS = {
  calendar: ['#4d7049', '#789a75'] as const,
  finance: ['#777da5', '#9297bb'] as const,
  notes: ['#9c7b4a', '#c4a374'] as const,
};

/**
 * Admin overview.
 *
 * Keeps every block the original dashboard had — the gradient summary rows,
 * System Health, and the recent-scan feed — and puts the three new user-centric
 * sections above them, styled in the same gradient language.
 */
export default function AdminDashboardView({data, onNavigate}: AdminViewProps) {
  const {selectUser} = useAdminWorkspace();
  const {error: usersError, loading: usersLoading, reload: reloadUsers, users} = useAdminUsers();

  const counts = (data.counts ?? {}) as Record<string, unknown>;
  const status = items(data.systemStatus);
  const scans = items(data.scanLogs);

  const uids = useMemo(() => users.map((user) => user.uid), [users]);
  const load = useCallback(() => adminOverviewCounts(uids), [uids]);
  const {data: perUser, error, loading, reload} = useAsyncData(
    `overview|${uids.join(',')}`,
    load,
    uids.length > 0,
  );

  const labelFor = useCallback((uid: string) => {
    const match = users.find((user) => user.uid === uid);
    return userLabel(match ? {displayName: match.displayName, email: match.email, uid} : {uid});
  }, [users]);

  const series = useMemo(() => {
    const rows = perUser?.counts ?? [];
    const build = (pick: (row: (typeof rows)[number]) => number) => buildUserSeries(
      rows.map((row) => ({count: pick(row), label: labelFor(row.uid), uid: row.uid})),
      CHART_USERS,
    );
    return {
      calendar: build((row) => row.activities + row.schedules),
      finance: build((row) => row.transactions),
      notes: build((row) => row.notes),
    };
  }, [labelFor, perUser]);

  /** Preselect the user, then land on that section's real feature view. */
  const openFor = useCallback((page: string) => (uid: string) => {
    selectUser(uid);
    onNavigate(page);
  }, [onNavigate, selectUser]);

  const skipped = perUser?.skippedUsers ?? 0;
  const coverage = skipped
    ? `แสดงกราฟจากผู้ใช้ ${OVERVIEW_USER_LIMIT} คนแรกจากทั้งหมด ${users.length} คน (อีก ${skipped} คนไม่ได้นับ)`
    : `นับจากผู้ใช้ทั้งหมด ${users.length} คน · แตะแถบเพื่อเปิดข้อมูลของคนนั้น`;

  const chartState = usersError
    ? <ErrorBlock message={usersError} onRetry={reloadUsers} />
    : error
      ? <ErrorBlock message={error} onRetry={reload} />
      : (loading || usersLoading) && !perUser
        ? <LoadingBlock label="กำลังนับข้อมูลของผู้ใช้แต่ละคน" />
        : null;

  return (
    <>
      {chartState}

      {!chartState ? (
        <>
          <FeatureSection
            accent="#4d7049"
            footnote={coverage}
            gradient={SECTION_GRADIENTS.calendar}
            icon="calendar_month"
            onOpen={() => onNavigate('admin_calendar')}
            openLabel="เปิดปฏิทินรายผู้ใช้"
            subtitle="เลือกผู้ใช้เพื่อดูกิจกรรมและตารางเรียนของคนนั้นเป็นรายเดือน"
            title="ปฏิทิน"
          >
            <SectionHead meta={`รวม ${number(series.calendar.total)} รายการ`} title="กิจกรรม + คาบเรียน ต่อผู้ใช้" />
            <UserBarChart
              color="#4d7049"
              emptyLabel="ยังไม่มีกิจกรรมของผู้ใช้คนไหนเลย"
              onSelectUser={openFor('admin_calendar')}
              points={series.calendar.points}
            />
            {series.calendar.hiddenUsers ? (
              <Text style={local.more}>+ อีก {series.calendar.hiddenUsers} คน รวม {number(series.calendar.hiddenCount)} รายการ</Text>
            ) : null}
          </FeatureSection>

          <FeatureSection
            accent="#9c7b4a"
            footnote="เปิดเข้าไปจะเห็นสัดส่วนหมวดโน้ต (การเรียน / งาน / ไอเดีย / ส่วนตัว) ของผู้ใช้แต่ละคน"
            gradient={SECTION_GRADIENTS.notes}
            icon="sticky_note_2"
            onOpen={() => onNavigate('admin_notes')}
            openLabel="เปิดโน้ตรายผู้ใช้"
            subtitle="ดูว่าผู้ใช้แต่ละคนเขียนโน้ตแนวไหน พร้อมสัดส่วนตามหมวด"
            title="โน้ต"
          >
            <SectionHead meta={`รวม ${number(series.notes.total)} โน้ต`} title="จำนวนโน้ต ต่อผู้ใช้" />
            <UserBarChart
              color="#9c7b4a"
              emptyLabel="ยังไม่มีโน้ตของผู้ใช้คนไหนเลย"
              onSelectUser={openFor('admin_notes')}
              points={series.notes.points}
            />
            {series.notes.hiddenUsers ? (
              <Text style={local.more}>+ อีก {series.notes.hiddenUsers} คน รวม {number(series.notes.hiddenCount)} โน้ต</Text>
            ) : null}
          </FeatureSection>

          <FeatureSection
            accent="#777da5"
            footnote="รวมผลการสแกนใบเสร็จ (OCR) ของผู้ใช้คนนั้นไว้ในหน้าเดียวกัน"
            gradient={SECTION_GRADIENTS.finance}
            icon="account_balance_wallet"
            onOpen={() => onNavigate('admin_finance')}
            openLabel="เปิดการเงินรายผู้ใช้"
            subtitle="รายรับ รายจ่าย เงินคงเหลือ และใบเสร็จที่สแกนของผู้ใช้แต่ละคน"
            title="การเงิน"
          >
            <SectionHead meta={`รวม ${number(series.finance.total)} รายการ`} title="จำนวนธุรกรรม ต่อผู้ใช้" />
            <UserBarChart
              color="#777da5"
              emptyLabel="ยังไม่มีธุรกรรมของผู้ใช้คนไหนเลย"
              onSelectUser={openFor('admin_finance')}
              points={series.finance.points}
            />
            {series.finance.hiddenUsers ? (
              <Text style={local.more}>+ อีก {series.finance.hiddenUsers} คน รวม {number(series.finance.hiddenCount)} รายการ</Text>
            ) : null}
          </FeatureSection>
        </>
      ) : null}

      <Text style={local.divider}>เครื่องมือผู้ดูแลระบบ</Text>

      <View style={ui.summaryList}>
        <SummaryAction icon="group" label="ผู้ใช้ทั้งหมด" onPress={() => onNavigate('admin_users')} value={counts.users} />
        <SummaryAction icon="calendar_month" label="ตารางเรียน" onPress={() => onNavigate('admin_calendar')} value={counts.schedules} />
        <SummaryAction accent="rose" icon="note_alt" label="โน้ตที่บันทึก" onPress={() => onNavigate('admin_notes')} value={counts.notes} />
        <SummaryAction accent="purple" icon="account_balance_wallet" label="รายการการเงิน" onPress={() => onNavigate('admin_finance')} value={counts.transactions} />
        <SummaryAction icon="auto_awesome" label="การใช้งาน AI" onPress={() => onNavigate('admin_ai_knowledge')} value={counts.aiRecommendations} />
        <SummaryAction accent="purple" icon="document_scanner" label="ประวัติการสแกน" onPress={() => onNavigate('admin_ocr_logs')} value={counts.scans} />
      </View>

      <AdminCard>
        <SectionHead meta="เข้าหน้าจัดการ" title="เมนูผู้ดูแล" />
        {([
          ['admin_categories', 'category', 'จัดการหมวดหมู่', 'หมวดของโน้ต การเงิน และกิจกรรม'],
          ['admin_announcements', 'campaign', 'ประกาศ', 'สื่อสารถึงผู้ใช้ทุกคน'],
          ['admin_feedback', 'forum', 'Feedback Center', 'ความคิดเห็นจากผู้ใช้จริง'],
          ['admin_ai_knowledge', 'auto_awesome', 'AI Knowledge Monitor', 'ข้อมูลที่ AI ใช้ประกอบคำแนะนำ'],
          ['admin_system_health', 'monitor_heart', 'System Health', 'สถานะบริการจากระบบจริง'],
        ] as const).map(([target, icon, title, detail]) => (
          <Touchable key={target} onPress={() => onNavigate(target)} style={({pressed}) => [ui.menu, pressed && ui.pressed]}>
            <View style={ui.menuIcon}><MaterialIcon color={C.sage} name={icon} size={20} /></View>
            <View style={{flex: 1}}>
              <Text style={ui.rowTitle}>{title}</Text>
              <Text style={ui.rowDetail}>{detail}</Text>
            </View>
            <MaterialIcon color={C.pine2} name="chevron_right" size={22} />
          </Touchable>
        ))}
      </AdminCard>

      <Touchable onPress={() => onNavigate('admin_system_health')} style={({pressed}) => pressed && ui.pressed}>
        <AdminCard>
          <SectionHead meta="ตรวจสอบล่าสุด" title="System Health" />
          {status.length ? status.slice(0, 4).map((item) => {
            const value = text(item.status);
            const icon = value === 'operational' ? 'check_circle' : value === 'degraded' ? 'warning' : 'error';
            const tone = value === 'operational' ? 'green' : value === 'degraded' ? 'amber' : 'red';
            const side = value === 'operational' ? 'พร้อม' : value === 'degraded' ? 'ลดลง' : 'ขัดข้อง';
            return (
              <Row
                detail={`${text(item.detail)} · ${number(item.latencyMs)} ms`}
                icon={icon}
                key={text(item.id, text(item.name))}
                side={side}
                title={text(item.name)}
                tone={tone}
              />
            );
          }) : <Empty label="ยังไม่มีสถานะบริการ" />}
        </AdminCard>
      </Touchable>

      <Touchable onPress={() => onNavigate('admin_ocr_logs')} style={({pressed}) => pressed && ui.pressed}>
        <AdminCard>
          <SectionHead meta={`${scans.length} รายการ`} title="กิจกรรมล่าสุด" />
          {scans.length ? scans.slice(0, 4).map((item) => (
            <Row
              detail={`${text(item.extractedText)} · ${date(item.createdAt)}`}
              icon={item.kind === 'receipt' ? 'receipt_long' : 'calendar_month'}
              key={text(item.id)}
              title={item.kind === 'receipt' ? 'OCR ใบเสร็จสำเร็จ' : 'OCR ตารางเรียนสำเร็จ'}
              tone="purple"
            />
          )) : <Empty label="ยังไม่มีประวัติการสแกน" />}
        </AdminCard>
      </Touchable>
    </>
  );
}

const local = StyleSheet.create({
  divider: {color: C.pine, fontFamily: F.b, fontSize: 13, marginTop: 22},
  more: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 8, textAlign: 'right'},
});
