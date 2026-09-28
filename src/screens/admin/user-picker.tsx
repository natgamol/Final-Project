import {useMemo, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {filterUsers, sortUsers, type AdminUserInput} from '@/admin/analytics';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, Empty, ErrorBlock, F, SectionHead, SmallButton, styles as ui} from './admin-ui';
import {useAdminUsers, useAdminWorkspace} from './admin-workspace';

const PAGE_SIZE = 20;

export type SelectedUser = {
  disabled: boolean;
  displayName: string;
  email: string;
  uid: string;
};

/** Resolves the currently selected UID against the cached Auth user list. */
export function useSelectedUser(): SelectedUser | null {
  const {selectedUid} = useAdminWorkspace();
  const {users} = useAdminUsers();
  return useMemo(() => {
    if (!selectedUid) return null;
    const match = users.find((user) => user.uid === selectedUid);
    if (!match) return {disabled: false, displayName: '', email: '', uid: selectedUid};
    return {
      disabled: Boolean(match.disabled),
      displayName: match.displayName ?? '',
      email: match.email ?? '',
      uid: match.uid,
    };
  }, [selectedUid, users]);
}

export function userLabel(user: {displayName?: string | null; email?: string | null; uid: string} | null) {
  if (!user) return 'ยังไม่ได้เลือกผู้ใช้';
  return user.displayName?.trim() || user.email?.trim() || user.uid;
}

/**
 * Searchable user list shared by the Calendar, Notes, and Finance views.
 *
 * Collapses to a one-line summary once a user is picked so the view below has
 * room, and pages the list so a large tenant does not render a thousand rows
 * inside the surrounding ScrollView.
 */
export default function UserPicker({subtitle}: {subtitle?: string}) {
  const {search, selectUser, selectedUid, setSearch} = useAdminWorkspace();
  const {error, loading, reload, users} = useAdminUsers();
  const selected = useSelectedUser();
  const [expanded, setExpanded] = useState(!selectedUid);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const matches = useMemo(() => {
    const input: AdminUserInput[] = users.map((user) => ({
      createdAt: user.createdAt,
      disabled: user.disabled,
      displayName: user.displayName,
      email: user.email,
      lastSignInAt: user.lastSignInAt,
      uid: user.uid,
    }));
    return sortUsers(filterUsers(input, search));
  }, [search, users]);

  const shown = matches.slice(0, visible);

  if (!expanded && selected) {
    return (
      <AdminCard>
        <View style={local.selectedBar}>
          <View style={[local.avatar, selected.disabled && {backgroundColor: C.redSoft}]}>
            <MaterialIcon color={selected.disabled ? C.red : C.sage} name="person" size={20} />
          </View>
          <View style={{flex: 1}}>
            <Text numberOfLines={1} style={local.selectedName}>{userLabel(selected)}</Text>
            <Text numberOfLines={1} style={local.selectedMeta}>
              {selected.email || selected.uid}{selected.disabled ? ' · บัญชีถูกระงับ' : ''}
            </Text>
          </View>
          <SmallButton icon="swap_horiz" label="เปลี่ยนผู้ใช้" onPress={() => setExpanded(true)} tone="purple" />
        </View>
      </AdminCard>
    );
  }

  return (
    <AdminCard>
      <SectionHead
        meta={loading ? 'กำลังโหลด...' : `${matches.length} / ${users.length} คน`}
        title="เลือกผู้ใช้"
      />
      {subtitle ? <Text style={local.subtitle}>{subtitle}</Text> : null}

      <View style={local.searchRow}>
        <MaterialIcon color={C.muted} name="search" size={18} />
        <TextInput
          onChangeText={(value) => { setSearch(value); setVisible(PAGE_SIZE); }}
          placeholder="ค้นหาชื่อ อีเมล หรือ UID"
          placeholderTextColor="#a6ada3"
          style={local.searchInput}
          value={search}
        />
        {search ? (
          <Touchable accessibilityLabel="ล้างคำค้นหา" onPress={() => { setSearch(''); setVisible(PAGE_SIZE); }}>
            <MaterialIcon color={C.muted} name="close" size={18} />
          </Touchable>
        ) : null}
      </View>

      {error ? <ErrorBlock message={error} onRetry={reload} /> : null}

      {!error && !users.length && loading ? <Text style={local.hint}>กำลังโหลดรายชื่อผู้ใช้...</Text> : null}
      {!error && !loading && !matches.length ? <Empty icon="person_search" label="ไม่พบผู้ใช้ที่ตรงกับคำค้นหา" /> : null}

      {shown.map((user) => {
        const active = user.uid === selectedUid;
        return (
          <Touchable
            key={user.uid}
            onPress={() => { selectUser(user.uid); setExpanded(false); }}
            style={({pressed}) => [local.userRow, active && local.userRowActive, pressed && ui.pressed]}
          >
            <View style={[local.avatar, user.disabled && {backgroundColor: C.redSoft}]}>
              <MaterialIcon color={user.disabled ? C.red : C.sage} name="person" size={18} />
            </View>
            <View style={{flex: 1}}>
              <Text numberOfLines={1} style={local.userName}>{userLabel(user)}</Text>
              <Text numberOfLines={1} style={local.userMeta}>{user.email || user.uid}</Text>
            </View>
            {user.disabled ? <Text style={local.disabledTag}>ระงับ</Text> : null}
            {active ? <MaterialIcon color={C.pine} name="check_circle" size={18} /> : null}
          </Touchable>
        );
      })}

      {matches.length > shown.length ? (
        <Touchable onPress={() => setVisible((current) => current + PAGE_SIZE)} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
          <MaterialIcon color={C.pine} name="expand_more" size={16} />
          <Text style={ui.refreshButtonText}>ดูเพิ่มอีก {Math.min(PAGE_SIZE, matches.length - shown.length)} คน</Text>
        </Touchable>
      ) : null}

      <View style={local.footer}>
        <SmallButton icon="refresh" label="โหลดรายชื่อใหม่" loading={loading} onPress={reload} tone="green" />
        {selectedUid ? <SmallButton icon="close" label="ยกเลิกการเลือก" onPress={() => { selectUser(null); setExpanded(true); }} tone="red" /> : null}
      </View>
    </AdminCard>
  );
}

const local = StyleSheet.create({
  avatar: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, height: 36, justifyContent: 'center', width: 36},
  disabledTag: {color: C.red, fontFamily: F.b, fontSize: 12},
  footer: {flexDirection: 'row', gap: 8, marginTop: 12},
  hint: {color: C.muted, fontFamily: F.r, fontSize: 12, paddingVertical: 12, textAlign: 'center'},
  searchInput: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12, minHeight: 40},
  searchRow: {alignItems: 'center', backgroundColor: '#f6f8f3', borderColor: '#e1e6dd', borderRadius: 13, borderWidth: 1, flexDirection: 'row', gap: 8, marginTop: 11, paddingHorizontal: 12},
  selectedBar: {alignItems: 'center', flexDirection: 'row', gap: 10},
  selectedMeta: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1},
  selectedName: {color: C.pine, fontFamily: F.b, fontSize: 12},
  subtitle: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 4},
  userMeta: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1},
  userName: {color: C.pine, fontFamily: F.s, fontSize: 12},
  userRow: {alignItems: 'center', backgroundColor: '#f5f8f2', borderColor: 'transparent', borderRadius: 13, borderWidth: 1.5, flexDirection: 'row', gap: 10, marginTop: 8, minHeight: 56, padding: 10},
  userRowActive: {backgroundColor: C.sageSoft, borderColor: C.sage},
});
