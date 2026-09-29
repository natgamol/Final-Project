/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';

import {ResponsiveSafeArea} from '@/components/layout/responsive-safe-area';
import {Touchable} from '@/components/touchable';
import {calculateFinanceBudgetInsight} from '@/services/dynamic-insights';
import {loadLegacyPageData} from '@/services/legacy-data';
import {currentMonthKey, loadMonthlyBudget, parseBudgetAmount, saveMonthlyBudget, type MonthlyBudget} from '@/services/monthly-budget';
import {MaterialIcon, UserGradientBackdrop, UserTabBar} from './user-ui';

type Item = Record<string, unknown>;
type BudgetMode = 'ai' | 'manual';
type Props = {onNavigate: (page: string) => void; uid: string};

const C = {accent: '#626fa8', accentSoft: '#eceef8', amber: '#c98a3f', amberSoft: '#fdf1de', ink: '#29351f', mist: '#f4f6f1', muted: '#89928a', red: '#d66963', redSoft: '#fbe8e5', sage: '#618661', sageSoft: '#e2eddf', line: '#e3e8df'};
const F = {r: 'Prompt_400Regular', m: 'Prompt_500Medium', s: 'Prompt_600SemiBold', b: 'Prompt_700Bold', x: 'Prompt_800ExtraBold'};

function items(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === 'object') : []; }
function money(value: number) { return `฿${Math.max(0, Math.round(value)).toLocaleString('th-TH')}`; }
const parseMoney = parseBudgetAmount;
function suggestedBudget(income: number) { return Math.max(0, Math.floor(income * .7 / 100) * 100); }
function monthKeyLabel(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  return new Intl.DateTimeFormat('th-TH', {month: 'long', timeZone: 'Asia/Bangkok', year: 'numeric'}).format(new Date(Date.UTC(year, month - 1, 5)));
}
function pressureText(level?: string) {
  if (level === 'critical') return 'ใช้เกินกรอบสัปดาห์แล้ว ควรเก็บเงินไว้สำหรับรายการจำเป็นก่อน';
  if (level === 'high') return 'ใช้ถึงระดับเตือน 80% ของสัปดาห์แล้ว';
  if (level === 'medium') return 'เริ่มเข้าใกล้ระดับเตือนของสัปดาห์';
  if (level === 'low') return 'ยังอยู่ในกรอบ แต่ควรเช็กยอดรวมของสัปดาห์';
  return 'งบสัปดาห์นี้ยังอยู่ในโซนปลอดภัย';
}

