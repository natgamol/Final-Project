import {useCallback, useState} from 'react';
import {ActivityIndicator, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, Empty, Pill, Row, SmallButton, items, styles as ui, text} from '../admin-ui';
import type {AdminViewProps} from './view-props';
import ConfirmDialog from '@/components/confirm-dialog';
import {showToast} from '@/components/app-toast';

const EMPTY_FORM = {
  color: '#6F8F6D',
  domain: 'expense',
  icon: 'tag',
  labelEn: '',
  labelTh: '',
  sortOrder: '100',
};

export default function AdminCategoriesView({actionLoading, data, onAction}: AdminViewProps) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Asked with a Modal, not `Alert.alert`: the latter is an empty function on
  // react-native-web, so the admin portal's delete never prompted or fired.
  const [deleting, setDeleting] = useState<{id: string; title: string} | null>(null);

  const list = items(data.categories);
  const patch = (next: Partial<typeof EMPTY_FORM>) => setForm((current) => ({...current, ...next}));

  const reset = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }, []);

  const toggleForm = useCallback(() => {
    reset();
    setOpen((current) => !current);
  }, [reset]);

  const save = useCallback(async () => {
    if (!form.labelTh || !form.labelEn || !form.icon || !form.color) {
      showToast('ข้อมูลไม่ครบ', 'กรุณากรอกข้อมูลให้ครบถ้วน');
      return;
    }
    setSaving(true);
    const payload = {
      color: form.color,
      domain: form.domain,
      icon: form.icon,
      labelEn: form.labelEn,
      labelTh: form.labelTh,
      sortOrder: Number(form.sortOrder) || 100,
    };
    const succeeded = editingId
      ? await onAction('category-save', 'update-category', {...payload, id: editingId}, 'อัปเดตหมวดหมู่เรียบร้อย')
      : await onAction('category-save', 'create-category', payload, 'สร้างหมวดหมู่ใหม่เรียบร้อย');
    setSaving(false);
    if (succeeded) {
      reset();
      setOpen(false);
    }
  }, [editingId, form, onAction, reset]);

  return (
    <>
      <AdminCard style={ui.composer}>
        <Touchable onPress={toggleForm} style={ui.formToggle}>
          <MaterialIcon color={C.pine} name={open ? 'close' : 'add'} size={18} />
          <Text style={ui.formToggleText}>{open ? 'ปิดฟอร์ม' : 'เพิ่มหมวดหมู่ใหม่'}</Text>
        </Touchable>

        {open ? (
          <View style={{marginTop: 15}}>
            <Text style={ui.inputLabel}>Domain</Text>
            <View style={ui.pillRow}>
              <Pill label="โน้ต (note)" onPress={() => patch({domain: 'note'})} selected={form.domain === 'note'} />
              <Pill label="การเงิน (expense)" onPress={() => patch({domain: 'expense'})} selected={form.domain === 'expense'} />
              <Pill label="กิจกรรม (activity)" onPress={() => patch({domain: 'activity'})} selected={form.domain === 'activity'} />
            </View>
            <Text style={ui.inputLabel}>ชื่อภาษาไทย (labelTh)</Text>
            <TextInput onChangeText={(value) => patch({labelTh: value})} placeholder="เช่น อาหาร" style={ui.input} value={form.labelTh} />
            <Text style={ui.inputLabel}>English Label (labelEn)</Text>
            <TextInput onChangeText={(value) => patch({labelEn: value})} placeholder="e.g. Food" style={ui.input} value={form.labelEn} />
            <Text style={ui.inputLabel}>ไอคอน (Material Icons)</Text>
            <TextInput onChangeText={(value) => patch({icon: value})} placeholder="เช่น restaurant" style={ui.input} value={form.icon} />
            <Text style={ui.inputLabel}>สี (Hex Code)</Text>
            <TextInput onChangeText={(value) => patch({color: value})} placeholder="เช่น #E2796D" style={ui.input} value={form.color} />
            <Text style={ui.inputLabel}>ลำดับ (Sort Order)</Text>
            <TextInput keyboardType="numeric" onChangeText={(value) => patch({sortOrder: value})} style={ui.input} value={form.sortOrder} />
            <Touchable disabled={saving} onPress={save} style={({pressed}) => [ui.publishButton, (pressed || saving) && ui.pressed]}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="save" size={18} />}
              <Text style={ui.publishText}>{saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'สร้างหมวดหมู่'}</Text>
            </Touchable>
          </View>
        ) : null}
      </AdminCard>

      <AdminCard>
        {list.length ? list.map((item) => {
          const id = text(item.id);
          const colorHex = text(item.color, '#666');
          return (
            <Row
              detail={`${text(item.domain)} · ${text(item.labelEn)}`}
              icon={text(item.icon, 'sell')}
              key={id}
              title={text(item.labelTh)}
              tone={item.domain === 'note' ? 'rose' : item.domain === 'expense' ? 'purple' : 'green'}
            >
              <View style={[ui.actionRow, {alignItems: 'center'}]}>
                <View style={[ui.colorDot, {backgroundColor: colorHex, marginRight: 8}]} />
                <SmallButton
                  icon="edit"
                  label="แก้ไข"
                  onPress={() => {
                    setEditingId(id);
                    setForm({
                      color: colorHex,
                      domain: text(item.domain, 'expense'),
                      icon: text(item.icon, 'tag'),
                      labelEn: text(item.labelEn, ''),
                      labelTh: text(item.labelTh, ''),
                      sortOrder: String(item.sortOrder ?? 100),
                    });
                    setOpen(true);
                  }}
                  tone="amber"
                />
                <SmallButton
                  icon="delete"
                  label="ลบ"
                  loading={actionLoading === `${id}-del`}
                  onPress={() => setDeleting({id, title: text(item.labelTh)})}
                  tone="red"
                />
              </View>
            </Row>
          );
        }) : <Empty label="ยังไม่มีหมวดหมู่" />}
      <ConfirmDialog
        confirmLabel="ลบ"
        message={deleting ? `ต้องการลบหมวดหมู่ "${deleting.title}" ใช่หรือไม่?` : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { const target = deleting; setDeleting(null); if (target) onAction(`${target.id}-del`, 'delete-category', {id: target.id}, 'ลบหมวดหมู่แล้ว'); }}
        title="ยืนยันการลบ"
        visible={Boolean(deleting)}
      />
      </AdminCard>
    </>
  );
}
