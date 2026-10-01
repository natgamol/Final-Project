import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

// Not imported from `user-ui.tsx` on purpose: that file will import
// `AddItemSheet` from here, and a value-level circular import between the
// two is easy to get wrong in a Metro bundle. This is a one-line duplicate.
function Icon({name, color, size = 22}: {name: string; color: string; size?: number}) {
  return <Text style={{color, fontFamily: 'MaterialSymbols_400Regular', fontSize: size, lineHeight: size}}>{name}</Text>;
}

type AddItemOption = {
  bg: string;
  icon: string;
  iconColor: string;
  page: string;
  subtitle: string;
  title: string;
};

/**
 * Every "+" in the app that is not tied to one obvious thing (Calendar's
 * icon-only buttons, the tab bar's centre button) should open this same
 * list, so a user never has to guess which button leads to "appointment".
 */
export const ADD_ITEM_OPTIONS: AddItemOption[] = [
  {bg: '#e8ecf7', icon: 'document_scanner', iconColor: '#6572ad', page: 'smartlife_scan_schedule', subtitle: 'สแกนตารางเรียน ใบเสร็จ หรือเอกสารให้ AI อ่าน', title: 'Smart Scan'},
  {bg: '#e5efe2', icon: 'event', iconColor: '#52734b', page: 'smartlife_add_activity', subtitle: 'เพิ่มคลาส นัดหมาย หรือกิจกรรมที่มีเวลา', title: 'กิจกรรม/ตารางใหม่'},
  {bg: '#f3e8e8', icon: 'check_box', iconColor: '#bb7777', page: 'smartlife_add_task', subtitle: 'งานส่ง การบ้าน Quiz หรือสิ่งที่ AI Dynamic ต้องจัดลำดับ', title: 'เพิ่มงาน'},
  {bg: '#eceef7', icon: 'account_balance_wallet', iconColor: '#6572ad', page: 'smartlife_add_income', subtitle: 'บันทึกเงินเข้าเอง เช่น เงินเดือน เงินโอน หรือรายได้เสริม', title: 'เพิ่มรายรับ'},
  // Manual expense entry used to be the one "add" this sheet did not offer, so
  // the entry above had to send people to Smart Scan or the finance page to
  // find it -- which is exactly where they could not find it. The red tone is
  // the one the finance screen already gives expenses, so the two agree.
  {bg: '#fcedea', icon: 'credit_card', iconColor: '#c96e68', page: 'smartlife_add_expense', subtitle: 'กรอกยอดและหมวดรายจ่ายเอง ไม่ต้องมีใบเสร็จ', title: 'เพิ่มรายจ่ายเอง'},
  {bg: '#f5e8e8', icon: 'edit_note', iconColor: '#bb7777', page: 'smartlife_add_note', subtitle: 'บันทึกไอเดียและเรื่องสำคัญ', title: 'โน้ตใหม่'},
];

export function AddItemSheet({visible, onClose, onNavigate}: {visible: boolean; onClose: () => void; onNavigate: (page: string) => void}) {
  const open = (page: string) => {
    onClose();
    onNavigate(page);
  };
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable accessibilityLabel="ปิดเมนูเพิ่มรายการ" onPress={onClose} style={styles.sheetBackdrop}>
        <View onStartShouldSetResponder={() => true} style={styles.addSheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>เพิ่มรายการใหม่</Text>
          <Text style={styles.sheetSubtitle}>เลือกสิ่งที่คุณต้องการบันทึก</Text>
          {/* The sheet is anchored to the bottom of the screen, so content
              taller than the viewport overflows upwards and takes the first
              options with it -- unreachable, because nothing here scrolled.
              Seven entries can reach that height on a short phone, so the list
              scrolls and the sheet is capped instead. */}
          <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetList}>
            {ADD_ITEM_OPTIONS.map((option) => (
              <Touchable key={option.page} onPress={() => open(option.page)} style={({pressed}) => [styles.sheetOption, pressed && styles.pressed]}>
                <View style={[styles.sheetIcon, {backgroundColor: option.bg}]}><Icon color={option.iconColor} name={option.icon} size={22} /></View>
                <View style={styles.sheetCopy}>
                  <Text style={styles.sheetOptionTitle}>{option.title}</Text>
                  <Text style={styles.sheetOptionSub}>{option.subtitle}</Text>
                </View>
                <Icon color="#8b988b" name="chevron_right" size={22} />
              </Touchable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  addSheet: {backgroundColor: '#fbfcf8', borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '88%', padding: 18, paddingBottom: 34, width: '100%'},
  pressed: {opacity: .65, transform: [{translateY: -1}]},
  sheetBackdrop: {backgroundColor: 'rgba(20,31,20,.42)', flex: 1, justifyContent: 'flex-end'},
  sheetCopy: {flex: 1},
  sheetHandle: {alignSelf: 'center', backgroundColor: '#d8e0d6', borderRadius: 4, height: 4, marginBottom: 15, width: 42},
  sheetIcon: {alignItems: 'center', borderRadius: 15, height: 44, justifyContent: 'center', width: 44},
  sheetList: {flexGrow: 0},
  sheetOption: {alignItems: 'center', backgroundColor: '#fff', borderColor: '#e8ede5', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 11, marginTop: 10, padding: 12},
  sheetOptionSub: {color: '#879087', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 1},
  sheetOptionTitle: {color: '#2c341b', fontFamily: 'Prompt_700Bold', fontSize: 13},
  sheetSubtitle: {color: '#818b7f', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2},
  sheetTitle: {color: '#29351f', fontFamily: 'Prompt_700Bold', fontSize: 17},
});