// Added for monthly budget planning: lets users set their own spending limit or apply the income-based recommendation.
export default function MonthlyBudgetScreen({onNavigate, uid}: Props) {
  const [monthKey, setMonthKey] = useState(() => currentMonthKey());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [income, setIncome] = useState(0);
  const [expense, setExpense] = useState(0);
  // `panel` is only which card is on screen. `source` records where the amount
  // in `amountText` actually came from, so browsing the AI card never relabels
  // a hand-typed limit as an AI one, and vice versa.
  const [panel, setPanel] = useState<BudgetMode>('ai');
  const [source, setSource] = useState<BudgetMode>('ai');
  const [amountText, setAmountText] = useState('');
  const [transactions, setTransactions] = useState<Item[]>([]);
  const [saved, setSaved] = useState<MonthlyBudget | null>(null);
  // Set when this month's transactions could not be read. Income, spending and
  // the recommendation are unknown in that state and must not be drawn as real
  // zeroes, which previously made an offline screen look exactly like a month
  // with no spending at all.
  const [dataError, setDataError] = useState(false);
  const [formError, setFormError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recommendation = suggestedBudget(income);
  // One source of truth for both cards. `source` only records where the number
  // came from; it must never make this screen evaluate a different amount than
  // the one that is stored and used by the finance page, the daily tension
  // read-out and the AI assistant.
  const selectedAmount = parseMoney(amountText);
  const overspend = Math.max(0, expense - selectedAmount);
  const remaining = Math.max(0, selectedAmount - expense);
  const usedPercent = selectedAmount > 0 ? Math.round(expense / selectedAmount * 100) : 0;
  const budgetStatus = selectedAmount <= 0 ? 'unset' : usedPercent >= 100 ? 'over' : usedPercent >= 80 ? 'warning' : 'safe';
  const rolledOverFrom = saved?.rolledOverFrom;
  const unsavedChange = Boolean(saved) && selectedAmount > 0 && selectedAmount !== saved?.amount;
  const recommendationApplied = recommendation > 0 && selectedAmount === recommendation;

  const financeInsight = useMemo(() => (dataError ? null : calculateFinanceBudgetInsight({
    monthlyBudget: selectedAmount,
    transactions: transactions.map((item) => ({
      amount: Number(item.amount ?? 0),
      occurredAt: item.occurredAt as never,
      type: item.type === 'income' ? 'income' : 'expense',
    })),
  })), [dataError, selectedAmount, transactions]);
  const monthLabel = monthKeyLabel(monthKey);

  const load = useCallback(async () => {
    setLoading(true);
    setFormError('');
    // Re-read the month here rather than pinning it at mount, so an app left
    // open across midnight on the first does not keep editing last month.
    const activeMonth = currentMonthKey();
    setMonthKey(activeMonth);
    const [pageData, savedBudget] = await Promise.all([
      (loadLegacyPageData(uid, 'user/smartlife_finance_month') as Promise<{transactions?: unknown}>)
        .then((value) => ({ok: true as const, value}))
        .catch((error) => { console.error('[MonthlyBudget] Transactions load failed', error); return {ok: false as const, value: null}; }),
      loadMonthlyBudget(uid, activeMonth)
        .catch((error) => { console.error('[MonthlyBudget] Saved budget load failed', error); return null; }),
    ]);

    if (pageData.ok && pageData.value) {
      const monthTransactions = items(pageData.value.transactions);
      setTransactions(monthTransactions);
      setIncome(monthTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
      setExpense(monthTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
      setDataError(false);
    } else {
      setTransactions([]);
      setIncome(0);
      setExpense(0);
      setDataError(true);
    }

    setSaved(savedBudget);
    if (savedBudget) {
      setPanel(savedBudget.source);
      setSource(savedBudget.source);
      setAmountText(String(savedBudget.amount));
    }
    setLoading(false);
  }, [uid]);

  useEffect(() => { load().catch((error) => { console.error('[MonthlyBudget] Load failed', error); setDataError(true); setLoading(false); }); }, [load]);
  useEffect(() => () => { if (navigateTimer.current) clearTimeout(navigateTimer.current); }, []);

  // Switching cards is a view change only: it must never rewrite the amount, or
  // simply looking at the recommendation would replace a limit the user is
  // still using. Adopting the recommendation is the separate, explicit action
  // below.
  const showPanel = (next: BudgetMode) => {
    setPanel(next);
    setFormError('');
    setSuccessMessage('');
  };

  const applyRecommendation = () => {
    setSuccessMessage('');
    // Never let an unavailable recommendation blank out a limit the user
    // already has. Keep the existing number and explain why.
    if (recommendation <= 0) {
      setFormError(dataError
        ? 'ยังคำนวณคำแนะนำไม่ได้เพราะโหลดข้อมูลการเงินไม่สำเร็จ ลองโหลดใหม่ หรือกำหนดงบเองได้เลย'
        : 'ยังไม่มีรายรับของเดือนนี้ AI จึงยังคำนวณลิมิตให้ไม่ได้ เพิ่มรายรับก่อน หรือกำหนดงบเองได้เลย');
      return;
    }
    setFormError('');
    setSource('ai');
    setAmountText(String(recommendation));
  };

  const save = async () => {
    setSuccessMessage('');
    if (selectedAmount <= 0) {
      setFormError(panel === 'ai'
        ? 'ยังไม่มีลิมิตที่จะบันทึก กดปุ่ม ใช้ลิมิตนี้ ในการ์ดคำแนะนำ หรือเลือก กำหนดเอง แล้วพิมพ์จำนวนเงิน'
        : 'กรุณาระบุจำนวนงบประมาณที่มากกว่า 0');
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const next = await saveMonthlyBudget(uid, {amount: selectedAmount, monthKey, source});
      setSaved(next);
      setSuccessMessage(next.synced === false
        ? `บันทึกไว้ในเครื่องนี้แล้ว ${money(selectedAmount)} จะซิงค์ไปเครื่องอื่นเมื่อกลับมาออนไลน์`
        : `บันทึกแล้ว ตั้งลิมิตค่าใช้จ่าย${monthLabel}ไว้ ${money(selectedAmount)}`);
      navigateTimer.current = setTimeout(() => onNavigate('smartlife_finance_month'), 1200);
    } catch (error) {
      console.error('[MonthlyBudget] Save failed', error);
      setFormError('บันทึกไม่สำเร็จ ลองใหม่อีกครั้งนะ');
    } finally {
      setSaving(false);
    }
  };

  return <ResponsiveSafeArea style={styles.safe}><View style={styles.screen}><UserGradientBackdrop />
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}><Touchable accessibilityLabel="กลับหน้าการเงิน" onPress={() => onNavigate('smartlife_finance_month')} style={styles.back}><MaterialIcon color={C.ink} name="chevron_left" size={27} /></Touchable><View style={styles.headerCopy}><Text style={styles.eyebrow}>แผนการเงินของฉัน</Text><Text style={styles.title}>กำหนดงบรายเดือน</Text></View><View style={styles.headerIcon}><MaterialIcon color="#fff" name="savings" size={20} /></View></View>
      {loading ? <View style={styles.loading}><ActivityIndicator color={C.sage} size="large" /><Text style={styles.loadingText}>กำลังเตรียมข้อมูลการเงิน</Text></View> : <>
        {dataError ? <View style={styles.errorBanner}>
          <MaterialIcon color={C.red} name="cloud_off" size={19} />
          <View style={{flex: 1}}><Text style={styles.errorTitle}>โหลดรายการเดือนนี้ไม่สำเร็จ</Text><Text style={styles.errorText}>ยอดรายรับและยอดใช้จ่ายจึงยังไม่แสดง ตรวจอินเทอร์เน็ตแล้วกดโหลดใหม่ ระหว่างนี้ยังกำหนดงบเองและบันทึกได้ตามปกติ</Text></View>
          <Touchable accessibilityLabel="โหลดข้อมูลใหม่" accessibilityRole="button" onPress={() => { load().catch(() => setLoading(false)); }} style={styles.retryButton}><Text style={styles.retryText}>โหลดใหม่</Text></Touchable>
        </View> : null}

        {saved && saved.synced === false ? <View style={styles.noticeBanner}>
          <MaterialIcon color={C.amber} name="cloud_off" size={19} />
          <View style={{flex: 1}}><Text style={styles.noticeTitle}>งบนี้ยังอยู่ในเครื่องนี้เท่านั้น</Text><Text style={styles.noticeText}>ยังซิงค์ขึ้นบัญชีไม่สำเร็จ จึงยังไม่เห็นบนเครื่องอื่น ต่ออินเทอร์เน็ตแล้วกดโหลดใหม่หรือกดบันทึกอีกครั้ง</Text></View>
        </View> : null}

        {rolledOverFrom ? <View style={styles.noticeBanner}>
          <MaterialIcon color={C.amber} name="event_repeat" size={19} />
          <View style={{flex: 1}}><Text style={styles.noticeTitle}>ใช้งบต่อจาก{monthKeyLabel(rolledOverFrom)}</Text><Text style={styles.noticeText}>ยังไม่ได้ตั้งงบของ{monthLabel} ระบบจึงยกลิมิตเดิม {money(saved?.amount ?? 0)} มาให้ก่อน กดบันทึกเพื่อยืนยัน หรือแก้เป็นจำนวนใหม่ได้เลย</Text></View>
        </View> : null}

        <LinearGradient colors={['#6674ac', '#8d96c2']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.hero}>
          <View style={styles.heroGlow} /><Text style={styles.heroEyebrow}>งบเดือน{monthLabel}</Text><Text style={styles.heroAmount}>{selectedAmount > 0 ? money(selectedAmount) : 'ยังไม่ได้ตั้ง'}</Text><Text style={styles.heroText}>{selectedAmount <= 0 ? 'เลือกวิธีกำหนดงบด้านล่าง' : source === 'ai' ? 'ลิมิตจากคำแนะนำของ AI ตามรายรับเดือนนี้' : 'ลิมิตค่าใช้จ่ายที่คุณกำหนดเอง'}</Text>
          <View style={styles.heroStatRow}><HeroStat label="รายรับเดือนนี้" value={dataError ? '—' : money(income)} /><HeroStat label="ใช้ไปแล้ว" value={dataError ? '—' : money(expense)} /></View>
        </LinearGradient>

        {/* Monthly progress. Warns at 80% and states the real overspend amount
            instead of clamping it away at zero. */}
        {selectedAmount > 0 && !dataError ? <View style={styles.card}>
          <View style={styles.progressTop}><Text style={styles.progressLabel}>ใช้ไปแล้ว {usedPercent}% ของงบเดือนนี้</Text><Text style={[styles.progressValue, budgetStatus === 'over' && {color: C.red}, budgetStatus === 'warning' && {color: C.amber}]}>{money(expense)} / {money(selectedAmount)}</Text></View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, {backgroundColor: budgetStatus === 'over' ? C.red : budgetStatus === 'warning' ? C.amber : C.sage, width: `${Math.min(100, usedPercent)}%`}]} /></View>
          <View style={[styles.statusInline, {backgroundColor: budgetStatus === 'over' ? C.redSoft : budgetStatus === 'warning' ? C.amberSoft : C.sageSoft}]}>
            <MaterialIcon color={budgetStatus === 'over' ? C.red : budgetStatus === 'warning' ? C.amber : C.sage} name={budgetStatus === 'over' ? 'warning_amber' : budgetStatus === 'warning' ? 'error_outline' : 'check_circle'} size={19} />
            <Text style={[styles.statusInlineText, {color: budgetStatus === 'over' ? C.red : budgetStatus === 'warning' ? C.amber : C.sage}]}>
              {budgetStatus === 'over'
                ? `ใช้เกินงบแล้ว ${money(overspend)}`
                : budgetStatus === 'warning'
                  ? `ใกล้เต็มงบแล้ว เหลือ ${money(remaining)}`
                  : `ยังใช้ได้อีก ${money(remaining)}`}
            </Text>
          </View>
        </View> : null}

        {financeInsight ? <View style={styles.card}>
          <View style={styles.cardHeader}><View style={styles.cardIcon}><MaterialIcon color={C.accent} name="query_stats" size={20} /></View><View style={{flex: 1}}><Text style={styles.cardTitle}>AI แบ่งงบให้แล้ว</Text><Text style={styles.cardSub}>{pressureText(financeInsight.financePressureLevel)}</Text></View></View>
          {/* Both shares of the monthly limit, stated together and at full size
              as soon as a budget exists. The weekly figure used to sit alone in
              a small row and the daily one was never shown here at all -- it
              was reachable only through the day pill on the finance screen, so
              the split the AI had just made went unsaid on the screen that made
              it. Editing the amount is untouched: the modes and the save button
              below still work exactly as before. */}
          <View style={styles.shareRow}>
            <View style={styles.shareCell}><Text style={styles.shareLabel}>ใช้ได้สัปดาห์ละ</Text><Text style={styles.shareAmount}>{money(financeInsight.weeklyBudget)}</Text></View>
            <View style={styles.shareCell}><Text style={styles.shareLabel}>ใช้ได้วันละ</Text><Text style={styles.shareAmount}>{money(financeInsight.averageDailyBudget)}</Text></View>
          </View>
          <View style={styles.recommendation}><Text style={styles.recommendationLabel}>สัปดาห์นี้ใช้แล้ว {financeInsight.weeklyUsagePercent}%</Text><Text style={styles.recommendationAmount}>{financeInsight.weeklyRemainingBudget < 0 ? `เกิน ${money(-financeInsight.weeklyRemainingBudget)}` : `เหลือ ${money(financeInsight.weeklyRemainingBudget)}`}</Text></View>
          <Text style={styles.inputHint}>ช่วง {financeInsight.weekStart} ถึง {financeInsight.weekEnd} • ระบบเตือนเมื่อใช้ถึง 80%</Text>
        </View> : null}

        <View style={styles.modeBar}><ModeButton active={panel === 'ai'} icon="auto_awesome" label="AI แนะนำ" onPress={() => showPanel('ai')} /><ModeButton active={panel === 'manual'} icon="edit" label="กำหนดเอง" onPress={() => showPanel('manual')} /></View>

        {panel === 'ai' ? <View style={styles.card}><View style={styles.cardHeader}><View style={styles.cardIcon}><MaterialIcon color={C.accent} name="auto_awesome" size={20} /></View><View style={{flex: 1}}><Text style={styles.cardTitle}>คำแนะนำสำหรับเดือนนี้</Text><Text style={styles.cardSub}>กันไว้ 70% ของรายรับ เพื่อเหลือเงินสำรอง 30%</Text></View></View>
          {dataError ? <View style={styles.emptySuggestion}><MaterialIcon color={C.muted} name="cloud_off" size={25} /><Text style={styles.emptySuggestionText}>ยังคำนวณคำแนะนำไม่ได้เพราะโหลดข้อมูลการเงินไม่สำเร็จ กดโหลดใหม่ด้านบน หรือเลือกกำหนดเอง</Text></View>
            : income > 0 ? <><View style={styles.recommendation}><Text style={styles.recommendationLabel}>ลิมิตที่แนะนำ</Text><Text style={styles.recommendationAmount}>{money(recommendation)}</Text></View><BudgetSplit amount={recommendation * .45} color="#71936e" label="ค่าอาหาร" percent={45} /><BudgetSplit amount={recommendation * .25} color="#828dbb" label="การเดินทาง" percent={25} /><BudgetSplit amount={recommendation * .15} color="#d49a88" label="เรียน / ของใช้" percent={15} /><BudgetSplit amount={recommendation * .15} color="#a8b794" label="สำรอง" percent={15} /></>
              : <View style={styles.emptySuggestion}><MaterialIcon color={C.muted} name="account_balance_wallet" size={25} /><Text style={styles.emptySuggestionText}>เพิ่มรายรับของเดือนนี้ แล้ว AI จะคำนวณงบที่เหมาะสมให้</Text></View>}
          {/* Adopting the recommendation is its own labelled action. It used to
              be a second press on the already-selected "AI แนะนำ" tab, which
              looks like a no-op and left people believing the save had failed. */}
          {!dataError && recommendation > 0 ? <>
            <Touchable accessibilityRole="button" disabled={recommendationApplied} onPress={applyRecommendation} style={[styles.applyButton, recommendationApplied && styles.applyButtonDone]}>
              <MaterialIcon color={recommendationApplied ? C.sage : '#fff'} name={recommendationApplied ? 'check_circle' : 'auto_awesome'} size={18} />
              <Text style={[styles.applyText, recommendationApplied && styles.applyTextDone]}>{recommendationApplied ? 'ใช้ลิมิตนี้อยู่ • กดบันทึกเพื่อยืนยัน' : `ใช้ลิมิตนี้ ${money(recommendation)}`}</Text>
            </Touchable>
            <Text style={styles.inputHint}>{recommendationApplied
              ? 'กด บันทึกงบเดือนนี้ ด้านล่างเพื่อให้ลิมิตนี้มีผลกับหน้าการเงินและผู้ช่วย AI'
              : `ตอนนี้ใช้ลิมิต ${selectedAmount > 0 ? money(selectedAmount) : 'ยังไม่ได้ตั้ง'} อยู่ การดูคำแนะนำนี้ยังไม่เปลี่ยนลิมิตจนกว่าจะกดปุ่มด้านบนแล้วบันทึก`}</Text>
          </> : null}
        </View> : <View style={styles.card}><Text style={styles.fieldLabel}>กำหนดลิมิตค่าใช้จ่ายเดือนนี้</Text><View style={styles.inputShell}><Text style={styles.currency}>฿</Text><TextInput accessibilityLabel="จำนวนงบรายเดือน" keyboardType="number-pad" onChangeText={(value) => { const parsed = parseMoney(value); setAmountText(parsed > 0 ? String(parsed) : ''); setSource('manual'); setFormError(''); setSuccessMessage(''); }} placeholder="เช่น 5,000" placeholderTextColor="#a5ada1" style={styles.amountInput} value={amountText} /></View><Text style={styles.inputHint}>คุณสามารถเปลี่ยนงบใหม่ได้ตลอดเดือน ยอดที่ใช้ไปแล้วจะถูกคิดเทียบกับลิมิตใหม่ทันที</Text></View>}

        {formError ? <View style={styles.formErrorBox}><MaterialIcon color={C.red} name="error" size={17} /><Text style={styles.formErrorText}>{formError}</Text></View> : null}
        {successMessage ? <View style={styles.formSuccessBox}><MaterialIcon color={C.sage} name="check_circle" size={17} /><Text style={styles.formSuccessText}>{successMessage}</Text></View> : null}
        {unsavedChange && !successMessage ? <Text style={styles.unsavedHint}>ยังไม่ได้บันทึก — ลิมิตที่ใช้อยู่จริงคือ {money(saved?.amount ?? 0)}</Text> : null}

        <Touchable accessibilityRole="button" disabled={saving} onPress={save} style={[styles.saveShell, saving && styles.disabled]}><LinearGradient colors={['#2b3916', '#1e2b0f']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.save}>{saving ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcon color="#fff" name="check" size={19} />}<Text style={styles.saveText}>{saving ? 'กำลังบันทึก...' : 'บันทึกงบเดือนนี้'}</Text></LinearGradient></Touchable>
      </>}
    </ScrollView><UserTabBar active="smartlife_finance_day" onNavigate={onNavigate} />
  </View></ResponsiveSafeArea>;
}

