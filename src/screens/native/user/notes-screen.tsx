import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import Animated, {FadeInDown, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated';
import {Timestamp} from 'firebase/firestore';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import AiActivityRecommendationCard from '@/components/ai-activity-recommendation-card';

import {loadLegacyPageData} from '@/services/legacy-data';
import {noteFolders as folderStore, notes as notesStore} from '@/services/firestore';
import type {NoteFolder, WithId} from '@/types/smartlife';
import {MaterialIcon, UserGradientBackdrop, UserTabBar} from './user-ui';
import {showToast} from '@/components/app-toast';

type Page = 'smartlife_notes' | 'smartlife_notes_study' | 'smartlife_notes_work' | 'smartlife_notes_ideas';
type PlannerTab = 'adaptive' | 'calendar' | 'notes';
type NoteFilter = 'all' | 'study' | 'work' | 'idea';
type Props = {onNavigate: (page: string) => void; page: Page; planner?: {activeTab: PlannerTab; onTabChange: (tab: PlannerTab) => void}; uid: string};
type Item = Record<string, unknown>;

const C = {ink: '#29351f', mist: '#f4f6f1', muted: '#89928a', pink: '#c49497', pinkSoft: '#f5e8e9', sage: '#628660', sageSoft: '#e1ebdf', yellow: '#d3a957', yellowSoft: '#faf1d9'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};
const tabs: {icon: string; label: string; page: Page; value: NoteFilter}[] = [
  {icon: 'grid_view', label: 'ทั้งหมด', page: 'smartlife_notes', value: 'all'},
  {icon: 'menu_book', label: 'เรียน', page: 'smartlife_notes_study', value: 'study'},
  {icon: 'work', label: 'งาน', page: 'smartlife_notes_work', value: 'work'},
  {icon: 'lightbulb', label: 'ไอเดีย', page: 'smartlife_notes_ideas', value: 'idea'},
];

function list(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === 'object') : []; }
function str(item: Item, key: string, fallback = '-') { const value = item[key]; return typeof value === 'string' && value.trim() ? value : fallback; }
function date(value: unknown) { const result = new Date(String(value ?? '')); return Number.isNaN(result.getTime()) ? 'วันนี้' : new Intl.DateTimeFormat('th-TH', {day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok'}).format(result); }
function categoryOf(item: Item, fallback: 'all' | 'study' | 'work' | 'idea') { const category = str(item, 'category', fallback); return category === 'study' || category === 'work' || category === 'idea' || category === 'personal' ? category : fallback; }

export default function NotesScreen({onNavigate, page, planner, uid}: Props) {
  const [data, setData] = useState<{notes?: Item[]} | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [completingId, setCompletingId] = useState('');
  const [plannerFilter, setPlannerFilter] = useState<NoteFilter>('all');
  const [search, setSearch] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folders, setFolders] = useState<WithId<NoteFolder>[]>([]);
  const effectivePage = planner ? tabs.find((tab) => tab.value === plannerFilter)?.page ?? 'smartlife_notes' : page;
  const active = tabs.find((tab) => tab.page === effectivePage) ?? tabs[0];
  const load = useCallback(async () => setData(await loadLegacyPageData(uid, `user/${effectivePage}`) as {notes?: Item[]}), [effectivePage, uid]);
  useEffect(() => { load().catch(() => setData({})); }, [load]);
  useEffect(() => {
    let active = true;
    folderStore.list(uid).then((items) => { if (active) setFolders(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [uid]);
  const refresh = useCallback(async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }, [load]);
  const allNotes = useMemo(() => list(data?.notes), [data]);
  /**
   * Search and folder filtering run over the page of notes already loaded,
   * client-side. Firestore has no full-text search and this project's rules
   * explicitly exclude `content` from indexing, so a server-side query could
   * not do this anyway. At the 100-note page size a student actually has, the
   * filter is instant; past that it would need a search service.
   */
  const notes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = allNotes
      .filter((note) => str(note, 'status', 'pending') !== 'completed')
      .filter((note) => !folderId || str(note, 'folderId', '') === folderId)
      .filter((note) => {
        if (!needle) return true;
        const tags = Array.isArray(note.tags) ? note.tags.join(' ') : '';
        return `${str(note, 'title', '')} ${str(note, 'content', '')} ${tags}`.toLowerCase().includes(needle);
      });
    // Pinned notes first, otherwise the existing newest-first order stands.
    return [...matches].sort((first, second) => Number(second.pinned === true) - Number(first.pinned === true));
  }, [allNotes, folderId, search]);
  const focusNotes = notes.slice(0, 2);
  const completeCount = allNotes.filter((note) => str(note, 'status', 'pending') === 'completed').length;
  const importantCount = notes.filter((note) => note.pinned === true).length;
  /** Opens a saved note in the editor. Without an id there is nothing to open. */
  const openNote = useCallback((note: Item) => {
    const id = str(note, 'id', '');
    if (id) onNavigate(`smartlife_add_note?id=${encodeURIComponent(id)}`);
  }, [onNavigate]);

  const markComplete = useCallback(async (note: Item) => {
    const id = str(note, 'id', '');
    if (!id || completingId) return;
    setCompletingId(id);
    setData((current) => current ? {...current, notes: list(current.notes).map((item) => str(item, 'id', '') === id ? {...item, completedAt: new Date().toISOString(), status: 'completed'} : item)} : current);
    try {
      await notesStore.update(uid, id, {completedAt: Timestamp.fromDate(new Date()), status: 'completed'});
    } catch (error) {
      await load().catch(() => undefined);
      showToast('ทำเครื่องหมายไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setCompletingId('');
    }
  }, [completingId, load, uid]);

  return <ResponsiveSafeArea style={styles.safe}><View style={styles.screen}><UserGradientBackdrop />
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.sage} />} showsVerticalScrollIndicator={false}>
      {/* Refactored UI: compact notes dashboard with category-aware counts and list. */}
      <View style={styles.header}><View><Text style={styles.eyebrow}>บันทึกของฉัน</Text><Text style={styles.title}>โน้ต</Text></View><Touchable accessibilityLabel="เพิ่มโน้ต" onPress={() => onNavigate('smartlife_add_note')} style={styles.add}><MaterialIcon color={C.ink} name="add" size={26} /></Touchable></View>
      <View style={styles.focusCard}><View style={styles.focusAccent} /><Text style={styles.focusTitle}>โฟกัสวันนี้</Text>{focusNotes.length ? focusNotes.map((note, index) => <Touchable accessibilityLabel={`เปิดโน้ต ${str(note, 'title')}`} key={str(note, 'id', String(index))} onPress={() => openNote(note)} style={styles.focusRow}><View style={styles.focusCheck}><MaterialIcon color="#fff" name="description" size={13} /></View><View style={{flex: 1}}><Text numberOfLines={1} style={styles.focusNoteTitle}>{str(note, 'title')}</Text><Text numberOfLines={1} style={styles.focusNoteSub}>{str(note, 'content', 'เตรียมอ่านและทบทวนเนื้อหา')}</Text></View><CompleteButton busy={completingId === str(note, 'id', '')} onPress={() => void markComplete(note)} /></Touchable>) : <View style={styles.focusEmpty}><MaterialIcon color={C.sage} name="task_alt" size={22} /><Text style={styles.focusNoteTitle}>ไม่มีโน้ตที่ค้างอยู่</Text></View>}</View>
      <View style={styles.aiRecommendation}><AiActivityRecommendationCard onNavigate={onNavigate} uid={uid} /></View>
      {planner ? <View accessibilityRole="tablist" style={styles.plannerTabs}>{([['calendar', 'ตาราง'], ['notes', 'โน้ต'], ['adaptive', 'Adaptive']] as [PlannerTab, string][]).map(([key, label]) => <Touchable accessibilityRole="tab" accessibilityState={{selected: planner.activeTab === key}} key={key} onPress={() => planner.onTabChange(key)} style={[styles.plannerTab, planner.activeTab === key && styles.plannerTabActive]}><Text style={[styles.plannerTabText, planner.activeTab === key && styles.plannerTabTextActive]}>{label}</Text></Touchable>)}</View> : null}
      <View style={styles.searchRow}>
        <MaterialIcon color="#8b948a" name="search" size={18} />
        <TextInput
          accessibilityLabel="ค้นหาโน้ต"
          onChangeText={(text) => { setSearch(text); }}
          placeholder="ค้นหาชื่อ เนื้อหา หรือแท็ก"
          placeholderTextColor="#9aa59a"
          style={styles.searchInput}
          value={search}
        />
        {search ? <Touchable accessibilityLabel="ล้างคำค้นหา" onPress={() => { setSearch(''); }}><MaterialIcon color="#8b948a" name="close" size={18} /></Touchable> : null}
      </View>
      {folders.length ? <View style={styles.folderRow}>
        <Touchable accessibilityLabel="โฟลเดอร์ทั้งหมด" onPress={() => { setFolderId(''); }} style={[styles.folderChip, !folderId && styles.folderChipActive]}>
          <Text style={[styles.folderChipText, !folderId && styles.folderChipTextActive]}>ทุกโฟลเดอร์</Text>
        </Touchable>
        {folders.map((folder) => (
          <Touchable accessibilityLabel={`กรองโฟลเดอร์ ${folder.name}`} key={folder.id} onPress={() => { setFolderId(folder.id === folderId ? '' : folder.id); }} style={[styles.folderChip, folderId === folder.id && styles.folderChipActive]}>
            <MaterialIcon color={folderId === folder.id ? '#fff' : '#6d786c'} name="folder" size={14} />
            <Text style={[styles.folderChipText, folderId === folder.id && styles.folderChipTextActive]}>{folder.name}</Text>
          </Touchable>
        ))}
      </View> : null}
      <View style={styles.tabs}>{tabs.map((tab) => <Touchable key={tab.page} onPress={() => { if (planner) setPlannerFilter(tab.value); else onNavigate(tab.page); }} style={[styles.tab, active.page === tab.page && styles.tabActive]}><Text style={[styles.tabText, active.page === tab.page && styles.tabTextActive]}>{tab.label}</Text></Touchable>)}</View>
      <View style={styles.metrics}><Metric label={active.value === 'all' ? 'กำลังทำ' : `โน้ต${active.label}`} value={notes.length} /><Metric color={C.pink} label="เสร็จแล้ว" value={completeCount} /><Metric label="ปักหมุด" value={importantCount} /></View>
      <View style={styles.sectionHead}><Text style={styles.sectionTitle}>{active.value === 'all' ? 'โน้ตล่าสุด' : `โน้ต${active.label}`}</Text><Touchable onPress={() => { if (planner) setPlannerFilter('all'); else onNavigate('smartlife_notes'); }}><Text style={styles.allLink}>ดูทั้งหมด</Text></Touchable></View>
      {!data ? <View style={styles.loading}><ActivityIndicator color={C.sage} size="large" /><Text style={styles.loadingText}>กำลังโหลดโน้ตจาก Firebase</Text></View> : <Animated.View layout={LinearTransition.duration(200)} style={styles.noteList}>{notes.length ? notes.map((note, index) => <NoteRow busy={completingId === str(note, 'id', '')} category={categoryOf(note, active.value)} index={index} item={note} key={str(note, 'id', String(index))} onComplete={() => void markComplete(note)} onOpen={() => openNote(note)} />) : <View style={styles.empty}><MaterialIcon color="#9aa59a" name={search || folderId ? 'search_off' : 'task_alt'} size={34} /><Text style={styles.emptyText}>{search || folderId ? 'ไม่พบโน้ตที่ตรงกับที่ค้นหา' : 'ไม่มีโน้ตที่ค้างอยู่ในหมวดนี้'}</Text></View>}</Animated.View>}
    </ScrollView><UserTabBar active={planner ? 'smartlife_planner' : 'smartlife_notes'} onNavigate={onNavigate} />
  </View></ResponsiveSafeArea>;
}

function Metric({label, value, color = C.ink}: {color?: string; label: string; value: number}) { return <View style={styles.metric}><Text style={[styles.metricValue, {color}]}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }

function CompleteButton({busy, onPress}: {busy: boolean; onPress: () => void}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({transform: [{scale: scale.value}]}));
  const handlePress = () => {
    scale.value = withSpring(0.82, {damping: 6, stiffness: 280}, () => {
      scale.value = withSpring(1, {damping: 8, stiffness: 200});
    });
    onPress();
  };
  return (
    <Touchable accessibilityLabel="ทำเครื่องหมายว่าเสร็จ" disabled={busy} onPress={handlePress} style={({pressed}) => [styles.completeButton, pressed && styles.pressed, busy && {opacity: .55}]}>
      <Animated.View style={[{alignItems: 'center', flexDirection: 'row', gap: 3}, animStyle]}>
        {busy ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={16} />}
        <Text style={styles.completeText}>เสร็จ</Text>
      </Animated.View>
    </Touchable>
  );
}

function NoteRow({busy, category, index, item, onComplete, onOpen}: {busy: boolean; category: 'study' | 'work' | 'idea' | 'personal' | 'all'; index: number; item: Item; onComplete: () => void; onOpen: () => void}) {
  const theme = category === 'work' ? {bg: C.pinkSoft, color: C.pink, icon: 'push_pin', label: 'งาน'} : category === 'idea' ? {bg: C.yellowSoft, color: C.yellow, icon: 'lightbulb', label: 'ไอเดีย'} : category === 'personal' ? {bg: '#eceeea', color: '#7d877b', icon: 'person_outline', label: 'ส่วนตัว'} : {bg: C.sageSoft, color: C.sage, icon: 'description', label: 'เรียน'};
  const title = str(item, 'title');
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index * 45, 180)).duration(220)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(200)} style={styles.noteRow}>
      <Touchable accessibilityLabel={`เปิดโน้ต ${title}`} accessibilityRole="button" onPress={onOpen} style={({pressed}) => [styles.noteOpenArea, pressed && styles.pressed]}>
        <View style={[styles.noteIcon, {backgroundColor: theme.bg}]}><MaterialIcon color={theme.color} name={theme.icon} size={19} /></View>
        <View style={{flex: 1}}>
          <View style={styles.noteTitleRow}>{item.pinned === true ? <MaterialIcon color="#c49497" name="push_pin" size={13} /> : null}{item.locked === true ? <MaterialIcon color="#8b948a" name="lock" size={13} /> : null}<Text numberOfLines={1} style={styles.noteTitle}>{title}</Text></View>
          <Text numberOfLines={1} style={styles.noteSub}>{str(item, 'content', `อัปเดต ${date(item.updatedAt ?? item.createdAt)}`)}</Text>
          <Text style={styles.noteCategory}>{theme.label}</Text>
        </View>
      </Touchable>
      <CompleteButton busy={busy} onPress={onComplete} />
    </Animated.View>
  );
}


