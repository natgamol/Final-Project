import {Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, Empty, Row, SectionHead, date, items, number, styles as ui, text} from '../admin-ui';
import type {AdminViewProps} from './view-props';

type Props = AdminViewProps & {onLogout: () => void};

export default function AdminSystemHealthView({data, onLogout, reload}: Props) {
  // `sortOrder` groups the checks the way an operator reads them (core Firebase,
  // then OCR, then AI, then sign-in). Docs written before this field existed
  // fall to the end instead of scrambling the list.
  const list = items(data.systemStatus).slice().sort((first, second) => {
    const rank = (item: typeof first) => (typeof item.sortOrder === 'number' ? item.sortOrder : 9_999);
    return rank(first) - rank(second) || text(first.name).localeCompare(text(second.name));
  });

  return (
    <>
      <Touchable onPress={() => { reload(); }} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
        <MaterialIcon color={C.pine} name="refresh" size={16} />
        <Text style={ui.refreshButtonText}>รีเฟรชสถานะ</Text>
      </Touchable>

      <AdminCard>
        <SectionHead meta={`${list.length} บริการ`} title="สถานะบริการ" />
        {list.length ? list.map((item) => {
          const status = text(item.status);
          // `unknown` means the dependency was not exercised this round. It is
          // deliberately neutral: painting it red would report an incident
          // that was never observed.
          const icon = status === 'operational' ? 'check_circle'
            : status === 'degraded' ? 'warning'
              : status === 'unknown' ? 'help' : 'error';
          const tone = status === 'operational' ? 'green'
            : status === 'degraded' ? 'amber'
              : status === 'unknown' ? 'purple' : 'red';
          const label = status === 'operational' ? 'พร้อมใช้งาน'
            : status === 'degraded' ? 'ประสิทธิภาพลดลง'
              : status === 'unknown' ? 'ไม่ได้ตรวจรอบนี้' : 'ขัดข้อง';
          const dotStyle = status === 'operational' ? ui.statusOperational
            : status === 'degraded' ? ui.statusDegraded
              : status === 'unknown' ? ui.statusUnknown : ui.statusOutage;
          const checkedAt = item.checkedAt ? ` · ตรวจสอบเมื่อ ${date(item.checkedAt)}` : '';
          return (
            <Row
              detail={`${text(item.detail)} · ${number(item.latencyMs)} ms${checkedAt}`}
              icon={icon}
              key={text(item.id, text(item.name))}
              title={text(item.name)}
              tone={tone}
            >
              <View style={{alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 6}}>
                <View style={[ui.colorDot, dotStyle]} />
                <Text style={[ui.rowSide, {color: tone === 'amber' ? C.amber : tone === 'red' ? C.red : C.sage}]}>{label}</Text>
              </View>
            </Row>
          );
        }) : <Empty label="กำลังตรวจสอบสถานะระบบ" />}
      </AdminCard>

      <Touchable onPress={onLogout} style={({pressed}) => [ui.logout, pressed && ui.pressed]}>
        <MaterialIcon color={C.red} name="logout" size={19} />
        <Text style={ui.logoutText}>ออกจากระบบ Admin</Text>
      </Touchable>
    </>
  );
}
