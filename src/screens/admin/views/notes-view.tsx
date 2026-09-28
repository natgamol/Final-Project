import {useCallback, useMemo, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {summarizeNotes, type AdminNoteInput} from '@/admin/analytics';
import {adminUserNotes} from '@/services/admin-user-data';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  AdminCard,
  C,
  Empty,
  ErrorBlock,
  F,
  LoadingBlock,
  Pill,
  SectionHead,
  ShareBar,
  SmallButton,
  StatTile,
  Tag,
  dateTimeFromMillis,
  percent,
  styles as ui,
} from '../admin-ui';
import {useAdminWorkspace} from '../admin-workspace';
import {useAsyncData} from '../use-async-data';
import UserPicker, {useSelectedUser, userLabel} from '../user-picker';

/** Fixed palette so a category keeps the same colour across users. */
const CATEGORY_COLORS: Record<string, string> = {
  idea: '#c4943d',
  personal: '#b98080',
  study: '#6f966f',
  uncategorized: '#a9b1a4',
  work: '#6572b1',
};

const PRIORITY_LABELS: Record<string, [string, string]> = {
  important: ['สำคัญ', C.amber],
  normal: ['ทั่วไป', C.sage],
  urgent: ['เร่งด่วน', C.red],
};

const PAGE_SIZE = 15;

/** The service layer caps this list; say so rather than implying completeness. */
const NOTE_FETCH_LIMIT = 100;

