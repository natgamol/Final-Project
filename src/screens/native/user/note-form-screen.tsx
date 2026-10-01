import {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import {Touchable} from '@/components/touchable';

import ConfirmDialog from '@/components/confirm-dialog';
import NotePickerDialog from '@/components/note-picker-dialog';
import NotePinDialog from '@/components/note-pin-dialog';
import {noteFolders as folderStore, notes as notesStore} from '@/services/firestore';
import {evaluateNoteBody} from '@/services/note-math';
import {getNoteLockState, setNotePin, verifyNotePin} from '@/services/note-lock';
import {uploadAndAnalyzeScan} from '@/services/ocr';
import type {Note, NoteCategory, NoteFolder, WithId} from '@/types/smartlife';
import {getNoteSuggestions, recommendationLevel, type NoteSuggestion} from '@/services/smartlife-recommendations';
import {MaterialIcon, UserShell, type UserNavigate} from './user-ui';
import {showToast} from '@/components/app-toast';

type FormMode = 'manual' | 'ai';
type PriorityValue = 'normal' | 'important' | 'urgent';
const categories: {label: string; value: NoteCategory}[] = [{label: 'เรียน', value: 'study'}, {label: 'งาน', value: 'work'}, {label: 'ไอเดีย', value: 'idea'}, {label: 'ส่วนตัว', value: 'personal'}];
const priorities = [
  {icon: 'radio_button_checked', label: 'ทั่วไป', value: 'normal'},
  {icon: 'priority_high', label: 'สำคัญ', value: 'important'},
  {icon: 'warning', label: 'เร่งด่วน', value: 'urgent'},
] as const;

/**
 * Creates a note, and -- when given a `noteId` -- edits an existing one.
 *
 * Editing had no screen at all before this: the notes list could only open a
 * blank creation form, so a saved note could never be reopened or changed.
 * Rather than a second near-identical screen, the same form loads the note and
 * switches its save path to `notes.update`.
 */
export default function NoteFormScreen({noteId, uid, onNavigate}: {noteId?: string; uid: string; onNavigate: UserNavigate}) {
  const editing = Boolean(noteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<NoteCategory>('study');
  const [priority, setPriority] = useState<PriorityValue>('normal');
  const [mode, setMode] = useState<FormMode>('manual');
  const [aiSuggestions, setAiSuggestions] = useState<NoteSuggestion[]>([]);
  const [loadingAiSuggestions, setLoadingAiSuggestions] = useState(!editing);
  const [saving, setSaving] = useState(false);
  // The load result is tagged with the id it belongs to, so "still loading"
  // and "not found" are derived rather than stored. Storing them as their own
  // flags left `missing` stuck on when this screen went from an edit URL to a
  // create URL without remounting, which pinned the empty state permanently.
  const [loaded, setLoaded] = useState<{found: boolean; id: string} | null>(null);
  const loadingNote = editing && loaded?.id !== noteId;
  const missing = editing && loaded?.id === noteId && !loaded?.found;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // --- v2 note fields ---
  const [folderId, setFolderId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const [locked, setLocked] = useState(false);
  const [linkedNoteIds, setLinkedNoteIds] = useState<string[]>([]);
  const [folders, setFolders] = useState<WithId<NoteFolder>[]>([]);
  const [allNotes, setAllNotes] = useState<WithId<Note>[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  // PIN gate: a locked note stays hidden until the right PIN is entered.
  const [pinMode, setPinMode] = useState<'set' | 'unlock' | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const mathLines = useMemo(() => evaluateNoteBody(content), [content]);
  const color = category === 'work' ? '#c49497' : category === 'idea' ? '#d3a957' : category === 'personal' ? '#859084' : '#628660';

  useEffect(() => {
    if (!noteId) return undefined;
    let active = true;
    notesStore.get(uid, noteId)
      .then((note) => {
        if (!active) return;
        if (note) {
          setTitle(typeof note.title === 'string' ? note.title : '');
          setContent(typeof note.content === 'string' ? note.content : '');
          if (note.category === 'study' || note.category === 'work' || note.category === 'idea' || note.category === 'personal') setCategory(note.category);
          if (note.priority === 'normal' || note.priority === 'important' || note.priority === 'urgent') setPriority(note.priority);
          setFolderId(typeof note.folderId === 'string' ? note.folderId : '');
          setTags(Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === 'string') : []);
          setPinned(note.pinned === true);
          setLocked(note.locked === true);
          setLinkedNoteIds(Array.isArray(note.linkedNoteIds) ? note.linkedNoteIds.filter((id): id is string => typeof id === 'string') : []);
        }
        setLoaded({found: Boolean(note), id: noteId});
      })
      .catch((error) => {
        if (!active) return;
        // A failed read is not the same as a missing note: report it and let
        // the form stay open rather than claiming the note is gone.
        setLoaded({found: true, id: noteId});
        showToast('เปิดโน้ตไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
      });
    return () => { active = false; };
  }, [noteId, uid]);

  // Folders and the note list back the folder chips and the link picker. Both
  // are small reads and failing either must not stop the note from opening.
  useEffect(() => {
    let active = true;
    folderStore.list(uid).then((items) => { if (active) setFolders(items); }).catch(() => undefined);
    notesStore.list(uid).then((items) => { if (active) setAllNotes(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [uid]);

  useEffect(() => {
    // Suggestions propose a *new* note, so they are irrelevant while editing.
    if (editing) return undefined;
    let active = true;
    getNoteSuggestions(uid)
      .then((items) => {
        if (active) setAiSuggestions(items);
      })
      .catch((error) => {
        console.error('[NoteForm] Load AI suggestions failed', error);
        if (active) setAiSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingAiSuggestions(false);
      });
    return () => {
      active = false;
    };
  }, [editing, uid]);

  const save = async () => {
    if (!title.trim()) return showToast('กรอกชื่อโน้ตก่อนบันทึก');
    setSaving(true);
    try {
      const extras = {
        folderId,
        linkedNoteIds,
        locked,
        pinned,
        tags,
      };
      if (noteId) {
        await notesStore.update(uid, noteId, {category, color, content, priority, title, ...extras});
        showToast('บันทึกการแก้ไขแล้ว', undefined, 'success');
      } else {
        await notesStore.create(uid, {
          category, color, content, priority, relatedScheduleId: '', status: 'pending', title, ...extras,
        });
        showToast('บันทึกโน้ตสำเร็จ', undefined, 'success');
      }
      onNavigate('smartlife_planner_notes');
    } catch (error) { showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง'); }
    finally { setSaving(false); }
  };

  const confirmDelete = async () => {
    if (!noteId) return;
    setDeleting(true);
    try {
      await notesStore.remove(uid, noteId);
      setDeleteOpen(false);
      showToast('ลบโน้ตแล้ว', undefined, 'success');
      onNavigate('smartlife_planner_notes');
    } catch (error) {
      setDeleting(false);
      showToast('ลบไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    }
  };
  const addTag = () => {
    const tag = tagDraft.trim().replace(/^#/, '');
    if (!tag) return;
    if (tags.length >= 20) { showToast('แท็กเต็มแล้ว', 'ใส่ได้สูงสุด 20 แท็กต่อโน้ต'); return; }
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagDraft('');
  };

  /**
   * Scans a document straight into the note body.
   *
   * Reuses the existing receipt/schedule OCR pipeline with `scanType: 'auto'`
   * and takes its `rawText`, so a general document does not need a new backend
   * path. Camera capture is Android-only; on web the picker opens a file
   * chooser, which is what a browser can offer.
   */
  const scanIntoNote = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) { showToast('ไม่ได้รับสิทธิ์', 'อนุญาตการเข้าถึงรูปภาพก่อนสแกน'); return; }
      }
      const picked = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], quality: 0.9});
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      const result = await uploadAndAnalyzeScan({scanType: 'auto', uid, uri: asset.uri});
      const scanned = String(result.rawText ?? '').trim();
      if (!scanned) { showToast('อ่านข้อความไม่ได้', 'ลองถ่ายให้ชัดขึ้นแล้วสแกนใหม่'); return; }
      setContent((current) => current.trim() ? `${current}\n\n${scanned}` : scanned);
      if (!title.trim()) setTitle('สแกนเมื่อ ' + new Date().toLocaleDateString('th-TH'));
      showToast('เพิ่มข้อความจากการสแกนแล้ว', undefined, 'success');
    } catch (error) {
      showToast('สแกนไม่สำเร็จ', error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setScanning(false);
    }
  };

  /** Turning the lock on requires a PIN to exist; turning it off does not. */
  const toggleLock = async () => {
    if (locked) { setLocked(false); return; }
    const state = await getNoteLockState(uid).catch(() => ({biometricEnabled: false, configured: false, hint: ''}));
    if (state.configured) { setLocked(true); showToast('โน้ตนี้จะถูกล็อก', 'กดบันทึกเพื่อยืนยัน', 'success'); return; }
    setPinError('');
    setPinMode('set');
  };

  const submitPin = async (pin: string) => {
    setPinBusy(true);
    setPinError('');
    try {
      if (pinMode === 'set') {
        await setNotePin(uid, pin);
        setLocked(true);
        setUnlocked(true);
        setPinMode(null);
        showToast('ตั้งรหัสแล้ว', 'โน้ตนี้จะถูกล็อกเมื่อบันทึก', 'success');
        return;
      }
      if (await verifyNotePin(uid, pin)) { setUnlocked(true); setPinMode(null); return; }
      setPinError('รหัสไม่ถูกต้อง');
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'ลองใหม่อีกครั้ง');
    } finally {
      setPinBusy(false);
    }
  };

  const applySuggestion = (suggestion: NoteSuggestion) => { setTitle(suggestion.title); setContent(`${suggestion.content}\n\nเหตุผลที่ AI เลือก: ${suggestion.reasons.join(', ')}`); setCategory(suggestion.category); setPriority(suggestion.score >= 80 ? 'urgent' : suggestion.score >= 60 ? 'important' : 'normal'); setMode('manual'); };

  // A locked note stays hidden until the PIN is entered. The gate is opened
  // automatically once, rather than in an effect, so it cannot loop.
  if (editing && locked && !unlocked && pinMode === null) setPinMode('unlock');

  if (editing && locked && !unlocked) {
    return <UserShell active="smartlife_notes" onNavigate={onNavigate}>
      <View style={styles.loadingState}>
        <MaterialIcon color="#628660" name="lock" size={34} />
        <Text style={styles.loadingText}>โน้ตนี้ถูกล็อกไว้</Text>
        <Touchable accessibilityLabel="ใส่รหัสเพื่อเปิด" onPress={() => setPinMode('unlock')} style={styles.backToNotes}><Text style={styles.backToNotesText}>ใส่รหัสเพื่อเปิด</Text></Touchable>
        <Touchable accessibilityLabel="กลับไปหน้าโน้ต" onPress={() => onNavigate('smartlife_planner_notes')}><Text style={styles.loadingText}>กลับไปหน้าโน้ต</Text></Touchable>
      </View>
      <NotePinDialog busy={pinBusy} error={pinError} mode="unlock" onCancel={() => setPinMode(null)} onSubmit={(pin) => void submitPin(pin)} visible={pinMode === 'unlock'} />
    </UserShell>;
  }

  if (loadingNote) {
    return <UserShell active="smartlife_notes" onNavigate={onNavigate}>
      <View style={styles.loadingState}><ActivityIndicator color="#628660" size="large" /><Text style={styles.loadingText}>กำลังเปิดโน้ต...</Text></View>
    </UserShell>;
  }

  if (missing) {
    return <UserShell active="smartlife_notes" onNavigate={onNavigate}>
      <View style={styles.loadingState}>
        <MaterialIcon color="#8d968b" name="search_off" size={34} />
        <Text style={styles.loadingText}>ไม่พบโน้ตนี้ อาจถูกลบไปแล้ว</Text>
        <Touchable onPress={() => onNavigate('smartlife_planner_notes')} style={styles.backToNotes}><Text style={styles.backToNotesText}>กลับไปหน้าโน้ต</Text></Touchable>
      </View>
    </UserShell>;
  }

  return <UserShell active="smartlife_notes" onNavigate={onNavigate}>
    <View style={styles.page}>
      {/* Refactored UI: note creation supports a manual form and a review-before-save AI suggestion view. */}
      <View style={styles.header}><Touchable accessibilityLabel="ปิด" onPress={() => onNavigate('smartlife_planner_notes')} style={styles.headerButton}><MaterialIcon color="#364033" name="close" size={24} /></Touchable><View style={styles.headerCopy}><Text style={styles.eyebrow}>SMARTLIFE NOTES</Text><Text style={styles.title}>{editing ? 'แก้ไขโน้ต' : mode === 'ai' ? 'AI แนะนำโน้ต' : 'โน้ตใหม่'}</Text></View>
      {editing ? <Touchable accessibilityLabel="ลบโน้ต" onPress={() => setDeleteOpen(true)} style={styles.headerButton}><MaterialIcon color="#a95758" name="delete" size={22} /></Touchable> : null}<Touchable accessibilityLabel="บันทึกโน้ต" disabled={saving || !title.trim()} onPress={save} style={[styles.noteDone, (saving || !title.trim()) && styles.disabled]}>{saving ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={23} />}</Touchable></View>
      {editing ? null : <View style={styles.noteModeToggle}><Touchable onPress={() => setMode('manual')} style={[styles.mode, mode === 'manual' && styles.noteModeActive]}><MaterialIcon color={mode === 'manual' ? '#fff' : '#758274'} name="edit_note" size={17} /><Text style={[styles.modeText, mode === 'manual' && styles.modeTextActive]}>เขียนโน้ต</Text></Touchable><Touchable onPress={() => setMode('ai')} style={[styles.mode, mode === 'ai' && styles.noteModeActive]}><MaterialIcon color={mode === 'ai' ? '#fff' : '#758274'} name="auto_awesome" size={17} /><Text style={[styles.modeText, mode === 'ai' && styles.modeTextActive]}>AI แนะนำ</Text></Touchable></View>}
      {mode === 'ai' ? <AiSuggestionList loading={loadingAiSuggestions} onUse={applySuggestion} suggestions={aiSuggestions} /> : <>
        {editing ? null : <View style={styles.aiTeaser}><LinearGradient colors={['#c88d91', '#d7a8aa']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} /><Text style={styles.aiTeaserTitle}>✦ &nbsp;AI แนะนำโน้ตได้</Text><Text style={styles.aiTeaserText}>ดูจากตารางเรียน งาน และโน้ตเดิมใน Firebase เพื่อช่วยเรียบโน้ตได้เร็วขึ้น</Text><View style={styles.teaserRows}>{loadingAiSuggestions ? <ActivityIndicator color="#fff" /> : aiSuggestions.slice(0, 2).map((suggestion) => <Touchable key={suggestion.title} onPress={() => applySuggestion(suggestion)} style={styles.teaserRow}><View style={styles.teaserIcon}><MaterialIcon color="#fff" name="description" size={16} /></View><View style={{flex: 1}}><Text style={styles.teaserTitle}>{suggestion.title}</Text><Text style={styles.teaserSub}>{suggestion.detail}</Text></View><MaterialIcon color="#fff" name="chevron_right" size={18} /></Touchable>)}</View></View>}
        <View style={styles.formCard}><Text style={styles.label}>ชื่อโน้ต</Text><TextInput onChangeText={setTitle} placeholder="เช่น สรุปบทที่ 4" placeholderTextColor="#8d968b" style={styles.input} value={title} />
          <Text style={styles.label}>หมวดหมู่</Text><View style={styles.categoryRow}>{categories.map((item) => <Touchable key={item.value} onPress={() => setCategory(item.value)} style={[styles.category, category === item.value && {backgroundColor: color}]}><Text style={[styles.categoryText, category === item.value && styles.categoryTextActive]}>{item.label}</Text></Touchable>)}</View>
          <Text style={styles.label}>ความสำคัญ</Text><View style={styles.priorityRow}>{priorities.map((item) => <Touchable accessibilityLabel={`เลือกความสำคัญ ${item.label}`} accessibilityRole="button" accessibilityState={{selected: priority === item.value}} key={item.value} onPress={() => setPriority(item.value)} style={[styles.notePriority, priority === item.value && styles.notePriorityActive]}><MaterialIcon color={priority === item.value ? '#fff' : '#bd8185'} name={item.icon} size={16} /><Text style={[styles.notePriorityText, priority === item.value && styles.priorityTextActive]}>{item.label}</Text></Touchable>)}</View>
          <View style={styles.bodyHead}>
            <Text style={styles.label}>รายละเอียด</Text>
            <Touchable accessibilityLabel="สแกนเอกสารเข้าโน้ต" disabled={scanning} onPress={() => void scanIntoNote()} style={[styles.scanButton, scanning && styles.disabled]}>
              {scanning ? <ActivityIndicator color="#5f875f" size="small" /> : <MaterialIcon color="#5f875f" name="document_scanner" size={16} />}
              <Text style={styles.scanButtonText}>{scanning ? 'กำลังสแกน...' : 'สแกนเข้าโน้ต'}</Text>
            </Touchable>
          </View>
          <TextInput multiline onChangeText={setContent} placeholder={'หัวข้อที่ต้องสรุป:\n- Recursion คืออะไร\n- Stack ทำงานอย่างไร\n- ตัวอย่างโจทย์ที่ควรฝึกก่อนควิซ'} placeholderTextColor="#748074" style={styles.content} textAlignVertical="top" value={content} />

          {/* Arithmetic typed into the body, calculated live. Lines that are
              not calculations are simply absent from this list. */}
          {mathLines.length ? <View style={styles.mathCard}>
            <View style={styles.mathHead}><MaterialIcon color="#5f875f" name="calculate" size={16} /><Text style={styles.mathTitle}>ผลคำนวณจากโน้ต</Text></View>
            {mathLines.map((item) => (
              <View key={`${item.line}-${item.expression}`} style={styles.mathRow}>
                <Text numberOfLines={1} style={styles.mathExpression}>{item.expression}</Text>
                <Text style={styles.mathResult}>= {item.result}</Text>
              </View>
            ))}
          </View> : null}

          <Text style={styles.label}>โฟลเดอร์</Text>
          <View style={styles.categoryRow}>
            <Touchable accessibilityLabel="ไม่ใส่โฟลเดอร์" onPress={() => setFolderId('')} style={[styles.category, !folderId && {backgroundColor: color}]}>
              <Text style={[styles.categoryText, !folderId && styles.categoryTextActive]}>ไม่ระบุ</Text>
            </Touchable>
            {folders.map((folder) => (
              <Touchable accessibilityLabel={`โฟลเดอร์ ${folder.name}`} key={folder.id} onPress={() => setFolderId(folder.id)} style={[styles.category, folderId === folder.id && {backgroundColor: color}]}>
                <Text style={[styles.categoryText, folderId === folder.id && styles.categoryTextActive]}>{folder.name}</Text>
              </Touchable>
            ))}
          </View>

          <Text style={styles.label}>แท็ก</Text>
          <View style={styles.tagInputRow}>
            <TextInput
              accessibilityLabel="ช่องเพิ่มแท็ก"
              onChangeText={setTagDraft}
              onSubmitEditing={addTag}
              placeholder="เช่น ควิซ, สอบกลางภาค"
              placeholderTextColor="#8d968b"
              style={styles.tagInput}
              value={tagDraft}
            />
            <Touchable accessibilityLabel="เพิ่มแท็ก" onPress={addTag} style={styles.tagAdd}><MaterialIcon color="#fff" name="add" size={18} /></Touchable>
          </View>
          {tags.length ? <View style={styles.categoryRow}>{tags.map((tag) => (
            <Touchable accessibilityLabel={`ลบแท็ก ${tag}`} key={tag} onPress={() => setTags(tags.filter((item) => item !== tag))} style={styles.tagChip}>
              <Text style={styles.tagChipText}>#{tag}</Text>
              <MaterialIcon color="#5f795d" name="close" size={13} />
            </Touchable>
          ))}</View> : null}

          <Text style={styles.label}>เชื่อมกับโน้ตอื่น</Text>
          {linkedNoteIds.length ? linkedNoteIds.map((id) => {
            const linked = allNotes.find((item) => item.id === id);
            return <View key={id} style={styles.linkRow}>
              <MaterialIcon color="#628660" name="link" size={16} />
              <Touchable accessibilityLabel={`เปิดโน้ตที่เชื่อม ${linked ? String(linked.title ?? '') : id}`} onPress={() => onNavigate(`smartlife_add_note?id=${encodeURIComponent(id)}`)} style={{flex: 1}}>
                <Text numberOfLines={1} style={styles.linkText}>{linked ? String(linked.title ?? '') : 'โน้ตที่ถูกลบไปแล้ว'}</Text>
              </Touchable>
              <Touchable accessibilityLabel={`ยกเลิกการเชื่อม ${linked ? String(linked.title ?? '') : id}`} onPress={() => setLinkedNoteIds(linkedNoteIds.filter((item) => item !== id))}>
                <MaterialIcon color="#b58184" name="link_off" size={16} />
              </Touchable>
            </View>;
          }) : null}
          <Touchable accessibilityLabel="เลือกโน้ตที่จะเชื่อม" onPress={() => setPickerOpen(true)} style={styles.linkAdd}>
            <MaterialIcon color="#5f875f" name="add_link" size={17} />
            <Text style={styles.linkAddText}>เชื่อมโน้ตอื่น</Text>
          </Touchable>

          <View style={styles.toggleRow}>
            <Touchable accessibilityLabel="ปักหมุดโน้ต" accessibilityRole="switch" accessibilityState={{checked: pinned}} onPress={() => setPinned(!pinned)} style={[styles.toggle, pinned && styles.toggleActive]}>
              <MaterialIcon color={pinned ? '#fff' : '#758274'} name="push_pin" size={16} />
              <Text style={[styles.toggleText, pinned && styles.toggleTextActive]}>ปักหมุด</Text>
            </Touchable>
            <Touchable accessibilityLabel="ล็อกโน้ตด้วยรหัส" accessibilityRole="switch" accessibilityState={{checked: locked}} onPress={() => void toggleLock()} style={[styles.toggle, locked && styles.toggleActive]}>
              <MaterialIcon color={locked ? '#fff' : '#758274'} name={locked ? 'lock' : 'lock_open'} size={16} />
              <Text style={[styles.toggleText, locked && styles.toggleTextActive]}>{locked ? 'ล็อกอยู่' : 'ล็อกโน้ต'}</Text>
            </Touchable>
          </View>
        </View><Touchable disabled={saving || !title.trim()} onPress={save} style={[styles.saveShell, (saving || !title.trim()) && styles.disabled]}><LinearGradient colors={['#c48a8e', '#b97b7f']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.save}>{saving ? <ActivityIndicator color="#fff" /> : <MaterialIcon color="#fff" name="check" size={19} />}<Text style={styles.saveText}>{saving ? 'กำลังบันทึก...' : 'บันทึกโน้ต'}</Text></LinearGradient></Touchable>
      </>}
      <NotePickerDialog
        excludeId={noteId}
        notes={allNotes}
        onCancel={() => setPickerOpen(false)}
        onPick={(note) => {
          setPickerOpen(false);
          if (linkedNoteIds.includes(note.id)) return;
          if (linkedNoteIds.length >= 50) { showToast('เชื่อมได้สูงสุด 50 โน้ต'); return; }
          setLinkedNoteIds([...linkedNoteIds, note.id]);
        }}
        visible={pickerOpen}
      />
      <NotePinDialog
        busy={pinBusy}
        error={pinError}
        mode={pinMode === 'set' ? 'set' : 'unlock'}
        onCancel={() => { setPinMode(null); setPinError(''); }}
        onSubmit={(pin) => void submitPin(pin)}
        visible={pinMode !== null}
      />
      <ConfirmDialog
        busy={deleting}
        confirmLabel="ลบโน้ต"
        message={`"${title || 'โน้ตนี้'}" จะถูกลบออกจากบัญชีของคุณ`}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDelete()}
        title="ลบโน้ตนี้?"
        visible={deleteOpen}
      />
    </View>
  </UserShell>;
}

function AiSuggestionList({loading, onUse, suggestions}: {loading: boolean; onUse: (suggestion: NoteSuggestion) => void; suggestions: NoteSuggestion[]}) {
  const importantCount = suggestions.filter((suggestion) => suggestion.score >= 70).length;
  return <View style={styles.aiArea}>
    <LinearGradient colors={['#c88d91', '#d7a8aa']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.aiHero}>
      <Text style={styles.aiHeroTitle}>✦ &nbsp;AI วิเคราะห์จากวันนี้</Text>
      <Text style={styles.aiHeroText}>ระบบดึงตารางเรียน งาน และโน้ตเดิมจาก Firebase แล้วให้คะแนนจากความใกล้กำหนด ความสำคัญ และคำสำคัญ</Text>
    </LinearGradient>
    <View style={styles.aiStats}><Stat label="คำแนะนำ" value={`${suggestions.length} โน้ต`} /><Stat color="#c48a8e" label="สำคัญมาก" value={`${importantCount} รายการ`} /></View>
    {loading ? <View style={styles.emptyAi}><ActivityIndicator color="#bd8185" /><Text style={styles.noteEmptyAiText}>กำลังวิเคราะห์ข้อมูลจาก Firebase...</Text></View> : null}
    {!loading && suggestions.length === 0 ? <View style={styles.emptyAi}><MaterialIcon color="#9b7477" name="info" size={20} /><Text style={styles.noteEmptyAiText}>ยังไม่มีข้อมูลพอให้ AI แนะนำโน้ต ลองเพิ่มตารางเรียน งาน หรือโน้ตเดิมก่อน</Text></View> : null}
    {!loading && suggestions.map((suggestion) => <View key={suggestion.title} style={styles.suggestionCard}>
      <View style={styles.suggestionHead}><View style={styles.noteSuggestionIcon}><MaterialIcon color="#c48a8e" name="description" size={18} /></View><View style={{flex: 1}}><Text style={styles.suggestionTitle}>{suggestion.title}</Text><Text style={styles.suggestionSub}>{suggestion.detail}</Text></View><View style={styles.noteScoreBadge}><Text style={styles.noteScoreBadgeText}>{recommendationLevel(suggestion.score)}</Text></View></View>
      <Text style={styles.suggestionContent}>{suggestion.content}</Text>
      <View style={styles.reasonRow}>{suggestion.reasons.slice(0, 3).map((reason) => <View key={reason} style={styles.noteReasonChip}><Text style={styles.noteReasonChipText}>{reason}</Text></View>)}</View>
      <Touchable onPress={() => onUse(suggestion)} style={styles.noteUseButton}><MaterialIcon color="#fff" name="check" size={17} /><Text style={styles.useButtonText}>ใช้คำแนะนำนี้</Text></Touchable>
    </View>)}
  </View>;
}
function Stat({label, value, color = '#354033'}: {color?: string; label: string; value: string}) { return <View style={styles.stat}><Text style={[styles.statValue, {color}]}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>; }

const styles = StyleSheet.create({
  aiArea: {gap: 10, marginTop: 14}, bodyHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'}, linkAdd: {alignItems: 'center', backgroundColor: '#eef4ea', borderRadius: 12, flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 8, minHeight: 40}, linkAddText: {color: '#5f875f', fontFamily: 'Prompt_700Bold', fontSize: 12}, linkRow: {alignItems: 'center', backgroundColor: '#f5f8f2', borderRadius: 12, flexDirection: 'row', gap: 8, marginTop: 7, minHeight: 42, paddingHorizontal: 11}, linkText: {color: '#41513f', fontFamily: 'Prompt_600SemiBold', fontSize: 12}, mathCard: {backgroundColor: '#f2f7ef', borderColor: '#dde8d8', borderRadius: 14, borderWidth: 1, marginTop: 10, padding: 11}, mathExpression: {color: '#687566', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12}, mathHead: {alignItems: 'center', flexDirection: 'row', gap: 6, marginBottom: 6}, mathResult: {color: '#41643f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12}, mathRow: {alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between', minHeight: 26}, mathTitle: {color: '#5f875f', fontFamily: 'Prompt_700Bold', fontSize: 12}, scanButton: {alignItems: 'center', backgroundColor: '#eef4ea', borderRadius: 11, flexDirection: 'row', gap: 5, marginTop: 13, paddingHorizontal: 10, paddingVertical: 7}, scanButtonText: {color: '#5f875f', fontFamily: 'Prompt_700Bold', fontSize: 12}, tagAdd: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 12, height: 44, justifyContent: 'center', width: 44}, tagChip: {alignItems: 'center', backgroundColor: '#eaf2e6', borderRadius: 99, flexDirection: 'row', gap: 5, paddingHorizontal: 10, paddingVertical: 6}, tagChipText: {color: '#5f795d', fontFamily: 'Prompt_700Bold', fontSize: 12}, tagInput: {backgroundColor: '#f8faf6', borderColor: '#e1e6de', borderRadius: 12, borderWidth: 1, color: '#344033', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, minHeight: 44, paddingHorizontal: 12}, tagInputRow: {alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 8}, toggle: {alignItems: 'center', backgroundColor: '#f0f4ed', borderColor: '#e1e7df', borderRadius: 12, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 44}, toggleActive: {backgroundColor: '#5f875f', borderColor: '#5f875f'}, toggleRow: {flexDirection: 'row', gap: 8, marginTop: 14}, toggleText: {color: '#657264', fontFamily: 'Prompt_700Bold', fontSize: 12}, toggleTextActive: {color: '#fff'}, backToNotes: {backgroundColor: '#5f875f', borderRadius: 13, marginTop: 4, paddingHorizontal: 16, paddingVertical: 10}, backToNotesText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12}, loadingState: {alignItems: 'center', gap: 12, justifyContent: 'center', minHeight: 320, padding: 24}, loadingText: {color: '#667365', fontFamily: 'Prompt_500Medium', fontSize: 12, textAlign: 'center'}, aiHero: {borderRadius: 20, padding: 16}, aiHeroText: {color: 'rgba(255,255,255,.9)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 5}, aiHeroTitle: {color: '#fff', fontFamily: 'Prompt_800ExtraBold', fontSize: 16}, aiStats: {flexDirection: 'row', gap: 9}, aiTeaser: {borderRadius: 20, marginTop: 14, overflow: 'hidden', padding: 16}, aiTeaserText: {color: 'rgba(255,255,255,.88)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 3}, aiTeaserTitle: {color: '#fff', fontFamily: 'Prompt_800ExtraBold', fontSize: 16}, category: {backgroundColor: '#eef1eb', borderRadius: 99, paddingHorizontal: 11, paddingVertical: 7}, categoryRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8}, categoryText: {color: '#778177', fontFamily: 'Prompt_700Bold', fontSize: 12}, categoryTextActive: {color: '#fff'}, content: {backgroundColor: '#f8faf6', borderColor: '#e1e6de', borderRadius: 15, borderWidth: 1, color: '#344033', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, minHeight: 142, padding: 13}, disabled: {opacity: .5}, done: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 21, boxShadow: '0 8px 17px rgba(70,100,65,.2)', height: 44, justifyContent: 'center', width: 44}, emptyAi: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 18, gap: 8, justifyContent: 'center', minHeight: 86, padding: 14}, emptyAiText: {color: '#5f725e', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, textAlign: 'center'}, eyebrow: {color: '#698667', fontFamily: 'Prompt_700Bold', fontSize: 12, letterSpacing: .6}, formCard: {backgroundColor: '#fff', borderRadius: 22, boxShadow: '0 8px 20px rgba(42,58,42,.07)', marginTop: 14, padding: 15}, header: {alignItems: 'center', flexDirection: 'row', gap: 10}, headerButton: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 21, boxShadow: '0 6px 15px rgba(42,58,42,.07)', height: 44, justifyContent: 'center', width: 44}, headerCopy: {flex: 1}, input: {backgroundColor: '#f8faf6', borderColor: '#e1e6de', borderRadius: 15, borderWidth: 1, color: '#344033', fontFamily: 'Prompt_700Bold', fontSize: 15, minHeight: 51, paddingHorizontal: 13}, label: {color: '#667365', fontFamily: 'Prompt_700Bold', fontSize: 12, marginBottom: 6, marginTop: 13}, mode: {alignItems: 'center', borderRadius: 14, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 41}, modeActive: {backgroundColor: '#5f875f'}, modeText: {color: '#758274', fontFamily: 'Prompt_700Bold', fontSize: 12}, modeTextActive: {color: '#fff'}, modeToggle: {backgroundColor: '#e8eee5', borderRadius: 18, flexDirection: 'row', marginTop: 13, padding: 4}, page: {paddingBottom: 5}, priority: {alignItems: 'center', backgroundColor: '#f0f4ed', borderColor: '#e1e7df', borderRadius: 12, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 42}, priorityActive: {backgroundColor: '#5f875f', borderColor: '#5f875f'}, priorityRow: {flexDirection: 'row', gap: 7}, priorityText: {color: '#657264', fontFamily: 'Prompt_700Bold', fontSize: 12}, priorityTextActive: {color: '#fff'}, reasonChip: {backgroundColor: '#eaf2e6', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4}, reasonChipText: {color: '#5f795d', fontFamily: 'Prompt_700Bold', fontSize: 12}, reasonRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 9}, save: {alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 50}, saveShell: {borderRadius: 16, marginTop: 14, overflow: 'hidden'}, saveText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 13}, scoreBadge: {alignItems: 'center', backgroundColor: '#eaf2e6', borderRadius: 99, minWidth: 33, paddingHorizontal: 8, paddingVertical: 4}, scoreBadgeText: {color: '#5f875f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12}, stat: {backgroundColor: '#fff', borderRadius: 17, flex: 1, padding: 13}, statLabel: {color: '#8b938a', fontFamily: 'Prompt_600SemiBold', fontSize: 12, marginTop: 2}, statValue: {fontFamily: 'Prompt_800ExtraBold', fontSize: 17}, suggestionCard: {backgroundColor: '#fff', borderRadius: 20, boxShadow: '0 6px 17px rgba(42,58,42,.07)', padding: 13}, suggestionContent: {backgroundColor: '#f5f7f2', borderRadius: 13, color: '#667066', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 10, padding: 10}, suggestionHead: {alignItems: 'center', flexDirection: 'row', gap: 10}, suggestionIcon: {alignItems: 'center', backgroundColor: '#eaf2e6', borderRadius: 13, height: 39, justifyContent: 'center', width: 39}, suggestionSub: {color: '#8a938a', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1}, suggestionTitle: {color: '#354033', fontFamily: 'Prompt_800ExtraBold', fontSize: 12}, teaserIcon: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.22)', borderRadius: 11, height: 34, justifyContent: 'center', width: 34}, teaserRow: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.18)', borderRadius: 13, flexDirection: 'row', gap: 9, marginTop: 9, padding: 8}, teaserRows: {marginTop: 10}, teaserSub: {color: 'rgba(255,255,255,.78)', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1}, teaserTitle: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12}, title: {color: '#354033', fontFamily: 'Prompt_800ExtraBold', fontSize: 21}, useButton: {alignItems: 'center', backgroundColor: '#5f875f', borderRadius: 11, flexDirection: 'row', gap: 5, justifyContent: 'center', marginTop: 10, minHeight: 36}, useButtonText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  noteDone: {alignItems: 'center', backgroundColor: '#bd8185', borderRadius: 21, boxShadow: '0 8px 17px rgba(136,82,87,.18)', height: 44, justifyContent: 'center', width: 44},
  noteEmptyAiText: {color: '#7d6264', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, textAlign: 'center'},
  noteModeActive: {backgroundColor: '#762729'},
  noteModeToggle: {backgroundColor: '#fff', borderRadius: 18, flexDirection: 'row', marginTop: 13, padding: 4},
  notePriority: {alignItems: 'center', backgroundColor: '#fbf3f4', borderColor: '#efdadd', borderRadius: 12, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 42},
  notePriorityActive: {backgroundColor: '#bd8185', borderColor: '#bd8185'},
  notePriorityText: {color: '#8f696c', fontFamily: 'Prompt_700Bold', fontSize: 12},
  noteReasonChip: {backgroundColor: '#f7e9e9', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4},
  noteReasonChipText: {color: '#9b696d', fontFamily: 'Prompt_700Bold', fontSize: 12},
  noteScoreBadge: {alignItems: 'center', backgroundColor: '#f7e9e9', borderRadius: 99, minWidth: 33, paddingHorizontal: 8, paddingVertical: 4},
  noteScoreBadgeText: {color: '#bd8185', fontFamily: 'Prompt_800ExtraBold', fontSize: 12},
  noteSuggestionIcon: {alignItems: 'center', backgroundColor: '#f7e9e9', borderRadius: 13, height: 39, justifyContent: 'center', width: 39},
  noteUseButton: {alignItems: 'center', backgroundColor: '#bd8185', borderRadius: 11, flexDirection: 'row', gap: 5, justifyContent: 'center', marginTop: 10, minHeight: 36},
});