function HeroStat({label, value}: {label: string; value: string}) { return <View style={styles.heroStat}><Text style={styles.heroStatLabel}>{label}</Text><Text style={styles.heroStatValue}>{value}</Text></View>; }
function ModeButton({active, icon, label, onPress}: {active: boolean; icon: string; label: string; onPress: () => void}) { return <Touchable accessibilityRole="button" onPress={onPress} style={[styles.modeButton, active && styles.modeButtonActive]}><MaterialIcon color={active ? '#fff' : C.muted} name={icon} size={17} /><Text style={[styles.modeText, active && styles.modeTextActive]}>{label}</Text></Touchable>; }
function BudgetSplit({amount, color, label, percent}: {amount: number; color: string; label: string; percent: number}) { return <View style={styles.split}><View style={styles.splitTop}><Text style={styles.splitLabel}>{label}</Text><Text style={styles.splitAmount}>{money(amount)}</Text></View><View style={styles.splitTrack}><View style={[styles.splitFill, {backgroundColor: color, width: `${percent}%`}]} /></View></View>; }

const shadow = {shadowColor: '#29351f', shadowOffset: {height: 8, width: 0}, shadowOpacity: .07, shadowRadius: 18};
const styles = StyleSheet.create({
  amountInput: {color: C.ink, flex: 1, fontFamily: F.x, fontSize: 25, minHeight: 52, padding: 0},
  applyButton: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 15, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 15, minHeight: 48}, applyButtonDone: {backgroundColor: C.sageSoft}, applyText: {color: '#fff', fontFamily: F.b, fontSize: 12}, applyTextDone: {color: C.sage},
  back: {alignItems: 'center', backgroundColor: '#fff', borderRadius: 19, height: 42, justifyContent: 'center', width: 42}, card: {...shadow, backgroundColor: '#fff', borderRadius: 21, marginTop: 14, padding: 16}, cardHeader: {alignItems: 'center', flexDirection: 'row', gap: 10}, cardIcon: {alignItems: 'center', backgroundColor: C.accentSoft, borderRadius: 15, height: 42, justifyContent: 'center', width: 42}, cardSub: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2}, cardTitle: {color: C.ink, fontFamily: F.b, fontSize: 13}, content: {padding: 20, paddingBottom: 26}, currency: {color: C.sage, fontFamily: F.x, fontSize: 25, marginRight: 7}, disabled: {opacity: .6}, emptySuggestion: {alignItems: 'center', gap: 7, paddingVertical: 23}, emptySuggestionText: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, maxWidth: 245, textAlign: 'center'},
  errorBanner: {alignItems: 'flex-start', backgroundColor: C.redSoft, borderRadius: 16, flexDirection: 'row', gap: 9, marginTop: 14, padding: 13}, errorText: {color: '#8c5a55', fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2}, errorTitle: {color: C.red, fontFamily: F.b, fontSize: 12},
  eyebrow: {color: C.sage, fontFamily: F.b, fontSize: 12}, fieldLabel: {color: C.ink, fontFamily: F.b, fontSize: 12},
  formErrorBox: {alignItems: 'center', backgroundColor: C.redSoft, borderRadius: 13, flexDirection: 'row', gap: 8, marginTop: 13, padding: 11}, formErrorText: {color: C.red, flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  formSuccessBox: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 13, flexDirection: 'row', gap: 8, marginTop: 13, padding: 11}, formSuccessText: {color: C.sage, flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  header: {alignItems: 'center', flexDirection: 'row', gap: 10}, headerCopy: {flex: 1}, headerIcon: {alignItems: 'center', backgroundColor: C.accent, borderRadius: 21, height: 42, justifyContent: 'center', width: 42}, hero: {...shadow, borderRadius: 23, marginTop: 16, overflow: 'hidden', padding: 18}, heroAmount: {color: '#fff', fontFamily: F.x, fontSize: 32, marginTop: 2}, heroEyebrow: {color: 'rgba(255,255,255,.8)', fontFamily: F.s, fontSize: 12}, heroGlow: {backgroundColor: 'rgba(255,255,255,.15)', borderBottomLeftRadius: 90, height: 110, position: 'absolute', right: 0, top: 0, width: 110}, heroStat: {flex: 1}, heroStatLabel: {color: 'rgba(255,255,255,.7)', fontFamily: F.r, fontSize: 12}, heroStatRow: {borderTopColor: 'rgba(255,255,255,.22)', borderTopWidth: 1, flexDirection: 'row', gap: 18, marginTop: 14, paddingTop: 11}, heroStatValue: {color: '#fff', fontFamily: F.b, fontSize: 12, marginTop: 1}, heroText: {color: 'rgba(255,255,255,.82)', fontFamily: F.r, fontSize: 12}, inputHint: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 7}, inputShell: {alignItems: 'center', backgroundColor: '#f6f8f4', borderColor: C.line, borderRadius: 15, borderWidth: 1, flexDirection: 'row', marginTop: 8, paddingHorizontal: 14}, loading: {alignItems: 'center', gap: 9, paddingVertical: 100}, loadingText: {color: C.muted, fontFamily: F.r, fontSize: 12}, modeBar: {backgroundColor: '#fff', borderRadius: 17, flexDirection: 'row', marginTop: 14, padding: 5}, modeButton: {alignItems: 'center', borderRadius: 13, flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 43}, modeButtonActive: {backgroundColor: C.ink}, modeText: {color: C.muted, fontFamily: F.b, fontSize: 12}, modeTextActive: {color: '#fff'},
  noticeBanner: {alignItems: 'flex-start', backgroundColor: C.amberSoft, borderRadius: 16, flexDirection: 'row', gap: 9, marginTop: 14, padding: 13}, noticeText: {color: '#8a6a3c', fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2}, noticeTitle: {color: C.amber, fontFamily: F.b, fontSize: 12},
  progressFill: {borderRadius: 99, height: 10}, progressLabel: {color: C.ink, fontFamily: F.b, fontSize: 12}, progressTop: {alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9}, progressTrack: {backgroundColor: '#e4e8e2', borderRadius: 99, height: 10, overflow: 'hidden'}, progressValue: {color: C.muted, fontFamily: F.s, fontSize: 12},
  recommendation: {alignItems: 'baseline', backgroundColor: '#f2f5ef', borderRadius: 15, flexDirection: 'row', justifyContent: 'space-between', marginTop: 15, paddingHorizontal: 13, paddingVertical: 11}, recommendationAmount: {color: C.ink, fontFamily: F.x, fontSize: 21}, recommendationLabel: {color: C.sage, fontFamily: F.b, fontSize: 12},
  retryButton: {backgroundColor: '#fff', borderRadius: 11, paddingHorizontal: 12, paddingVertical: 8}, retryText: {color: C.red, fontFamily: F.b, fontSize: 12},
  safe: {backgroundColor: C.mist, flex: 1}, save: {alignItems: 'center', borderRadius: 17, flexDirection: 'row', gap: 8, height: 54, justifyContent: 'center'}, saveShell: {...shadow, borderRadius: 17, marginTop: 15, overflow: 'hidden'}, saveText: {color: '#fff', fontFamily: F.b, fontSize: 13}, screen: {backgroundColor: C.mist, flex: 1}, shareAmount: {color: C.ink, fontFamily: F.x, fontSize: 24, marginTop: 3}, shareCell: {alignItems: 'center', backgroundColor: '#f2f5ef', borderRadius: 15, flex: 1, paddingHorizontal: 11, paddingVertical: 14}, shareLabel: {color: C.sage, fontFamily: F.b, fontSize: 12}, shareRow: {flexDirection: 'row', gap: 10, marginTop: 15}, split: {marginTop: 13}, splitAmount: {color: C.ink, fontFamily: F.b, fontSize: 12}, splitFill: {borderRadius: 99, height: 9}, splitLabel: {color: C.muted, fontFamily: F.s, fontSize: 12}, splitTop: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6}, splitTrack: {backgroundColor: '#e4e8e2', borderRadius: 99, height: 9, overflow: 'hidden'},
  statusInline: {alignItems: 'center', borderRadius: 13, flexDirection: 'row', gap: 8, marginTop: 13, padding: 11}, statusInlineText: {flex: 1, fontFamily: F.b, fontSize: 12},
  title: {color: C.ink, fontFamily: F.x, fontSize: 20}, unsavedHint: {color: C.amber, fontFamily: F.m, fontSize: 12, marginTop: 9, textAlign: 'center'},
});
