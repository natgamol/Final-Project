import {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {ADD_ITEM_OPTIONS} from '@/components/add-item-sheet';
import {Card, MaterialIcon, PLANNER_TABS, USER_LEFT_TABS, USER_RIGHT_TABS, UserShell, type UserNavigate} from './user-ui';
import {budgetCardTitle} from './finance-screen';

const C = {pine: '#2c341b', sage: '#6f8f6d', dark: '#5f835f', muted: '#81887d', night: '#5a3d82'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

// A small "tap here" callout, reused under whichever real button a section
// points at. Text alone told a first-time user what a feature is called, not
// where on the actual screen it lives -- this is the part that answers "where
// do I press."
function TapHere({label = 'กดตรงนี้'}: {label?: string}) {
  return <View style={visualStyles.tapHere}>
    <MaterialIcon color={C.dark} name="arrow_downward" size={13} />
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

// A small static copy of the dashboard's AI card -- it lives on the home screen
// but is not a tab-bar item, so it needs its own picture.
function MiniAiCard() {
  return <View style={visualStyles.aiCard}>
    <View style={visualStyles.aiCardIcon}><MaterialIcon color="#fff" name="smart_toy" size={18} /></View>
    <Text style={visualStyles.aiCardText}>AI Assistant</Text>
    <Text style={visualStyles.aiCardHint}>อยู่บนสุดของหน้าแรก</Text>
  </View>;
}

// The two icons at the top right of the home screen: last night's sleep, and
// the bell. Pictured together because they sit side by side, in that order.
function MiniDashboardIcons() {
  return <View style={visualStyles.bellRow}>
    <Text style={[visualStyles.bellHint, {flex: 1}]}>มุมขวาบนของหน้าหลัก</Text>
    <View style={visualStyles.tabItemFixed}>
      <TapHere label="เข้านอน" />
      <View style={visualStyles.bellIcon}><MaterialIcon color={C.night} name="bedtime" size={19} /></View>
    </View>
    <View style={visualStyles.tabItemFixed}>
      <TapHere label="แจ้งเตือน" />
      <View style={visualStyles.bellIcon}>
        <MaterialIcon color={C.pine} name="notifications" size={19} />
        <View style={visualStyles.countBadge}><Text style={visualStyles.countBadgeText}>2</Text></View>
      </View>
    </View>
  </View>;
}

// The ตาราง/โน้ต/Adaptive switcher inside the planner, read from the same list
// the three planner screens draw it from, so a renamed tab shows up here too.
function MiniPlannerTabs({highlight}: {highlight: (typeof PLANNER_TABS)[number][0]}) {
  return <View style={visualStyles.plannerRow}>
    {PLANNER_TABS.map(([key, label]) => {
      const active = key === highlight;
      return <View key={key} style={visualStyles.tabItem}>
        {active ? <TapHere /> : <View style={visualStyles.tapHereSpacer} />}
        <View style={[visualStyles.plannerTab, active && visualStyles.plannerTabActive]}>
          <Text style={[visualStyles.plannerTabText, active && visualStyles.plannerTabTextActive]}>{label}</Text>
        </View>
      </View>;
    })}
  </View>;
}

// A page's own header -- eyebrow, title, and the buttons at its top right --
// for the buttons that live on a page rather than in the tab bar.
function MiniPageHeader({actions, eyebrow, title}: {actions: {icon: string; label: string}[]; eyebrow: string; title: string}) {
  return <View style={visualStyles.addMenu}>
    <View style={visualStyles.headerRow}>
      <View style={{flex: 1}}>
        <Text style={visualStyles.mockEyebrow}>{eyebrow}</Text>
        <Text style={visualStyles.mockTitle}>{title}</Text>
      </View>
      {actions.map((action) => <View key={action.icon} style={visualStyles.tabItemFixed}>
        <TapHere label={action.label} />
        <View style={visualStyles.bellIcon}><MaterialIcon color={C.dark} name={action.icon} size={19} /></View>
      </View>)}
    </View>
  </View>;
}

// The Google Calendar card on the ตาราง tab, with the label its button
// carries before an account is connected.
function MiniGoogleSync() {
  return <View style={visualStyles.addMenu}>
    <View style={visualStyles.headerRow}>
      <View style={visualStyles.bellIcon}><MaterialIcon color={C.dark} name="event" size={18} /></View>
      <View style={{flex: 1}}>
        <Text style={visualStyles.addRowTextActive}>Google Calendar</Text>
        <Text style={visualStyles.addMenuTitle}>อยู่ในหน้าตาราง</Text>
      </View>
    </View>
    <TapHere />
    <View style={visualStyles.mockButton}><Text style={visualStyles.mockButtonText}>เชื่อมและซิงก์ Google Calendar</Text></View>
  </View>;
}

// The three counts on the notes page; "เสร็จแล้ว" opens the history.
function MiniNoteMetrics() {
  return <View style={visualStyles.headerRow}>
    {([['กำลังทำ', 4, false], ['เสร็จแล้ว', 6, true], ['ปักหมุด', 1, false]] as const).map(([label, value, active]) => (
      <View key={label} style={visualStyles.tabItem}>
        {active ? <TapHere label="ดูประวัติ" /> : <View style={visualStyles.tapHereSpacer} />}
        <View style={[visualStyles.metricBox, active && visualStyles.addRowActive]}>
          <Text style={visualStyles.mockTitle}>{value}</Text>
          <Text style={visualStyles.addMenuTitle}>{label}</Text>
        </View>
      </View>
    ))}
  </View>;
}

// The finance page's budget card, titled by the same function that titles the
// real one, so a renamed card is renamed here as well.
function MiniBudgetCard() {
  return <View style={visualStyles.addMenu}>
    <TapHere />
    <View style={[visualStyles.addRow, visualStyles.addRowActive]}>
      <View style={[visualStyles.addRowIcon, {backgroundColor: '#f7f9f4'}]}><MaterialIcon color={C.dark} name="savings" size={17} /></View>
      <Text numberOfLines={1} style={[visualStyles.addRowText, visualStyles.addRowTextActive]}>{budgetCardTitle('day')}</Text>
      <MaterialIcon color={C.dark} name="chevron_right" size={16} />
    </View>
  </View>;
}

// The two rows a reader is sent to on the profile page.
function MiniProfileRows() {
  return <View style={visualStyles.addMenu}>
    <Text style={visualStyles.addMenuTitle}>ในหน้าโปรไฟล์</Text>
    {([['forum', 'ส่ง Feedback'], ['tour', 'ดูคำแนะนำการใช้งานอีกครั้ง']] as const).map(([icon, label]) => (
      <View key={label} style={[visualStyles.addRow, visualStyles.addRowActive]}>
        <View style={[visualStyles.addRowIcon, {backgroundColor: '#f7f9f4'}]}><MaterialIcon color={C.dark} name={icon} size={17} /></View>
        <Text numberOfLines={1} style={[visualStyles.addRowText, visualStyles.addRowTextActive]}>{label}</Text>
        <MaterialIcon color={C.dark} name="check_circle" size={16} />
      </View>
    ))}
  </View>;
}

// Says which picture answers which part of the text, once a section has more
// than one way to do something.
function Caption({children}: {children: string}) {
  return <Text style={visualStyles.caption}>{children}</Text>;
}

type Section = {body: string; icon: string; id: string; points?: {label: string; text: string}[]; title: string; visual?: () => React.JSX.Element};

// Every line here is written for someone opening the app for the first time,
// including a reader who has never used an app like this -- plain sentences
// that name the exact button to tap and what happens next, not the feature's
// name alone. The finance entry spells out the one moment support tickets
// keep coming in about: the amount field staying blank when a scan cannot
// read it, and that this is normal and fixable by typing it in.
//
// Every place a section says where to tap has a picture beneath it, and every
// picture reads the real tab bar, add menu, planner tabs or card title it shows
// rather than a copy, so the guide cannot drift from the app it describes.
const SECTIONS: Section[] = [
  {
    body: 'เป็นหน้าแรกที่เจอทุกครั้งที่เปิดแอป จะบอกว่าวันนี้มีอะไรต้องทำบ้าง และเหลือเงินเท่าไหร่ แค่ดูตัวเลขและรายการบนหน้าจอ ไม่ต้องกดอะไรเพิ่มก็เห็นเลย แท็บนี้อยู่ซ้ายสุดของแถบด้านล่าง',
    icon: 'home',
    id: 'dashboard',
    points: [
      {label: 'การแจ้งเตือน', text: 'กดไอคอนกระดิ่งที่มุมขวาบนของหน้าหลัก เพื่อดูการแจ้งเตือนทั้งหมด ตัวเลขสีแดงบนกระดิ่งคือจำนวนเรื่องที่ยังไม่ได้ดู เปิดหน้าการแจ้งเตือนแล้วส่วนนั้นจะหายไปเอง ส่วนเรื่องที่ยังต้องจัดการอยู่ เช่น ใช้เงินเกินงบ หรืองานที่ใกล้ถึงกำหนด จะยังนับอยู่จนกว่าจะจัดการเสร็จ'},
      {label: 'การเข้านอน', text: 'กดไอคอนพระจันทร์ข้างกระดิ่ง เพื่อบันทึกเวลาเข้านอนและเวลาตื่นของเมื่อคืน แอปจะใช้ข้อมูลนี้ประเมินว่าช่วงนี้คุณพักผ่อนพอ หรือเริ่มเหนื่อยเกินไป'},
    ],
    title: 'หน้าหลัก',
    visual: () => <>
      <MiniTabBar highlight="index" />
      <MiniDashboardIcons />
    </>,
  },
  {
    body: 'ใช้ดูและจัดการตารางเรียน กิจกรรม และนัดหมาย กดแท็บ "แพลนเนอร์" ที่แถบด้านล่าง ด้านบนของหน้าจะมีปุ่มสลับ ตาราง / โน้ต / Adaptive ให้เลือกแท็บ "ตาราง"',
    icon: 'calendar_month',
    id: 'planner',
    points: [
      {label: 'เพิ่มกิจกรรม', text: 'กดปุ่ม + มุมขวาบนของหน้าตาราง จะเปิดฟอร์มรายการใหม่ทันที หรือกดปุ่ม + ตรงกลางแถบด้านล่าง แล้วเลือก "กิจกรรม/ตารางใหม่" เมื่อบันทึกแล้ว ปฏิทินจะพาไปที่วันของรายการนั้นให้เห็นเลย'},
      {label: 'นำเข้าตารางเรียน', text: 'กดไอคอนสแกนข้างปุ่ม + มุมขวาบน หรือกดปุ่ม + ตรงกลางแถบด้านล่างแล้วเลือก "Smart Scan" จากนั้นถ่ายรูปตารางเรียน ระบบจะอ่านและกรอกข้อมูลให้เอง ถ้าอ่านผิดหรือไม่ครบ ให้แตะที่ช่องนั้นแล้วพิมพ์แก้ก่อนกดบันทึก'},
      {label: 'Google Calendar', text: 'การ์ด Google Calendar อยู่ในหน้าตาราง กด "เชื่อมและซิงก์ Google Calendar" เพื่อดึงนัดหมายจาก Google เข้ามา และส่งตารางเรียนขึ้นไปเป็นกิจกรรมรายสัปดาห์ตลอดภาคเรียน'},
    ],
    title: 'แพลนเนอร์',
    visual: () => <>
      <Caption>{'เข้าแพลนเนอร์ แล้วเลือกแท็บ "ตาราง"'}</Caption>
      <MiniTabBar highlight="smartlife_planner" />
      <MiniPlannerTabs highlight="calendar" />
      <Caption>เพิ่มกิจกรรม หรือสแกนตารางเรียน จากมุมขวาบน</Caption>
      <MiniPageHeader actions={[{icon: 'document_scanner', label: 'สแกน'}, {icon: 'add', label: 'เพิ่ม'}]} eyebrow="วันนี้" title="ปฏิทิน" />
      <Caption>เชื่อม Google Calendar</Caption>
      <MiniGoogleSync />
      <Caption>หรือใช้ปุ่ม + ตรงกลางแถบด้านล่าง</Caption>
      <MiniTabBar highlight="plus" />
      <MiniAddMenu highlightPages={['smartlife_scan_schedule', 'smartlife_add_activity']} />
    </>,
  },
  {
    body: 'ใช้จดสิ่งที่ต้องจำ เช่น การบ้านหรือไอเดียต่างๆ โน้ตอยู่ในแพลนเนอร์ กดแท็บ "แพลนเนอร์" ที่แถบด้านล่าง แล้วเลือก "โน้ต" จากปุ่มสลับด้านบน',
    icon: 'note_alt',
    id: 'notes',
    points: [
      {label: 'เพิ่มโน้ต', text: 'กดปุ่ม + มุมขวาบนของหน้าโน้ต หรือกดปุ่ม + ตรงกลางแถบด้านล่างแล้วเลือก "โน้ตใหม่" พิมพ์หัวข้อกับรายละเอียด แล้วกดบันทึก'},
      {label: 'ทำเสร็จ และดูประวัติ', text: 'ทำเสร็จแล้วกดปุ่ม "เสร็จ" ที่โน้ตนั้น โน้ตจะย้ายออกจากรายการ ถ้าอยากดูย้อนหลัง ให้กดช่องตัวเลข "เสร็จแล้ว" จะเห็นโน้ตที่ทำเสร็จพร้อมวันที่ ถ้ากดเสร็จผิดอัน กด "คืนกลับ" เพื่อย้ายกลับไปเป็นโน้ตที่ค้างได้'},
    ],
    title: 'โน้ต',
    visual: () => <>
      <Caption>{'เข้าแพลนเนอร์ แล้วเลือกแท็บ "โน้ต"'}</Caption>
      <MiniTabBar highlight="smartlife_planner" />
      <MiniPlannerTabs highlight="notes" />
      <Caption>เพิ่มโน้ตจากมุมขวาบน</Caption>
      <MiniPageHeader actions={[{icon: 'add', label: 'เพิ่ม'}]} eyebrow="บันทึกของฉัน" title="โน้ต" />
      <Caption>หรือใช้ปุ่ม + ตรงกลางแถบด้านล่าง</Caption>
      <MiniTabBar highlight="plus" />
      <MiniAddMenu highlightPages={['smartlife_add_note']} />
      <Caption>ดูโน้ตที่ทำเสร็จแล้ว</Caption>
      <MiniNoteMetrics />
    </>,
  },
  {
    body: 'ใช้บันทึกเงินเข้า-เงินออก และดูว่าวันนี้ สัปดาห์นี้ หรือเดือนนี้ใช้ไปเท่าไหร่ เหลือใช้ได้อีกเท่าไหร่ กดแท็บ "การเงิน" ที่แถบด้านล่างเพื่อดูสรุป',
    icon: 'account_balance_wallet',
    id: 'finance',
    points: [
      {label: 'เพิ่มรายรับ-รายจ่าย', text: 'กดปุ่ม + ตรงกลางแถบด้านล่าง แล้วเลือก "เพิ่มรายรับ" หรือ "เพิ่มรายจ่ายเอง" กรอกจำนวนเงินกับหมวด แล้วกดบันทึก'},
      {label: 'สแกนใบเสร็จ', text: 'กดปุ่ม + ตรงกลางแล้วเลือก "Smart Scan" เพื่อถ่ายรูปใบเสร็จหรือสลิปโอนเงินให้ระบบอ่านให้ เป็นปุ่มเดียวกับที่ใช้สแกนตารางเรียน ระบบจะดูเองว่าเป็นเอกสารแบบไหน ถ้าระบบอ่านยอดเงินไม่เจอ ช่อง "ยอดรวม" จะเว้นว่างไว้ให้พิมพ์เอง แค่แตะที่ช่องแล้วพิมพ์ตัวเลขตามในสลิป เป็นเรื่องปกติที่บางรูปอ่านไม่ได้ ไม่ต้องกังวล เพราะแก้ไขทีหลังได้เสมอ'},
      {label: 'ตั้งงบ', text: `ในหน้าการเงิน กดการ์ด "${budgetCardTitle('day')}" (ในแท็บสัปดาห์การ์ดนี้ชื่อ "${budgetCardTitle('week')}" และในแท็บเดือนชื่อ "${budgetCardTitle('month')}") จะเข้าหน้าตั้งงบ ให้ AI แนะนำจากรายรับ หรือกำหนดเองก็ได้ ทั้งรายเดือน รายสัปดาห์ และรายวัน`},
    ],
    title: 'การเงิน',
    visual: () => <>
      <Caption>เพิ่มรายรับ-รายจ่าย หรือสแกนใบเสร็จ</Caption>
      <MiniTabBar highlight="plus" />
      <MiniAddMenu highlightPages={['smartlife_scan_schedule', 'smartlife_add_income', 'smartlife_add_expense']} />
      <Caption>ตั้งงบ ในหน้าการเงิน</Caption>
      <MiniTabBar highlight="smartlife_finance_day" />
      <MiniBudgetCard />
    </>,
  },
  {
    body: 'มีผู้ช่วย AI สองแบบที่ทำงานคู่กัน แบบหนึ่งไว้ถามตอบ อีกแบบไว้ช่วยจัดเวลา',
    icon: 'auto_awesome',
    id: 'assistant',
    points: [
      {label: 'AI Assistant', text: 'เหมือนคุยกับผู้ช่วยส่วนตัว กดการ์ด "AI Assistant" บนหน้าหลัก แล้วพิมพ์ถามเป็นประโยคธรรมดาได้เลย เช่น "วันนี้มีเรียนกี่โมง" หรือ "เดือนนี้ใช้เงินไปเท่าไหร่" ระบบจะค้นจากข้อมูลจริงของคุณแล้วตอบกลับมา'},
      {label: 'Adaptive AI', text: 'ช่วยหาเวลาที่เหมาะให้ เมื่อมีคำแนะนำ จะขึ้นให้เห็นในแชต AI Assistant กดยืนยันได้ทันที หรือเปิดดูแบบเต็มหน้าได้จาก "แพลนเนอร์" แล้วเลือก "Adaptive" จากปุ่มสลับด้านบน ระบบจะไม่ย้ายตารางของคุณเองจนกว่าจะกดยืนยัน'},
    ],
    title: 'ผู้ช่วย AI',
    visual: () => <>
      <Caption>AI Assistant บนหน้าหลัก</Caption>
      <MiniAiCard />
      <Caption>Adaptive AI ในแพลนเนอร์</Caption>
      <MiniTabBar highlight="smartlife_planner" />
      <MiniPlannerTabs highlight="adaptive" />
    </>,
  },
  {
    body: 'ถ้าใช้แล้วติดปัญหา หรือระบบอ่านข้อมูลผิด บอกเราได้เลย กดแท็บ "โปรไฟล์" ที่แถบด้านล่าง เลื่อนลงไปที่ "ส่ง Feedback" เลือกประเภทปัญหา เช่น "AI แนะนำไม่ตรง" หรือ "สแกนตารางผิด" พิมพ์รายละเอียดว่าเจออะไร แล้วกด "ส่งความคิดเห็น" ทีมงานจะได้รับและรีบดูแลให้',
    icon: 'support_agent',
    id: 'feedback',
    points: [
      {label: 'ดูคำแนะนำอีกครั้ง', text: 'ในหน้าโปรไฟล์เดียวกัน กด "ดูคำแนะนำการใช้งานอีกครั้ง" เพื่อเปิดไฟส่องแนะนำจุดสำคัญของแต่ละหน้าจอใหม่ตั้งแต่ต้น'},
    ],
    title: 'การส่งปัญหา / Feedback',
    visual: () => <>
      <MiniTabBar highlight="smartlife_profile" />
      <MiniProfileRows />
    </>,
  },
];

export default function HelpScreen({onNavigate}: {onNavigate: UserNavigate}) {
  // Nothing is pre-opened: the reader picks what they came for rather than
  // being handed the dashboard section whether or not it is what they wanted.
  const [openId, setOpenId] = useState<string | null>(null);

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
          {section.points?.map((point) => <View key={point.label} style={styles.point}>
            <Text style={styles.pointLabel}>{point.label}</Text>
            <Text style={styles.pointText}>{point.text}</Text>
          </View>)}
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
  point: {marginTop: 10},
  pointLabel: {color: C.pine, fontFamily: F.b, fontSize: 13},
  pointText: {color: C.muted, fontFamily: F.r, fontSize: 13, lineHeight: 21, marginTop: 2},
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
  bellHint: {color: C.muted, fontFamily: F.r, fontSize: 12},
  bellIcon: {alignItems: 'center', backgroundColor: '#fff', borderColor: '#e2e8de', borderRadius: 18, borderWidth: 1, height: 36, justifyContent: 'center', width: 36},
  bellRow: {alignItems: 'flex-end', flexDirection: 'row', gap: 10, marginTop: 10},
  caption: {color: C.dark, fontFamily: F.b, fontSize: 11, marginTop: 14},
  countBadge: {alignItems: 'center', backgroundColor: '#c96761', borderRadius: 7, height: 14, justifyContent: 'center', minWidth: 14, paddingHorizontal: 3, position: 'absolute', right: -5, top: -5},
  countBadgeText: {color: '#fff', fontFamily: F.b, fontSize: 9},
  headerRow: {alignItems: 'flex-end', flexDirection: 'row', gap: 8},
  metricBox: {alignSelf: 'stretch', backgroundColor: '#fff', borderColor: '#e8ede5', borderRadius: 12, borderWidth: 1, padding: 8},
  mockButton: {alignItems: 'center', backgroundColor: C.dark, borderRadius: 10, paddingVertical: 8},
  mockButtonText: {color: '#fff', fontFamily: F.b, fontSize: 11},
  mockEyebrow: {color: C.sage, fontFamily: F.b, fontSize: 10},
  mockTitle: {color: C.pine, fontFamily: F.x, fontSize: 15},
  plannerRow: {backgroundColor: '#f7f9f4', borderRadius: 14, flexDirection: 'row', gap: 4, marginTop: 10, padding: 6},
  plannerTab: {alignItems: 'center', alignSelf: 'stretch', borderRadius: 10, paddingVertical: 6},
  plannerTabActive: {backgroundColor: '#fff', borderColor: C.sage, borderWidth: 1.5},
  plannerTabText: {color: '#889088', fontFamily: F.m, fontSize: 11},
  plannerTabTextActive: {color: C.pine, fontFamily: F.b},
  plusButton: {alignItems: 'center', backgroundColor: '#9aac97', borderRadius: 18, height: 36, justifyContent: 'center', width: 36},
  plusButtonActive: {backgroundColor: C.dark},
  tabBar: {alignItems: 'flex-end', backgroundColor: '#fff', borderColor: '#e8ede5', borderRadius: 16, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-around', marginTop: 10, paddingBottom: 10, paddingTop: 26},
  tabIconWrap: {alignItems: 'center', borderRadius: 14, height: 28, justifyContent: 'center', width: 28},
  tabIconWrapActive: {backgroundColor: C.dark},
  tabItem: {alignItems: 'center', flex: 1},
  tabItemFixed: {alignItems: 'center'},
  tabLabel: {color: '#9ea59b', fontFamily: F.m, fontSize: 9, marginTop: 3},
  tabLabelActive: {color: C.dark, fontFamily: F.b},
  tapHere: {alignItems: 'center', marginBottom: 3},
  tapHereSpacer: {height: 16},
  tapHereText: {color: C.dark, fontFamily: F.b, fontSize: 9},
});