const styles = StyleSheet.create({
  folderChip: {alignItems: 'center', backgroundColor: '#eef1eb', borderRadius: 99, flexDirection: 'row', gap: 5, paddingHorizontal: 11, paddingVertical: 7},
  folderChipActive: {backgroundColor: '#628660'},
  folderChipText: {color: '#6d786c', fontFamily: 'Prompt_700Bold', fontSize: 12},
  folderChipTextActive: {color: '#fff'},
  folderRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10},
  noteTitleRow: {alignItems: 'center', flexDirection: 'row', gap: 5},
  searchInput: {color: '#29351f', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, minHeight: 44},
  searchRow: {alignItems: 'center', backgroundColor: '#fff', borderColor: '#e3e8e0', borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 8, marginTop: 14, paddingHorizontal: 13},

  noteOpenArea: {alignItems: 'center', flex: 1, flexDirection: 'row', gap: 11},
  add: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 19, boxShadow: '0 7px 17px rgba(43,57,38,.08)', height: 48, justifyContent: 'center', width: 48}, aiRecommendation: {marginTop: 12}, allLink: {color: C.pink, fontFamily: F.b, fontSize: 12}, completeButton: {alignItems: 'center', backgroundColor: C.sage, borderRadius: 12, flexDirection: 'row', gap: 3, minHeight: 34, paddingHorizontal: 9}, completeText: {color: '#fff', fontFamily: F.b, fontSize: 12}, content: {padding: 20, paddingBottom: 28}, empty: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, gap: 7, paddingVertical: 30}, emptyText: {color: C.muted, fontFamily: F.r, fontSize: 12}, eyebrow: {color: C.sage, fontFamily: F.b, fontSize: 12}, focusAccent: {backgroundColor: '#f2e8e9', borderBottomLeftRadius: 80, height: 70, position: 'absolute', right: 0, top: 0, width: 66}, focusCard: {backgroundColor: '#fff', borderRadius: 21, marginTop: 12, overflow: 'hidden', padding: 15}, focusCheck: {alignItems: 'center', backgroundColor: C.pink, borderRadius: 9, height: 21, justifyContent: 'center', width: 21}, focusEmpty: {alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 10}, focusNoteSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1}, focusNoteTitle: {color: C.ink, fontFamily: F.b, fontSize: 12}, focusRow: {alignItems: 'center', flexDirection: 'row', gap: 9, marginTop: 8}, focusTitle: {color: C.ink, fontFamily: F.x, fontSize: 15}, header: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, loading: {alignItems: 'center', gap: 9, paddingVertical: 45}, loadingText: {color: C.muted, fontFamily: F.r, fontSize: 12}, metric: {backgroundColor: '#fff', borderRadius: 17, flex: 1, minHeight: 72, padding: 12}, metricLabel: {color: C.muted, fontFamily: F.s, fontSize: 12, marginTop: 3}, metricValue: {fontFamily: F.x, fontSize: 18}, metrics: {flexDirection: 'row', gap: 9, marginTop: 13}, noteCategory: {color: C.pink, fontFamily: F.b, fontSize: 12, marginTop: 3}, noteIcon: {alignItems: 'center', borderRadius: 13, height: 39, justifyContent: 'center', width: 39}, noteList: {gap: 9}, noteRow: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, flexDirection: 'row', gap: 10, minHeight: 66, padding: 11}, noteSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2}, noteTitle: {color: C.ink, fontFamily: F.b, fontSize: 12}, plannerTab: {alignItems: 'center', borderRadius: 12, flex: 1, paddingVertical: 9}, plannerTabActive: {backgroundColor: '#fff'}, plannerTabText: {color: C.muted, fontFamily: F.s, fontSize: 12}, plannerTabTextActive: {color: C.sage}, plannerTabs: {backgroundColor: '#e5ece1', borderRadius: 16, flexDirection: 'row', marginTop: 13, padding: 4}, pressed: {opacity: .8, transform: [{scale: .985}]}, safe: {backgroundColor: C.mist, flex: 1}, screen: {backgroundColor: C.mist, flex: 1}, sectionHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, marginTop: 16}, sectionTitle: {color: C.ink, fontFamily: F.x, fontSize: 14}, tab: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8}, tabActive: {backgroundColor: C.ink}, tabText: {color: C.muted, fontFamily: F.b, fontSize: 12}, tabTextActive: {color: '#fff'}, tabs: {flexDirection: 'row', gap: 7, marginTop: 13}, title: {color: C.ink, fontFamily: F.x, fontSize: 24},
});
