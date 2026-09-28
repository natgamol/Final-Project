import {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import {MaterialIcon, UserGradientBackdrop, UserTabBar} from './user-ui';
import {parseLineBankNotification} from '@/services/line-bank-parser';
import {showToast} from '@/components/app-toast';
import {
  submitBankText,
  listPendingNotifications,
} from '@/services/line-bank-service';

const C = { ink: '#29351f', sage: '#5f835f', accent: '#626fa8', muted: '#8b9085', mist: '#f4f5ef', red: '#db6762', white: '#ffffff' };
const F = { r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold' };

type Props = { onNavigate: (page: string) => void; uid: string; };

export default function LineBankScreen({onNavigate, uid}: Props) {
  const [inputText, setInputText] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [pendingItems, setPendingItems] = useState<any[]>([]);

  const loadPending = useCallback(async () => {
    try {
      const items = await listPendingNotifications(uid);
      setPendingItems(items);
    } catch {
      setPendingItems([]);
    }
  }, [uid]);

  useEffect(() => {
    const handle = setTimeout(() => void loadPending(), 0);
    return () => clearTimeout(handle);
  }, [loadPending]);

  const handleAnalyze = async () => {
    if (!inputText.trim()) return;
    setIsAnalyzing(true);
    try {
      const result = parseLineBankNotification(inputText);
      if(result) {
         await submitBankText(uid, inputText);
         setInputText('');
         loadPending();
         showToast('ส่งข้อมูลไปรอตรวจแล้ว', undefined, 'success');
      }
    } catch {
      showToast('ข้อผิดพลาด', 'ไม่สามารถวิเคราะห์ข้อความได้');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <View style={styles.container}>
      <UserGradientBackdrop />
      <ResponsiveSafeArea>

        <View style={styles.headerBar}>
          <Touchable onPress={() => onNavigate('smartlife_finance_day')} style={styles.backButton}>
            <MaterialIcon name="chevron_left" size={28} color={C.ink} />
          </Touchable>
          <View style={{flex: 1}}>
            <Text style={styles.headerEyebrow}>SmartLife Finance</Text>
            <Text style={styles.headerTitle}>อ่านแจ้งเตือนการเงิน</Text>
            <Text style={styles.headerSubtitle}>อ่านรายรับ–รายจ่ายจาก LINE และแอปธนาคารที่รองรับบน Android</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          <View style={styles.heroCard}>
            <View style={styles.heroIconBox}>
              <MaterialIcon name="security" size={22} color={C.sage} />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.heroTitle}>ผู้ใช้ไม่ต้องสอนระบบเอง</Text>
              <Text style={styles.heroText}>เปิดสิทธิ์อ่านแจ้งเตือนบน Android รายการที่ข้อมูลครบ มั่นใจสูง และผ่านการตรวจจะบันทึกอัตโนมัติ ส่วนรายการไม่ชัดหรืออาจซ้ำจะรอให้ตรวจ</Text>
            </View>
          </View>

          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={styles.statusIconBox}>
                <MaterialIcon name="notifications_active" size={22} color={C.sage} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.statusTitle}>พร้อมอ่านแจ้งเตือนการเงินแล้ว</Text>
                <Text style={styles.statusText}>มีคิวในเครื่อง {pendingItems.length} รายการ รายการที่ข้อมูลครบและผ่านการตรวจจะบันทึกอัตโนมัติ ส่วนที่ไม่ชัดหรืออาจซ้ำจะรอให้ตรวจ</Text>
              </View>
            </View>
            <Touchable style={styles.statusButton}>
              <MaterialIcon name="list_alt" size={18} color="#fff" />
              <Text style={styles.statusButtonText}>ดูรายการที่ระบบรับมา</Text>
            </Touchable>
          </View>

          <Text style={styles.fallbackLabel}>ทางเลือกสำรอง: วางข้อความเมื่อจำเป็น</Text>
          <View style={styles.inputCard}>
            <TextInput
              style={styles.textInput}
              multiline
              placeholder="ใช้กรณีระบบยังไม่ได้รับแจ้งเตือน เช่น แชร์ข้อความจาก LINE เข้ามา หรือวางข้อความธนาคารเพื่อตรวจรายการเฉพาะครั้ง"
              placeholderTextColor={C.muted}
              value={inputText}
              onChangeText={setInputText}
            />
          </View>

          <Touchable style={({pressed}) => [styles.analyzeButton, pressed && {opacity: 0.85}]} onPress={handleAnalyze}>
            {isAnalyzing ? <ActivityIndicator color="#fff" /> : <MaterialIcon name="search" size={20} color="#fff" />}
            <Text style={styles.analyzeButtonText}>วิเคราะห์ข้อความสำรอง</Text>
          </Touchable>

          <View style={styles.bottomTabs}>
            <Touchable style={styles.tabItem}>
              <MaterialIcon name="checklist" size={18} color="#7284b3" />
              <Text style={styles.tabText}>รายการรอตรวจ</Text>
            </Touchable>
            <Touchable style={styles.tabItem}>
              <MaterialIcon name="settings" size={18} color="#7284b3" />
              <Text style={styles.tabText}>ตั้งค่าการเชื่อมต่อ</Text>
            </Touchable>
          </View>

          <View style={styles.bottomSpacer} />
        </ScrollView>
        <UserTabBar active="smartlife_line_bank" onNavigate={onNavigate} />
      </ResponsiveSafeArea>
    </View>
  );
}

const shadow = {shadowColor: C.ink, shadowOffset: {height: 8, width: 0}, shadowOpacity: 0.05, shadowRadius: 18};
const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10, gap: 15 },
  backButton: { backgroundColor: '#fff', width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', ...shadow },
  headerEyebrow: { color: C.sage, fontFamily: F.b, fontSize: 12 },
  headerTitle: { color: C.ink, fontFamily: F.x, fontSize: 22, marginTop: 0 },
  headerSubtitle: { color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2 },
  scrollContent: { padding: 20 },
  heroCard: { backgroundColor: '#f4f8f4', borderRadius: 20, padding: 16, flexDirection: 'row', gap: 12, marginBottom: 16, borderWidth: 1, borderColor: '#eaf1ea' },
  heroIconBox: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: '#d3e2d3', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  heroTitle: { color: C.ink, fontFamily: F.b, fontSize: 13 },
  heroText: { color: '#6a786a', fontFamily: F.r, fontSize: 12, marginTop: 4, lineHeight: 18 },
  statusCard: { backgroundColor: '#fdfdfd', borderRadius: 20, padding: 16, marginBottom: 24, ...shadow },
  statusRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statusIconBox: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', ...shadow },
  statusTitle: { color: C.ink, fontFamily: F.b, fontSize: 13 },
  statusText: { color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 4, lineHeight: 18 },
  statusButton: { backgroundColor: '#62865c', borderRadius: 14, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  statusButtonText: { color: '#fff', fontFamily: F.b, fontSize: 12 },
  fallbackLabel: { color: C.ink, fontFamily: F.b, fontSize: 12, marginBottom: 10, marginLeft: 4 },
  inputCard: { backgroundColor: '#fff', borderRadius: 20, minHeight: 130, padding: 16, marginBottom: 16, ...shadow },
  textInput: { fontFamily: F.r, fontSize: 12, color: C.ink, flex: 1, textAlignVertical: 'top' },
  analyzeButton: { backgroundColor: '#62865c', borderRadius: 14, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 24 },
  analyzeButtonText: { color: '#fff', fontFamily: F.b, fontSize: 13 },
  bottomTabs: { flexDirection: 'row', gap: 10 },
  tabItem: { flex: 1, backgroundColor: '#f3f5fc', borderRadius: 16, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  tabText: { color: '#57679a', fontFamily: F.b, fontSize: 12 },
  bottomSpacer: { height: 40 },
});