export default function AdminNotesView() {
  const {selectedUid} = useAdminWorkspace();
  const selected = useSelectedUser();
  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const load = useCallback(() => adminUserNotes(selectedUid as string), [selectedUid]);
  const {data, error, loading, reload} = useAsyncData(
    `notes|${selectedUid ?? ''}`,
    load,
    Boolean(selectedUid),
  );

  const notes = useMemo(() => data ?? [], [data]);
  const profile = useMemo(() => summarizeNotes(notes), [notes]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes.filter((note) => {
      const noteCategory = (note.category ?? '').toLowerCase();
      const key = CATEGORY_COLORS[noteCategory] ? noteCategory : 'uncategorized';
      if (category !== 'all' && key !== category) return false;
      if (!needle) return true;
      return `${note.title ?? ''} ${note.content ?? ''}`.toLowerCase().includes(needle);
    });
  }, [category, notes, query]);

  const shown = filtered.slice(0, visible);

  return (
    <>
      <LinearGradient colors={['#9c7b4a', '#c4a374']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={ui.insight}>
        <MaterialIcon color="#fff" name="sticky_note_2" size={29} />
        <View style={{flex: 1}}>
          <Text style={ui.insightTitle}>โน้ตรายผู้ใช้</Text>
          <Text style={ui.insightSub}>สัดส่วนหมวดโน้ตและรายการโน้ตของผู้ใช้แต่ละคน</Text>
        </View>
      </LinearGradient>

      <UserPicker subtitle="ดูโน้ตของผู้ใช้แต่ละคน พร้อมสรุปว่าเขามักเขียนโน้ตแนวไหน" />

      {!selectedUid ? (
        <AdminCard><Empty icon="sticky_note_2" label="เลือกผู้ใช้ด้านบนเพื่อดูโน้ต" /></AdminCard>
      ) : (
        <>
          {error ? <ErrorBlock message={error} onRetry={reload} /> : null}
          {loading && !notes.length ? <LoadingBlock label="กำลังโหลดโน้ตของผู้ใช้" /> : null}

          {!error && !loading ? (
            <>
              <AdminCard>
                <SectionHead
                  meta={`${profile.total} โน้ต`}
                  title={`ลักษณะโน้ตของ ${userLabel(selected)}`}
                />
                <Text style={local.summary}>{profile.summary}</Text>

                <ShareBar
                  segments={profile.breakdown.map((item) => ({
                    color: CATEGORY_COLORS[item.key] ?? C.muted,
                    key: item.key,
                    share: item.share,
                  }))}
                />

                <View style={local.breakdown}>
                  {profile.breakdown.length ? profile.breakdown.map((item) => (
                    <View key={item.key} style={local.breakdownRow}>
                      <View style={[ui.colorDot, {backgroundColor: CATEGORY_COLORS[item.key] ?? C.muted}]} />
                      <Text style={local.breakdownLabel}>{item.label}</Text>
                      <Text style={local.breakdownCount}>{item.count}</Text>
                      <Text style={local.breakdownShare}>{percent(item.share)}</Text>
                    </View>
                  )) : <Empty icon="sticky_note_2" label="ผู้ใช้คนนี้ยังไม่มีโน้ต" />}
                </View>

                {profile.total ? (
                  <View style={ui.tileRow}>
                    <StatTile label="ยังไม่เสร็จ" tone="amber" value={String(profile.open)} />
                    <StatTile label="เสร็จแล้ว" tone="green" value={String(profile.completed)} />
                    <StatTile label="เร่งด่วน" tone="red" value={String(profile.priority.urgent)} />
                    <StatTile hint="ตัวอักษร" label="ความยาวเฉลี่ย" tone="purple" value={String(profile.averageLength)} />
                  </View>
                ) : null}

                {profile.total >= NOTE_FETCH_LIMIT ? (
                  <Text style={local.capNotice}>
                    แสดงเฉพาะ {NOTE_FETCH_LIMIT} โน้ตล่าสุด สัดส่วนด้านบนคำนวณจากชุดนี้เท่านั้น
                  </Text>
                ) : null}
              </AdminCard>

              <AdminCard>
                <SectionHead meta={`${filtered.length} รายการ`} title="รายการโน้ต" />

                <View style={local.searchRow}>
                  <MaterialIcon color={C.muted} name="search" size={18} />
                  <TextInput
                    onChangeText={(value) => { setQuery(value); setVisible(PAGE_SIZE); }}
                    placeholder="ค้นหาในหัวข้อหรือเนื้อหาโน้ต"
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

                <View style={ui.pillRow}>
                  <Pill label="ทั้งหมด" onPress={() => { setCategory('all'); setVisible(PAGE_SIZE); }} selected={category === 'all'} />
                  {profile.breakdown.map((item) => (
                    <Pill
                      key={item.key}
                      label={`${item.label} (${item.count})`}
                      onPress={() => { setCategory(item.key); setVisible(PAGE_SIZE); }}
                      selected={category === item.key}
                    />
                  ))}
                </View>

                {!shown.length ? <Empty icon="search_off" label="ไม่พบโน้ตที่ตรงกับตัวกรอง" /> : null}

                {shown.map((note) => <NoteRow key={note.id} note={note} />)}

                {filtered.length > shown.length ? (
                  <Touchable onPress={() => setVisible((current) => current + PAGE_SIZE)} style={({pressed}) => [ui.refreshButton, pressed && ui.pressed]}>
                    <MaterialIcon color={C.pine} name="expand_more" size={16} />
                    <Text style={ui.refreshButtonText}>ดูเพิ่มอีก {Math.min(PAGE_SIZE, filtered.length - shown.length)} รายการ</Text>
                  </Touchable>
                ) : null}

                <View style={{marginTop: 12}}>
                  <SmallButton icon="refresh" label="รีเฟรชโน้ต" loading={loading} onPress={reload} tone="green" />
                </View>
              </AdminCard>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

function NoteRow({note}: {note: AdminNoteInput}) {
  const [expanded, setExpanded] = useState(false);
  const categoryKey = CATEGORY_COLORS[(note.category ?? '').toLowerCase()] ? (note.category as string).toLowerCase() : 'uncategorized';
  const color = CATEGORY_COLORS[categoryKey];
  const [priorityLabel, priorityColor] = PRIORITY_LABELS[(note.priority ?? 'normal').toLowerCase()] ?? PRIORITY_LABELS.normal;
  const done = (note.status ?? '').toLowerCase() === 'completed';

  return (
    <Touchable onPress={() => setExpanded((value) => !value)} style={({pressed}) => [local.noteRow, pressed && ui.pressed]}>
      <View style={[local.noteStripe, {backgroundColor: color}]} />
      <View style={{flex: 1}}>
        <Text numberOfLines={1} style={local.noteTitle}>{note.title}</Text>
        <Text numberOfLines={expanded ? undefined : 2} style={local.noteContent}>
          {note.content?.trim() || 'ไม่มีเนื้อหา'}
        </Text>
        <View style={local.noteTags}>
          <Tag backgroundColor={`${color}1f`} color={color} label={note.category || 'ไม่ระบุหมวด'} />
          <Tag backgroundColor={`${priorityColor}1f`} color={priorityColor} label={priorityLabel} />
          <Tag
            backgroundColor={done ? '#e8f0e5' : C.mist}
            color={done ? '#5a8d5d' : C.muted}
            label={done ? 'เสร็จแล้ว' : 'ยังไม่เสร็จ'}
          />
        </View>
        <Text style={local.noteMeta}>แก้ไขล่าสุด {dateTimeFromMillis(note.updatedAtMs)}</Text>
      </View>
      <MaterialIcon color={C.muted} name={expanded ? 'expand_less' : 'expand_more'} size={20} />
    </Touchable>
  );
}

const local = StyleSheet.create({
  breakdown: {marginTop: 12},
  breakdownCount: {color: C.pine, fontFamily: F.b, fontSize: 12, minWidth: 30, textAlign: 'right'},
  breakdownLabel: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12},
  breakdownRow: {alignItems: 'center', borderBottomColor: 'rgba(44,52,27,.06)', borderBottomWidth: 1, flexDirection: 'row', gap: 9, paddingVertical: 9},
  breakdownShare: {color: C.muted, fontFamily: F.s, fontSize: 12, minWidth: 40, textAlign: 'right'},
  capNotice: {backgroundColor: C.amberSoft, borderRadius: 10, color: '#8a6b28', fontFamily: F.m, fontSize: 12, marginTop: 12, padding: 9},
  noteContent: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 3},
  noteMeta: {color: '#a3aa9e', fontFamily: F.r, fontSize: 12, marginTop: 6},
  noteRow: {alignItems: 'flex-start', backgroundColor: '#f5f8f2', borderRadius: 13, flexDirection: 'row', gap: 10, marginTop: 9, padding: 11},
  noteStripe: {alignSelf: 'stretch', borderRadius: 3, width: 4},
  noteTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7},
  noteTitle: {color: C.pine, fontFamily: F.s, fontSize: 12},
  searchInput: {color: C.pine, flex: 1, fontFamily: F.m, fontSize: 12, minHeight: 40},
  searchRow: {alignItems: 'center', backgroundColor: '#f6f8f3', borderColor: '#e1e6dd', borderRadius: 13, borderWidth: 1, flexDirection: 'row', gap: 8, marginTop: 11, paddingHorizontal: 12},
  summary: {color: C.pine2, fontFamily: F.m, fontSize: 12, marginTop: 8},
});
