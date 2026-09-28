import {StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {useInstitution} from '@/providers/institution-provider';
import type {InstitutionType} from '@/types/institution';
import {Card, MaterialIcon, PrimaryButton, UserHeader, UserShell, type UserNavigate, userStyles as styles} from './user-ui';
import {showToast} from '@/components/app-toast';

const OPTIONS: {description: string; icon: string; label: string; value: InstitutionType}[] = [
  {description: 'ตารางรายวิชาและภาคเรียนประมาณ 16 สัปดาห์', icon: 'school', label: 'มหาวิทยาลัย', value: 'university'},
  {description: 'ตารางแบบคาบเรียน ภาคเรียนที่ 1 และ 2', icon: 'local_library', label: 'มัธยมศึกษา', value: 'high-school'},
];

function InstitutionTypeSelector({onChange, value}: {onChange: (value: InstitutionType) => void; value: InstitutionType | null}) {
  return <View accessibilityLabel="เลือกประเภทสถานศึกษา" accessibilityRole="radiogroup" style={localStyles.optionList}>
    {OPTIONS.map((option) => {
      const selected = value === option.value;
      return <Touchable
        accessibilityLabel={option.label}
        accessibilityRole="radio"
        accessibilityState={{checked: selected}}
        key={option.value}
        onPress={() => onChange(option.value)}
        style={({pressed}) => [localStyles.option, selected && localStyles.optionSelected, pressed && localStyles.pressed]}
      >
        <View style={[localStyles.icon, selected && localStyles.iconSelected]}><MaterialIcon color={selected ? '#fff' : '#668d65'} name={option.icon} size={24} /></View>
        <View style={localStyles.optionCopy}><Text style={localStyles.optionTitle}>{option.label}</Text><Text style={localStyles.optionDescription}>{option.description}</Text></View>
        <View style={[localStyles.radio, selected && localStyles.radioSelected]}>{selected ? <View style={localStyles.radioDot} /> : null}</View>
      </Touchable>;
    })}
  </View>;
}

export default function OnboardingScreen({page, onNavigate}: {page: string; onNavigate: UserNavigate}) {
  const {institutionType, setInstitutionType} = useInstitution();
  const step = page.includes('step_3') ? 3 : page.includes('step_2') ? 2 : 1;
  // Written for a first-time user who has never opened an app like this
  // before -- plain, concrete sentences that say what to do and what happens
  // next, not just the feature's name. No jargon a reader would have to
  // already know (no "sync", "AI-powered", percentages, or field names).
  const content = step === 1
    ? [
      'เริ่มต้นใช้งาน SmartLife',
      'ก่อนอื่นบอกให้ระบบรู้ว่าคุณเรียนอยู่ระดับไหน จะได้ตั้งวันเปิด-ปิดเทอมและอ่านตารางเรียนให้ตรงกับของจริง แตะเลือกอย่างใดอย่างหนึ่งด้านล่างนี้ แล้วกดปุ่ม "ถัดไป"',
    ]
    : step === 2
      ? [
        'ไม่ต้องพิมพ์เอง แค่ถ่ายรูป',
        'ถ่ายรูปตารางเรียน หรือถ่ายรูปสลิปโอนเงิน/ใบเสร็จตอนซื้อของ ระบบจะอ่านตัวหนังสือในรูปแล้วกรอกข้อมูลให้เองอัตโนมัติ ถ้ามีจุดไหนอ่านผิดหรือไม่ชัด ก็แค่แตะที่ข้อมูลนั้นเพื่อแก้ไขก่อนกดบันทึก หรือถ้าสะดวก จะเชื่อมกับ Google Calendar แทนก็ได้',
      ]
      : [
        'พร้อมใช้งานแล้ว',
        'หน้าแรกที่เจอคือ "แดชบอร์ด" จะโชว์งานที่ต้องทำวันนี้และยอดเงินคงเหลือให้ดูง่ายๆ ต้องการเพิ่มงาน บันทึกรายรับ-รายจ่าย หรือถ่ายรูปสแกนเมื่อไหร่ ให้กดปุ่ม + ตรงกลางแถบล่างสุดได้เลยทุกหน้าจอ',
      ];
  const next = step === 1 ? 'smartlife_onboarding_step_2' : step === 2 ? 'smartlife_onboarding_step_3' : 'index';
  const continueOnboarding = () => {
    if (step === 1 && !institutionType) {
      showToast('เลือกประเภทสถานศึกษา', 'กรุณาเลือกมหาวิทยาลัยหรือมัธยมศึกษาก่อนดำเนินการต่อ');
      return;
    }
    onNavigate(next);
  };

  return <UserShell onNavigate={onNavigate}>
    <UserHeader onNavigate={onNavigate} title="ยินดีต้อนรับ" subtitle={`ขั้นตอน ${step} จาก 3`} />
    <View style={{paddingTop: 34}}>
      <Card style={localStyles.card}>
        <Text style={[styles.sectionTitle, {fontSize: 28}]}>{content[0]}</Text>
        <Text style={[styles.bodyText, {fontSize: 14, lineHeight: 22}]}>{content[1]}</Text>
        {step === 1 ? <InstitutionTypeSelector onChange={(value) => setInstitutionType(value).catch(() => showToast('บันทึกไม่สำเร็จ', 'กรุณาลองเลือกประเภทสถานศึกษาอีกครั้ง'))} value={institutionType} /> : null}
        <View style={localStyles.progress}>{[1, 2, 3].map((item) => <View key={item} style={[localStyles.progressItem, {backgroundColor: item <= step ? '#668d65' : '#cbd6c7'}]} />)}</View>
      </Card>
      <PrimaryButton disabled={step === 1 && !institutionType} label={step === 3 ? 'เข้าสู่ SmartLife' : 'ถัดไป'} onPress={continueOnboarding} />
      {step > 1 ? <Touchable onPress={() => onNavigate('index')} style={localStyles.skip}><Text style={styles.rowSide}>ข้ามไปหน้าหลัก</Text></Touchable> : null}
    </View>
  </UserShell>;
}

const localStyles = StyleSheet.create({
  card: {backgroundColor: '#e0ebdd', minHeight: 340},
  icon: {alignItems: 'center', backgroundColor: '#edf3ea', borderRadius: 15, height: 48, justifyContent: 'center', width: 48},
  iconSelected: {backgroundColor: '#668d65'},
  option: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.78)', borderColor: 'transparent', borderRadius: 17, borderWidth: 2, flexDirection: 'row', gap: 11, padding: 12},
  optionCopy: {flex: 1},
  optionDescription: {color: '#758171', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  optionList: {gap: 10, marginTop: 20},
  optionSelected: {backgroundColor: '#fff', borderColor: '#668d65'},
  optionTitle: {color: '#29351f', fontFamily: 'Prompt_700Bold', fontSize: 14},
  pressed: {opacity: .78, transform: [{scale: .98}]},
  progress: {flexDirection: 'row', gap: 8, marginTop: 26},
  progressItem: {borderRadius: 6, flex: 1, height: 7},
  radio: {alignItems: 'center', borderColor: '#9caa98', borderRadius: 10, borderWidth: 2, height: 20, justifyContent: 'center', width: 20},
  radioDot: {backgroundColor: '#fff', borderRadius: 4, height: 8, width: 8},
  radioSelected: {backgroundColor: '#668d65', borderColor: '#668d65'},
  skip: {alignItems: 'center', marginTop: 18},
});
