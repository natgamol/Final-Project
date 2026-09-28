import {useMemo, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {filterUsers, sortUsers, type AdminUserInput} from '@/admin/analytics';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, Empty, F, Row, SectionHead, SmallButton, date, items, styles as ui, text} from '../admin-ui';
import {useAdminWorkspace} from '../admin-workspace';
import type {AdminViewProps} from './view-props';
import {showToast} from '@/components/app-toast';

const PAGE_SIZE = 20;

export default function AdminUsersView({actionLoading, data, onAction, onNavigate}: AdminViewProps) {
  const {selectUser} = useAdminWorkspace();
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const list = useMemo(() => items(data.users), [data.users]);

  const filtered = useMemo(() => {
    const input: AdminUserInput[] = list.map((item) => ({
      createdAt: text(item.createdAt, ''),
      disabled: item.disabled === true,
      displayName: text(item.displayName, ''),
      email: text(item.email, ''),
      lastSignInAt: text(item.lastSignInAt ?? item.lastSignInTime, ''),
      uid: text(item.uid, ''),
    }));
    return sortUsers(filterUsers(input, query));
  }, [list, query]);

  const shown = filtered.slice(0, visible);

  const openFor = (uid: string, page: string) => {
    selectUser(uid);
    onNavigate(page);
  };

  return (
    <AdminCard>
      <SectionHead meta={`${filtered.length} / ${list.length} คน`} title="รายชื่อผู้ใช้ทั้งหมด" />

      <View style={local.searchRow}>
        <MaterialIcon color={C.muted} name="search" size={18} />
        <TextInput
          onChangeText={(value) => { setQuery(value); setVisible(PAGE_SIZE); }}
          placeholder="ค้นหาชื่อ อีเมล หรือ UID"
          placeholderTextColor="#a6ada3"
          style={local.searchInput}
          value={query}
        />
        {query ? (
          <Touchable accessibilityLabel="ล้างคำค้นหา" onPress={() => setQuery('')}>
            <MaterialIcon color={C.muted} name="close" size={18} />
          </Touchable>
        ) : null}
      </View>

      {!list.length ? <Empty label="ยังไม่มีบัญชีผู้ใช้" /> : null}
      {list.length && !filtered.length ? <Empty icon="person_search" label="ไม่พบผู้ใช้ที่ตรงกับคำค้นหา" /> : null}

      {shown.map((user) => {
        const uid = user.uid;
        const disabled = Boolean(user.disabled);
        const lastSignIn = user.lastSignInAt ? ` · ล็อกอิน ${date(user.lastSignInAt)}` : '';
        return (
          <Row
            detail={`${user.email || uid} · สมัคร ${date(user.createdAt)}${lastSignIn}`}
            icon="person"
            key={uid}
            side={disabled ? 'ระงับ' : 'ปกติ'}
            title={user.displayName || user.email || uid}
            tone={disabled ? 'red' : 'green'}
          >
            <View style={ui.actionRow}>
              <SmallButton
                icon={disabled ? 'check_circle' : 'block'}
                label={disabled ? 'เปิดใช้งาน' : 'ระงับบัญชี'}
                loading={actionLoading === `${uid}-toggle`}
                onPress={() => onAction(
                  `${uid}-toggle`,
                  'toggle-user',
                  {disabled: !disabled, uid},
                  disabled ? 'เปิดใช้งานบัญชีแล้ว' : 'ระงับบัญชีแล้ว',
                )}
                tone={disabled ? 'green' : 'red'}
              />
              <SmallButton
                icon="lock_reset"
                label="รีเซ็ตรหัสผ่าน"
                loading={actionLoading === `${uid}-reset`}
                onPress={() => {
                  if (!user.email) {
                    showToast('ไม่มีอีเมล', 'บัญชีนี้ไม่มีอีเมลจึงส่งลิงก์รีเซ็ตรหัสผ่านไม่ได้');
                    return;
                  }
                  onAction(`${uid}-reset`, 'reset-user-password', {email: user.email}, `ส่งลิงก์รีเซ็ตรหัสผ่านไปที่ ${user.email} แล้ว`);
                }}
                tone="purple"
              />
            </View>
            <View style={ui.actionRow}>
              <SmallButton icon="calendar_month" label="ปฏิทิน" onPress={() => openFor(uid, 'admin_calendar')} tone="green" />
              <SmallButton icon="sticky_note_2" label="โน้ต" onPress={() => openFor(uid, 'admin_notes')} tone="amber" />
              <SmallButton icon="account_balance_wallet" label="การเงิน" onPress={() => openFor(uid, 'admin_finance')} tone="purple" />
            </View>
          </Row>
        );
      })}

      {filtered.length > shown.length ? (
        <Touchable onPress={() => setVisible((current) => current + PAGE_SIZE)} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
          <MaterialIcon color={C.pine} name="expand_more" size={16} />
          <Text style={ui.refreshButtonText}>ดูเพิ่มอีก {Math.min(PAGE_SIZE, filtered.length - shown.length)} คน</Text>
        </Touchable>
      ) : null}

      <Text style={local.footnote}>
        รายชื่อมาจาก Firebase Authentication (สูงสุด 1,000 บัญชีต่อการเรียกหนึ่งครั้ง)
      </Text>
    </AdminCard>
  );
}

const local = StyleSheet.create({
  footnote: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 12, textAlign: 'center'},
  searchInput: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12, minHeight: 40},
  searchRow: {alignItems: 'center', backgroundColor: '#f6f8f3', borderColor: '#e1e6dd', borderRadius: 13, borderWidth: 1, flexDirection: 'row', gap: 8, marginTop: 11, paddingHorizontal: 12},
});
