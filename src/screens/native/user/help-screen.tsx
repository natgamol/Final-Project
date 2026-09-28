import {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {ADD_ITEM_OPTIONS} from '@/components/add-item-sheet';
import {Card, MaterialIcon, USER_LEFT_TABS, USER_RIGHT_TABS, UserShell, type UserNavigate} from './user-ui';

const C = {pine: '#2c341b', sage: '#6f8f6d', dark: '#5f835f', muted: '#81887d', night: '#5a3d82'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

// A small "tap here" callout, reused under whichever real button a section
// points at. Text alone told a first-time user what a feature is called, not
// where on the actual screen it lives -- this is the part that answers "where
// do I press."
function TapHere({label = 'กดตรงนี้'}: {label?: string}) {
  return <View style={visualStyles.tapHere}>
    <MaterialIcon color={C.dark} name="arrow_upward" size={13} />
    <Text style={visualStyles.tapHereText}>{label}</Text>
  </View>;
}

// Mirrors the real bottom tab bar exactly -- same icons, same labels, same
// left/centre/right grouping as `UserTabBar` -- by reading the same exported
// list it renders from, so this can never drift out of sync with the app.
function MiniTabBar({highlight}: {highlight: 'index' | 'plus' | 'smartlife_finance_day' | 'smartlife_planner' | 'smartlife_profile'}) {
  const renderTab = ([icon, label, page]: string[]) => {
    const active = highlight === page;
    return <View key={page} style={visualStyles.tabItem}>
      {active ? <TapHere /> : <View style={visualStyles.tapHereSpacer} />}
      <View style={[visualStyles.tabIconWrap, active && visualStyles.tabIconWrapActive]}>
        <MaterialIcon color={active ? '#fff' : '#9ea59b'} name={icon} size={18} />
      </View>
      <Text numberOfLines={1} style={[visualStyles.tabLabel, active && visualStyles.tabLabelActive]}>{label}</Text>
    </View>;
  };
  return <View style={visualStyles.tabBar}>
    {USER_LEFT_TABS.map(renderTab)}
    <View style={visualStyles.tabItem}>
      {highlight === 'plus' ? <TapHere /> : <View style={visualStyles.tapHereSpacer} />}
      <View style={[visualStyles.plusButton, highlight === 'plus' && visualStyles.plusButtonActive]}>
        <MaterialIcon color="#fff" name="add" size={22} />
      </View>
    </View>
    {USER_RIGHT_TABS.map(renderTab)}
  </View>;
}

// The "+" menu is identical everywhere in the app (see add-item-sheet.tsx),
// so reading its real options here means this list is always the one the
// user actually sees after tapping "+" -- never a hand-copied guess.
function MiniAddMenu({highlightPages}: {highlightPages: string[]}) {
  return <View style={visualStyles.addMenu}>
    <Text style={visualStyles.addMenuTitle}>เมนูที่เห็นหลังกด +</Text>
    {ADD_ITEM_OPTIONS.map((option) => {
      const active = highlightPages.includes(option.page);
      return <View key={option.page} style={[visualStyles.addRow, active && visualStyles.addRowActive]}>
        <View style={[visualStyles.addRowIcon, {backgroundColor: option.bg}]}>
          <MaterialIcon color={option.iconColor} name={option.icon} size={17} />
        </View>
        <Text numberOfLines={1} style={[visualStyles.addRowText, active && visualStyles.addRowTextActive]}>{option.title}</Text>
        {active ? <MaterialIcon color={C.dark} name="check_circle" size={16} /> : null}
      </View>;
    })}
  </View>;
}

// A small static copy of the dashboard's AI card and notification bell --
// both live on the home screen but are not tab-bar items, so they need their
// own picture rather than the tab-bar mock above.
function MiniAiCard() {
  return <View style={visualStyles.aiCard}>
    <View style={visualStyles.aiCardIcon}><MaterialIcon color="#fff" name="smart_toy" size={18} /></View>
    <Text style={visualStyles.aiCardText}>AI Assistant</Text>
    <Text style={visualStyles.aiCardHint}>อยู่บนสุดของหน้าแรก</Text>
  </View>;
}

function MiniBell() {
  return <View style={visualStyles.bellRow}>
    <View style={visualStyles.bellIcon}>
      <MaterialIcon color={C.pine} name="notifications" size={19} />
      <View style={visualStyles.bellDot} />
    </View>
    <Text style={visualStyles.bellHint}>อยู่มุมขวาบนของหน้าแรก</Text>
  </View>;
}

type Section = {body: string; icon: string; id: string; title: string; visual?: () => React.JSX.Element};

// Every line here is written for someone opening the app for the first time,
// including a reader who has never used an app like this -- plain sentences
// that name the exact button to tap and what happens next, not the feature's
// name alone. The finance entry spells out the one moment support tickets
// keep coming in about: the amount field staying blank when a scan cannot
// read it, and that this is normal and fixable by typing it in.
const SECTIONS: Section[] = [
  {
    body: 'เป็นหน้าแรกที่เจอทุกครั้งที่เปิดแอป จะบอกว่าวันนี้มีอะไรต้องทำบ้าง และเหลือเงินเท่าไหร่ แค่ดูตัวเลขและรายการบนหน้าจอ ไม่ต้องกดอะไรเพิ่มก็เห็นเลย แท็บนี้อยู่ซ้ายสุดของแถบด้านล่าง',
    icon: 'home',
    id: 'dashboard',
    title: 'หน้าแรก (แดชบอร์ด)',
    visual: () => <MiniTabBar highlight="index" />,
  },
  {
    body: 'ใช้ดูว่าวันนี้หรือสัปดาห์นี้มีเรียนหรือมีนัดอะไรบ้าง ถ้าอยากเพิ่มตารางเรียนแบบเร็วๆ ให้กดปุ่ม + ตรงกลางแถบด้านล่าง แล้วเลือก "Smart Scan" เพื่อถ่ายรูปตารางเรียน ระบบจะอ่านและกรอกข้อมูลให้เอง ถ้าอ่านผิดหรือไม่ครบ ให้แตะที่ช่องข้อมูลนั้นแล้วพิมพ์แก้ไขก่อนกดบันทึก',
    icon: 'calendar_month',
    id: 'schedule',
    title: 'ตารางเรียนและแพลนเนอร์',
    visual: () => <>
      <MiniTabBar highlight="plus" />
      <MiniAddMenu highlightPages={['smartlife_scan_schedule', 'smartlife_add_activity']} />
    </>,
  },
  {
    body: 'ใช้บันทึกเงินเข้า-เงินออก กดปุ่ม + ตรงกลางแถบด้านล่าง แล้วเลือก "Smart Scan" เพื่อถ่ายรูปใบเสร็จ/สลิปโอนเงินให้ระบบอ่านให้ หรือเลือก "เพิ่มรายรับ" ถ้าจะพิมพ์เอง ถ้าระบบอ่านยอดเงินไม่เจอ ช่อง "ยอดรวม" จะเว้นว่างไว้ให้พิมพ์เอง แค่แตะที่ช่องแล้วพิมพ์ตัวเลขตามในสลิปได้เลย เป็นเรื่องปกติที่บางรูปอ่านไม่ได้ ไม่ต้องกังวล เพราะแก้ไขทีหลังได้เสมอ',
    icon: 'account_balance_wallet',
    id: 'finance',
    title: 'การเงิน (รายรับ-รายจ่าย)',
    visual: () => <>
      <MiniTabBar highlight="smartlife_finance_day" />
      <MiniAddMenu highlightPages={['smartlife_scan_schedule', 'smartlife_add_income']} />
    </>,
  },
  {
    body: 'ใช้จดสิ่งที่ต้องจำ เช่น การบ้านหรือไอเดียต่างๆ กดปุ่ม + แล้วเลือก "โน้ตใหม่" พิมพ์หัวข้อกับรายละเอียด แล้วกดบันทึก ถ้าทำเสร็จแล้วอยากทำเครื่องหมายไว้ ก็แตะปุ่มติ๊กถูกที่โน้ตนั้นได้เลย',
    icon: 'note_alt',
    id: 'notes',
    title: 'โน้ต',
    visual: () => <>
      <MiniTabBar highlight="plus" />
      <MiniAddMenu highlightPages={['smartlife_add_note']} />
    </>,
  },
  {
    body: 'เหมือนคุยกับผู้ช่วยส่วนตัว พิมพ์ถามเป็นประโยคธรรมดาได้เลย เช่น "วันนี้มีเรียนกี่โมง" หรือ "เดือนนี้ใช้เงินไปเท่าไหร่" ระบบจะค้นข้อมูลของคุณแล้วตอบกลับมา กดที่การ์ด "AI Assistant" บนหน้าแรกเพื่อเริ่มคุย',
    icon: 'auto_awesome',
    id: 'assistant',
    title: 'ผู้ช่วย AI',
    visual: () => <MiniAiCard />,
  },
  {
    body: 'แอปจะเตือนก่อนถึงเวลาเรียนหรือนัดสำคัญให้เอง กดที่ไอคอนกระดิ่งเพื่อดูการแจ้งเตือนทั้งหมด อ่านแล้วไม่อยากเก็บไว้ก็ลบทิ้งได้',
    icon: 'notifications_active',
    id: 'notifications',
    title: 'การแจ้งเตือน',
    visual: () => <MiniBell />,
  },
  {
    body: 'ถ้าใช้แล้วติดปัญหา หรือระบบอ่านข้อมูลผิด ไปที่ "โปรไฟล์" แล้วกด "ส่ง Feedback" บอกเราได้เลยว่าเจอปัญหาอะไร ทีมงานจะรีบดูแลให้ หรือจะกด "ดูคำแนะนำการใช้งานอีกครั้ง" ในหน้าโปรไฟล์ เพื่อดูจุดสำคัญของแต่ละหน้าจอใหม่อีกครั้งก็ได้',
    icon: 'support_agent',
    id: 'trouble',
    title: 'ติดขัดหรือไม่แน่ใจ ทำอย่างไร',
    visual: () => <MiniTabBar highlight="smartlife_profile" />,
  },
];

export default function HelpScreen({onNavigate}: {onNavigate: UserNavigate}) {
  const [openId, setOpenId] = useState<string | null>(SECTIONS[0].id);

  return <UserShell onNavigate={onNavigate}>
    <View style={styles.pageHead}>
      <Touchable onPress={() => onNavigate('smartlife_profile')} style={({pressed}) => [styles.back, pressed && styles.pressed]}>
        <MaterialIcon name="arrow_back_ios_new" size={18} />
      </Touchable>
      <View style={{flex: 1}}>
        <Text style={styles.title}>คู่มือการใช้งาน</Text>
        <Text style={styles.subtitle}>แตะหัวข้อเพื่อดูวิธีใช้แบบละเอียด พร้อมรูปตัวอย่างว่าต้องกดตรงไหน</Text>
      </View>
    </View>
    {SECTIONS.map((section) => {
      const open = openId === section.id;
      return <Card key={section.id} style={styles.card}>
        <Touchable
          accessibilityRole="button"
          accessibilityState={{expanded: open}}
          onPress={() => setOpenId(open ? null : section.id)}
          style={({pressed}) => [styles.sectionHead, pressed && styles.pressed]}
        >
          <View style={styles.icon}><MaterialIcon color={C.sage} name={section.icon} size={22} /></View>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <MaterialIcon color={C.muted} name={open ? 'expand_less' : 'expand_more'} size={22} />
        </Touchable>
        {open ? <>
          <Text style={styles.sectionBody}>{section.body}</Text>
          {section.visual ? <View style={styles.visualBlock}>{section.visual()}</View> : null}
        </> : null}
      </Card>;
    })}
  </UserShell>;
}

const shadow = {shadowColor: C.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: .08, shadowRadius: 20};
const styles = StyleSheet.create({
  back: {...shadow, alignItems: 'center', backgroundColor: '#fff', borderRadius: 14, height: 42, justifyContent: 'center', width: 42},
  card: {marginBottom: 12, padding: 15},
  icon: {alignItems: 'center', backgroundColor: '#e8f0e4', borderRadius: 14, height: 38, justifyContent: 'center', width: 38},
  pageHead: {alignItems: 'center', flexDirection: 'row', gap: 12, marginBottom: 16},
  pressed: {opacity: .82, transform: [{scale: .99}]},
  sectionBody: {color: C.muted, fontFamily: F.r, fontSize: 13, lineHeight: 21, marginTop: 11},
  sectionHead: {alignItems: 'center', flexDirection: 'row', gap: 11},
  sectionTitle: {color: C.pine, flex: 1, fontFamily: F.b, fontSize: 14},
  subtitle: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1},
  title: {color: C.pine, fontFamily: F.x, fontSize: 21},
  visualBlock: {marginTop: 13},
});

const visualStyles = StyleSheet.create({
  addMenu: {backgroundColor: '#f7f9f4', borderRadius: 14, marginTop: 10, padding: 10},
  addMenuTitle: {color: C.muted, fontFamily: F.m, fontSize: 11, marginBottom: 7},
  addRow: {alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, marginTop: 3, paddingHorizontal: 6, paddingVertical: 6},
  addRowActive: {backgroundColor: '#fff', borderColor: C.sage, borderWidth: 1.5},
  addRowIcon: {alignItems: 'center', borderRadius: 10, height: 28, justifyContent: 'center', width: 28},
  addRowText: {color: '#889088', flex: 1, fontFamily: F.m, fontSize: 12},
  addRowTextActive: {color: C.pine, fontFamily: F.b},
  aiCard: {backgroundColor: '#8fa69a', borderRadius: 16, marginTop: 10, padding: 13},
  aiCardHint: {color: 'rgba(255,255,255,.85)', fontFamily: F.r, fontSize: 11, marginTop: 6},
  aiCardIcon: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.25)', borderRadius: 10, height: 30, justifyContent: 'center', marginBottom: 7, width: 30},
  aiCardText: {color: '#fff', fontFamily: F.b, fontSize: 13},
  bellDot: {backgroundColor: '#c96761', borderRadius: 4, height: 8, position: 'absolute', right: -1, top: -1, width: 8},
  bellHint: {color: C.muted, fontFamily: F.r, fontSize: 12},
  bellIcon: {alignItems: 'center', backgroundColor: '#fff', borderColor: '#e2e8de', borderRadius: 18, borderWidth: 1, height: 36, justifyContent: 'center', width: 36},
  bellRow: {alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 10},
  plusButton: {alignItems: 'center', backgroundColor: '#9aac97', borderRadius: 18, height: 36, justifyContent: 'center', width: 36},
  plusButtonActive: {backgroundColor: C.dark},
  tabBar: {alignItems: 'flex-end', backgroundColor: '#fff', borderColor: '#e8ede5', borderRadius: 16, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-around', marginTop: 10, paddingBottom: 10, paddingTop: 26},
  tabIconWrap: {alignItems: 'center', borderRadius: 14, height: 28, justifyContent: 'center', width: 28},
  tabIconWrapActive: {backgroundColor: C.dark},
  tabItem: {alignItems: 'center', flex: 1},
  tabLabel: {color: '#9ea59b', fontFamily: F.m, fontSize: 9, marginTop: 3},
  tabLabelActive: {color: C.dark, fontFamily: F.b},
  tapHere: {alignItems: 'center', marginBottom: 3},
  tapHereSpacer: {height: 16},
  tapHereText: {color: C.dark, fontFamily: F.b, fontSize: 9},
});
