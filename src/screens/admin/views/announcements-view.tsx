import {useCallback, useState} from 'react';
import {ActivityIndicator, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {MaterialIcon} from '@/screens/native/user/user-ui';
import {AdminCard, C, Empty, KindBadge, Pill, Row, SectionHead, SmallButton, date, items, styles as ui, text} from '../admin-ui';
import type {AdminViewProps} from './view-props';
import ConfirmDialog from '@/components/confirm-dialog';
import {showToast} from '@/components/app-toast';

const KIND_BADGES: Record<string, [string, string]> = {
  feature: ['ฟีเจอร์', 'purple'],
  maintenance: ['ปิดปรับปรุง', 'amber'],
  update: ['อัปเดต', 'green'],
  urgent: ['เร่งด่วน', 'red'],
};

export default function AdminAnnouncementsView({actionLoading, data, onAction}: AdminViewProps) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState('update');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  // Asked with a Modal, not `Alert.alert`: the latter is an empty function on
  // react-native-web, so the admin portal's delete never prompted or fired.
  const [deleting, setDeleting] = useState<{id: string; title: string} | null>(null);

  const list = items(data.announcements);

  const reset = useCallback(() => {
    setEditingId(null);
    setTitle('');
    setMessage('');
    setKind('update');
  }, []);

  const publish = useCallback(async () => {
    const nextTitle = title.trim();
    const nextMessage = message.trim();
    if (!nextTitle || !nextMessage) {
      showToast('กรอกข้อมูลไม่ครบ', 'กรุณาระบุหัวข้อและรายละเอียดประกาศ');
      return;
    }
    setPublishing(true);
    const succeeded = editingId
      ? await onAction('announcement-save', 'update-announcement', {id: editingId, kind, message: nextMessage, title: nextTitle}, 'การแก้ไขถูกบันทึกเรียบร้อย')
      : await onAction('announcement-save', 'create-announcement', {kind, message: nextMessage, title: nextTitle}, 'ประกาศถูกบันทึกใน Firebase และพร้อมแสดงแก่ผู้ใช้');
    setPublishing(false);
    if (succeeded) reset();
  }, [editingId, kind, message, onAction, reset, title]);

  return (
    <>
      <AdminCard style={ui.composer}>
        <View style={ui.composerHead}>
          <View style={ui.composerIcon}><MaterialIcon color={C.sage} name="campaign" size={21} /></View>
          <View style={{flex: 1}}>
            <Text style={ui.sectionTitle}>{editingId ? 'แก้ไขประกาศ' : 'สร้างประกาศ'}</Text>
            <Text style={ui.sectionMeta}>ส่งถึงผู้ใช้ทุกคนผ่าน Firebase</Text>
          </View>
          {editingId ? (
            <Touchable accessibilityLabel="ยกเลิกการแก้ไข" onPress={reset}>
              <MaterialIcon color={C.red} name="close" size={20} />
            </Touchable>
          ) : null}
        </View>

        <Text style={ui.inputLabel}>ประเภทประกาศ</Text>
        <View style={ui.pillRow}>
          <Pill label="อัปเดต" onPress={() => setKind('update')} selected={kind === 'update'} />
          <Pill color={C.amber} label="ปิดปรับปรุง" onPress={() => setKind('maintenance')} selected={kind === 'maintenance'} />
          <Pill color="#6572b1" label="ฟีเจอร์" onPress={() => setKind('feature')} selected={kind === 'feature'} />
          <Pill color={C.red} label="เร่งด่วน" onPress={() => setKind('urgent')} selected={kind === 'urgent'} />
        </View>

        <Text style={ui.inputLabel}>หัวข้อประกาศ</Text>
        <TextInput
          editable={!publishing}
          onChangeText={setTitle}
          placeholder="เช่น แจ้งปิดปรับปรุงระบบ"
          placeholderTextColor="#a6ada3"
          style={ui.input}
          value={title}
        />

        <Text style={ui.inputLabel}>รายละเอียด</Text>
        <TextInput
          editable={!publishing}
          multiline
          onChangeText={setMessage}
          placeholder="พิมพ์รายละเอียดที่ต้องการสื่อสาร"
          placeholderTextColor="#a6ada3"
          style={[ui.input, ui.messageInput]}
          textAlignVertical="top"
          value={message}
        />

        <View style={ui.audience}>
          <MaterialIcon color={C.sage} name="group" size={18} />
          <Text style={ui.audienceText}>ผู้รับ: ผู้ใช้ทุกคน</Text>
        </View>

        <Touchable disabled={publishing} onPress={publish} style={({pressed}) => [ui.publishButton, (pressed || publishing) && ui.pressed]}>
          {publishing ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="send" size={18} />}
          <Text style={ui.publishText}>{publishing ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'สร้างประกาศถึงทุกคน'}</Text>
        </Touchable>
      </AdminCard>

      <AdminCard>
        <SectionHead meta={`${list.length} รายการ`} title="ประกาศทั้งหมด" />
        {list.length ? list.map((item) => {
          const id = text(item.id);
          return (
            <Row detail={`${text(item.message)} · ${date(item.createdAt)}`} icon="campaign" key={id} title={text(item.title)} tone="purple">
              <View style={{alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 8}}>
                <KindBadge kind={text(item.kind, 'update')} mapping={KIND_BADGES} />
                <SmallButton
                  icon="edit"
                  label="แก้ไข"
                  onPress={() => {
                    setEditingId(id);
                    setTitle(text(item.title, ''));
                    setMessage(text(item.message, ''));
                    setKind(text(item.kind, 'update'));
                  }}
                  tone="amber"
                />
                <SmallButton
                  icon="delete"
                  label="ลบ"
                  loading={actionLoading === `${id}-del`}
                  onPress={() => setDeleting({id, title: text(item.title, 'ประกาศนี้')})}
                  tone="red"
                />
              </View>
            </Row>
          );
        }) : <Empty label="ยังไม่มีประกาศ" />}
      <ConfirmDialog
        confirmLabel="ลบ"
        message={deleting ? `ต้องการลบ "${deleting.title}" ใช่หรือไม่?` : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { const target = deleting; setDeleting(null); if (target) onAction(`${target.id}-del`, 'delete-announcement', {id: target.id}, 'ลบประกาศแล้ว'); }}
        title="ยืนยันการลบ"
        visible={Boolean(deleting)}
      />
      </AdminCard>
    </>
  );
}
