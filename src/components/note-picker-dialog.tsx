import {useMemo, useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {MaterialIcon} from '@/screens/native/user/user-ui';
import type {Note, WithId} from '@/types/smartlife';

/**
 * Picks another note to link to.
 *
 * Searching is done here over the notes already loaded for the list, so it
 * costs no extra reads and behaves the same offline. That is also why linking
 * only reaches notes in the current page of 100 -- see the search note in the
 * notes screen.
 */
export default function NotePickerDialog({
  excludeId,
  notes,
  onCancel,
  onPick,
  visible,
}: {
  /** The note doing the linking, which must not link to itself. */
  excludeId?: string;
  notes: WithId<Note>[];
  onCancel: () => void;
  onPick: (note: WithId<Note>) => void;
  visible: boolean;
}) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter((note) => note.id !== excludeId)
      .filter((note) => !needle
        || String(note.title ?? '').toLowerCase().includes(needle)
        || String(note.content ?? '').toLowerCase().includes(needle))
      .slice(0, 50);
  }, [excludeId, notes, query]);

  return <Modal animationType="fade" onRequestClose={onCancel} statusBarTranslucent transparent visible={visible}>
    <Pressable accessibilityLabel="ปิดหน้าต่างเลือกโน้ต" onPress={onCancel} style={styles.overlay}>
      <View onStartShouldSetResponder={() => true} style={styles.card}>
        <Text style={styles.title}>เลือกโน้ตที่จะเชื่อม</Text>
        <View style={styles.searchRow}>
          <MaterialIcon color="#8b948a" name="search" size={18} />
          <TextInput
            accessibilityLabel="ค้นหาโน้ตที่จะเชื่อม"
            onChangeText={setQuery}
            placeholder="ค้นหาชื่อโน้ต"
            placeholderTextColor="#9aa39a"
            style={styles.search}
            value={query}
          />
        </View>

        <ScrollView style={styles.list}>
          {matches.length ? matches.map((note) => (
            <Touchable
              accessibilityLabel={`เชื่อมกับ ${String(note.title ?? '')}`}
              accessibilityRole="button"
              key={note.id}
              onPress={() => onPick(note)}
              style={({pressed}) => [styles.row, pressed && styles.pressed]}
            >
              <MaterialIcon color="#628660" name="description" size={18} />
              <View style={{flex: 1}}>
                <Text numberOfLines={1} style={styles.rowTitle}>{String(note.title ?? '')}</Text>
                <Text numberOfLines={1} style={styles.rowSub}>{String(note.content ?? '')}</Text>
              </View>
              <MaterialIcon color="#a8b0a6" name="add_link" size={18} />
            </Touchable>
          )) : <Text style={styles.empty}>{notes.length <= 1 ? 'ยังไม่มีโน้ตอื่นให้เชื่อม' : 'ไม่พบโน้ตที่ตรงกับคำค้นหา'}</Text>}
        </ScrollView>

        <Touchable accessibilityLabel="ยกเลิก" accessibilityRole="button" onPress={onCancel} style={styles.cancel}>
          <Text style={styles.cancelText}>ยกเลิก</Text>
        </Touchable>
      </View>
    </Pressable>
  </Modal>;
}

const styles = StyleSheet.create({
  cancel: {alignItems: 'center', backgroundColor: '#edf3e9', borderRadius: 16, justifyContent: 'center', marginTop: 12, minHeight: 48},
  cancelText: {color: '#4e694c', fontFamily: 'Prompt_700Bold', fontSize: 13},
  card: {backgroundColor: '#fbfcf7', borderRadius: 26, maxHeight: '80%', maxWidth: 460, padding: 20, width: '92%'},
  empty: {color: '#8b948a', fontFamily: 'Prompt_500Medium', fontSize: 12, paddingVertical: 24, textAlign: 'center'},
  list: {marginTop: 10, maxHeight: 320},
  overlay: {alignItems: 'center', backgroundColor: 'rgba(32, 40, 31, .58)', flex: 1, justifyContent: 'center', padding: 16},
  pressed: {opacity: .7},
  row: {alignItems: 'center', backgroundColor: '#f4f7f1', borderRadius: 14, flexDirection: 'row', gap: 10, marginTop: 8, minHeight: 56, paddingHorizontal: 12},
  rowSub: {color: '#8b948a', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1},
  rowTitle: {color: '#344131', fontFamily: 'Prompt_700Bold', fontSize: 12},
  search: {color: '#344131', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 13, minHeight: 46},
  searchRow: {alignItems: 'center', backgroundColor: '#f4f7f1', borderColor: '#dfe6dc', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, marginTop: 12, paddingHorizontal: 12},
  title: {color: '#344131', fontFamily: 'Prompt_800ExtraBold', fontSize: 18, textAlign: 'center'},
});
