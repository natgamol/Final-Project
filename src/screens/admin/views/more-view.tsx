import {Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, SectionHead, styles as ui} from '../admin-ui';
import type {AdminViewProps} from './view-props';

type Link = [target: string, icon: string, title: string, detail: string];

const PER_USER: Link[] = [
  ['admin_calendar', 'calendar_month', 'ปฏิทินรายผู้ใช้', 'กิจกรรมและตารางเรียนของผู้ใช้แต่ละคน'],
  ['admin_notes', 'sticky_note_2', 'โน้ตรายผู้ใช้', 'ประเภทโน้ตและรายการโน้ตของผู้ใช้'],
  ['admin_finance', 'account_balance_wallet', 'การเงินรายผู้ใช้', 'รายรับ รายจ่าย เงินคงเหลือ และ OCR'],
];

const SYSTEM: Link[] = [
  ['admin_users', 'group', 'จัดการผู้ใช้', 'ระงับบัญชีและรีเซ็ตรหัสผ่าน'],
  ['admin_categories', 'category', 'จัดการหมวดหมู่', 'โน้ต การเงิน และกิจกรรม'],
  ['admin_ocr_logs', 'document_scanner', 'OCR / Import Log', 'ตรวจสอบประวัติการสแกนทั้งระบบ'],
  ['admin_announcements', 'campaign', 'ประกาศ', 'สื่อสารถึงผู้ใช้ทุกคน'],
  ['admin_feedback', 'forum', 'Feedback Center', 'ความคิดเห็นจากผู้ใช้'],
  ['admin_ai_knowledge', 'auto_awesome', 'AI Knowledge Monitor', 'ข้อมูลที่ AI ใช้ประกอบคำแนะนำ'],
  ['admin_system_health', 'monitor_heart', 'System Health', 'สถานะบริการและออกจากระบบ'],
];

function LinkList({links, onNavigate}: {links: Link[]; onNavigate: (page: string) => void}) {
  return (
    <>
      {links.map(([target, icon, title, detail]) => (
        <Touchable key={target} onPress={() => onNavigate(target)} style={({pressed}) => [ui.menu, pressed && ui.pressed]}>
          <View style={ui.menuIcon}><MaterialIcon color={C.sage} name={icon} size={20} /></View>
          <View style={{flex: 1}}>
            <Text style={ui.rowTitle}>{title}</Text>
            <Text style={ui.rowDetail}>{detail}</Text>
          </View>
          <MaterialIcon color={C.pine2} name="chevron_right" size={22} />
        </Touchable>
      ))}
    </>
  );
}

export default function AdminMoreView({onNavigate}: AdminViewProps) {
  return (
    <>
      <AdminCard>
        <SectionHead meta="เจาะรายบุคคล" title="มุมมองรายผู้ใช้" />
        <LinkList links={PER_USER} onNavigate={onNavigate} />
      </AdminCard>
      <AdminCard>
        <SectionHead meta="ทั้งระบบ" title="เครื่องมือผู้ดูแล" />
        <LinkList links={SYSTEM} onNavigate={onNavigate} />
      </AdminCard>
    </>
  );
}
