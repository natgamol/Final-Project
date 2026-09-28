import type {ReactNode} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {MaterialIcon} from '@/screens/native/user/user-ui';

/**
 * Presentation primitives shared by every admin view.
 *
 * These were previously inlined in `admin-portal.tsx`; extracting them is what
 * lets each view live in its own file without cloning the styling.
 */

export const C = {
  amber: '#c4943d',
  amberSoft: '#faf3e0',
  mist: '#f1f4ed',
  muted: '#7f897a',
  paper: '#fff',
  pine: '#213713',
  pine2: '#36552a',
  purple: '#9297bb',
  purpleSoft: '#eceef7',
  red: '#c96761',
  redSoft: '#f8e5e2',
  sage: '#6f966f',
  sageSoft: '#e7efe3',
};

export const F = {
  b: 'Prompt_700Bold',
  m: 'Prompt_500Medium',
  r: 'Prompt_400Regular',
  s: 'Prompt_600SemiBold',
  x: 'Prompt_800ExtraBold',
};

export type Data = Record<string, unknown>;
export type Tone = 'green' | 'purple' | 'rose' | 'red' | 'amber';

export function items(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Data => Boolean(item) && typeof item === 'object') : [];
}

export function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function text(value: unknown, fallback = '-') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function number(value: unknown) {
  return Number(value ?? 0).toLocaleString('th-TH');
}

export function money(value: number) {
  return `${value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('th-TH', {maximumFractionDigits: 2})} ฿`;
}

export function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function date(value: unknown) {
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime())
    ? '-'
    : new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeZone: 'Asia/Bangkok'}).format(parsed);
}

export function dateTimeFromMillis(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.DateTimeFormat('th-TH', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok'})
    .format(new Date(value));
}

export function timeFromMillis(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--:--';
  return new Intl.DateTimeFormat('th-TH', {hour: '2-digit', hour12: false, minute: '2-digit', timeZone: 'Asia/Bangkok'})
    .format(new Date(value));
}

export function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  return new Intl.DateTimeFormat('th-TH', {month: 'long', timeZone: 'Asia/Bangkok', year: 'numeric'})
    .format(new Date(Date.UTC(year, month - 1, 15)));
}

export function toneColor(tone: Tone) {
  if (tone === 'red') return C.red;
  if (tone === 'purple') return '#6572b1';
  if (tone === 'rose') return '#b98080';
  if (tone === 'amber') return C.amber;
  return C.sage;
}

/** Gradient pairs lifted from the original admin SummaryAction palette. */
export function toneGradient(tone: Tone): readonly [string, string] {
  if (tone === 'purple') return ['#eef0fb', '#e7ebf8'];
  if (tone === 'rose') return ['#F3E8E8', '#efdfdf'];
  if (tone === 'red') return ['#f8e5e2', '#f3ded9'];
  if (tone === 'amber') return ['#faf3e0', '#f6ecd2'];
  return ['#eff6ed', '#e6f0e3'];
}

export function toneBackground(tone: Tone) {
  if (tone === 'purple') return '#E8EAF3';
  if (tone === 'rose') return '#F3E8E8';
  if (tone === 'red') return C.redSoft;
  if (tone === 'amber') return C.amberSoft;
  return '#f5f8f2';
}

export function AdminCard({children, style}: {children: ReactNode; style?: object}) {
  return (
    <LinearGradient colors={['rgba(255,255,255,.99)', '#f8faf6']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={[styles.card, style]}>
      {children}
    </LinearGradient>
  );
}

export function SectionHead({title, meta, right}: {title: string; meta?: string; right?: ReactNode}) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {right ?? (meta ? <Text style={styles.sectionMeta}>{meta}</Text> : null)}
    </View>
  );
}

export function Empty({label, icon = 'inbox'}: {label: string; icon?: string}) {
  return (
    <View style={styles.empty}>
      <MaterialIcon color="#a0aaa0" name={icon} size={30} />
      <Text style={styles.emptyText}>{label}</Text>
    </View>
  );
}

export function ErrorBlock({message, onRetry}: {message: string; onRetry?: () => void}) {
  return (
    <View style={styles.errorBlock}>
      <MaterialIcon color={C.red} name="error" size={26} />
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? <SmallButton icon="refresh" label="ลองอีกครั้ง" onPress={onRetry} tone="red" /> : null}
    </View>
  );
}

export function LoadingBlock({label = 'กำลังโหลดข้อมูลจาก Firebase'}: {label?: string}) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={C.sage} size="large" />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

export function Row({icon = 'circle', title, detail, tone = 'green', side, children, onPress}: {
  children?: ReactNode;
  detail: string;
  icon?: string;
  onPress?: () => void;
  side?: string;
  title: string;
  tone?: Tone;
}) {
  const color = toneColor(tone);
  const backgroundColor = toneBackground(tone);
  const content = (
    <View style={[styles.row, {backgroundColor}]}>
      <View style={[styles.rowIcon, {backgroundColor: `${color}18`}]}><MaterialIcon color={color} name={icon} size={19} /></View>
      <View style={{flex: 1}}>
        <View style={{alignItems: 'center', flexDirection: 'row', gap: 6}}>
          <Text numberOfLines={1} style={[styles.rowTitle, {flexShrink: 1}]}>{title}</Text>
          {side ? <Text style={[styles.rowSide, {color}]}>{side}</Text> : null}
        </View>
        <Text numberOfLines={2} style={styles.rowDetail}>{detail}</Text>
        {children}
      </View>
      {onPress ? <MaterialIcon color={color} name="chevron_right" size={20} /> : null}
    </View>
  );
  if (!onPress) return content;
  return <Touchable onPress={onPress} style={({pressed}) => pressed && styles.pressed}>{content}</Touchable>;
}

export function SummaryAction({icon, label, value, accent = 'green', onPress, hint = 'ข้อมูลจาก Firebase'}: {
  accent?: 'green' | 'purple' | 'rose';
  hint?: string;
  icon: string;
  label: string;
  onPress?: () => void;
  value: unknown;
}) {
  const purple = accent === 'purple';
  const rose = accent === 'rose';
  const colors = purple ? ['#eef0fb', '#e7ebf8'] as const : rose ? ['#F3E8E8', '#F3E8E8'] as const : ['#eff6ed', '#e6f0e3'] as const;
  const iconColor = purple ? '#6572b1' : rose ? '#b98080' : '#5a8d5d';
  const iconSoft = purple ? '#d8ddf1' : rose ? '#ead4d4' : '#dcebd9';
  return (
    <Touchable disabled={!onPress} onPress={onPress} style={({pressed}) => pressed && styles.pressed}>
      <LinearGradient colors={colors} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.summaryAction}>
        <View style={[styles.summaryIcon, {backgroundColor: iconSoft}]}><MaterialIcon color={iconColor} name={icon} size={22} /></View>
        <View style={styles.summaryCopy}>
          <Text style={styles.summaryLabel}>{label}</Text>
          <Text style={[styles.summaryValue, {color: purple ? '#465382' : rose ? '#8b5d5d' : C.pine}]}>{number(value)}</Text>
          <Text style={styles.summaryHint}>{hint}</Text>
        </View>
        <MaterialIcon color={purple ? '#465382' : rose ? '#8b5d5d' : C.pine} name="chevron_right" size={23} />
      </LinearGradient>
    </Touchable>
  );
}

/** Compact metric tile used by the Notes and Finance summaries. */
export function StatTile({label, value, tone = 'green', hint}: {hint?: string; label: string; tone?: Tone; value: string}) {
  return (
    <LinearGradient colors={toneGradient(tone)} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.statTile}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.statValue, {color: toneColor(tone)}]}>{value}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </LinearGradient>
  );
}

/** Horizontal proportion bar — one segment per share, widths sum to 100%. */
export function ShareBar({segments}: {segments: {color: string; key: string; share: number}[]}) {
  const usable = segments.filter((segment) => segment.share > 0);
  if (!usable.length) return <View style={styles.shareBarEmpty} />;
  return (
    <View style={styles.shareBar}>
      {usable.map((segment) => (
        <View key={segment.key} style={{backgroundColor: segment.color, flex: Math.max(segment.share, 0.01)}} />
      ))}
    </View>
  );
}

/**
 * Horizontal bar chart of one metric per user.
 *
 * Horizontal bars are used deliberately: user labels are long Thai names or
 * email addresses, which are unreadable rotated under vertical bars. Widths
 * come from `ratio` (already normalised to the largest value), so this stays a
 * dumb renderer with no scale maths of its own.
 */
export function UserBarChart({points, color = C.sage, onSelectUser, emptyLabel = 'ยังไม่มีข้อมูล', unit = ''}: {
  color?: string;
  emptyLabel?: string;
  onSelectUser?: (uid: string) => void;
  points: {count: number; label: string; ratio: number; uid: string}[];
  unit?: string;
}) {
  if (!points.length) return <Empty icon="bar_chart" label={emptyLabel} />;
  if (points.every((point) => point.count === 0)) return <Empty icon="bar_chart" label={emptyLabel} />;

  return (
    <View style={styles.chart}>
      {points.map((point) => {
        const row = (
          <View style={styles.chartRow}>
            <Text numberOfLines={1} style={styles.chartLabel}>{point.label}</Text>
            <View style={styles.chartTrack}>
              <View style={[styles.chartFill, {backgroundColor: color, width: `${Math.max(point.ratio * 100, point.count > 0 ? 4 : 0)}%`}]} />
            </View>
            <Text style={styles.chartValue}>{number(point.count)}{unit}</Text>
          </View>
        );
        if (!onSelectUser) return <View key={point.uid}>{row}</View>;
        return (
          <Touchable
            accessibilityLabel={`ดูข้อมูลของ ${point.label}`}
            key={point.uid}
            onPress={() => onSelectUser(point.uid)}
            style={({pressed}) => pressed && styles.pressed}
          >
            {row}
          </Touchable>
        );
      })}
    </View>
  );
}

/**
 * Large, visually distinct overview section.
 *
 * The header mirrors the original admin "AI Context Audit" banner — a solid
 * two-stop gradient with white text — so the new sections read as part of the
 * same design system rather than a bolted-on redesign.
 */
export function FeatureSection({icon, title, subtitle, accent, gradient, onOpen, openLabel, children, footnote}: {
  accent: string;
  children: ReactNode;
  footnote?: string;
  gradient: readonly [string, string];
  icon: string;
  onOpen: () => void;
  openLabel: string;
  subtitle: string;
  title: string;
}) {
  return (
    <LinearGradient colors={['rgba(255,255,255,.99)', '#f8faf6']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.feature}>
      <LinearGradient colors={gradient} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.featureHead}>
        <View style={styles.featureIcon}>
          <MaterialIcon color="#fff" name={icon} size={26} />
        </View>
        <View style={{flex: 1}}>
          <Text style={styles.featureTitle}>{title}</Text>
          <Text style={styles.featureSubtitle}>{subtitle}</Text>
        </View>
      </LinearGradient>

      <View style={styles.featureBody}>
        {children}
        {footnote ? <Text style={styles.featureFootnote}>{footnote}</Text> : null}
        <Touchable onPress={onOpen} style={({pressed}) => pressed && styles.pressed}>
          <LinearGradient colors={gradient} end={{x: 1, y: 0}} start={{x: 0, y: 0}} style={styles.featureButton}>
            <Text style={styles.featureButtonText}>{openLabel}</Text>
            <MaterialIcon color="#fff" name="arrow_forward" size={18} />
          </LinearGradient>
        </Touchable>
      </View>
    </LinearGradient>
  );
}

export function Pill({label, selected, onPress, color}: {color?: string; label: string; onPress: () => void; selected: boolean}) {
  return (
    // Labelled as a filter, because several pill labels repeat as row badges
    // further down the same screen -- "ต้องตรวจสอบ" is both a filter and a
    // status badge -- and a bare label leaves them indistinguishable to a
    // screen reader. `selected` is exposed so the active filter is announced.
    <Touchable
      accessibilityLabel={`ตัวกรอง ${label}`}
      accessibilityRole="button"
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [styles.pill, selected && styles.pillActive, color && selected ? {backgroundColor: color} : null, pressed && styles.pressed]}
    >
      <Text style={[styles.pillText, selected && styles.pillTextActive]}>{label}</Text>
    </Touchable>
  );
}

export function SmallButton({icon, label, tone, onPress, loading, disabled}: {
  disabled?: boolean;
  icon: string;
  label: string;
  loading?: boolean;
  onPress: () => void;
  tone: 'green' | 'red' | 'purple' | 'amber';
}) {
  const color = tone === 'red' ? C.red : tone === 'purple' ? '#6572b1' : tone === 'amber' ? C.amber : C.sage;
  const backgroundColor = tone === 'red' ? C.redSoft : tone === 'purple' ? '#E8EAF3' : tone === 'amber' ? C.amberSoft : '#f5f8f2';
  return (
    <Touchable disabled={loading || disabled} onPress={onPress} style={({pressed}) => [styles.smallBtn, {backgroundColor}, (pressed || disabled) && styles.pressed]}>
      {loading ? <ActivityIndicator color={color} size="small" /> : <MaterialIcon color={color} name={icon} size={14} />}
      <Text style={[styles.smallBtnText, {color}]}>{loading ? '...' : label}</Text>
    </Touchable>
  );
}

export function KindBadge({kind, mapping}: {kind: string; mapping: Record<string, [string, string]>}) {
  const mapped = mapping[kind];
  if (!mapped) return null;
  const [label, colorStr] = mapped;
  let color = C.sage;
  let backgroundColor = '#f5f8f2';
  if (colorStr === 'purple') { color = '#6572b1'; backgroundColor = '#E8EAF3'; }
  else if (colorStr === 'red' || colorStr === 'rose') { color = C.red; backgroundColor = C.redSoft; }
  else if (colorStr === 'amber') { color = C.amber; backgroundColor = C.amberSoft; }
  else if (colorStr === 'muted') { color = C.muted; backgroundColor = C.mist; }
  return (
    <View style={[styles.kindBadge, {backgroundColor}]}>
      <Text style={[styles.kindBadgeText, {color}]}>{label}</Text>
    </View>
  );
}

export function Tag({label, color = C.sage, backgroundColor = '#f5f8f2'}: {backgroundColor?: string; color?: string; label: string}) {
  return <View style={[styles.kindBadge, {backgroundColor}]}><Text style={[styles.kindBadgeText, {color}]}>{label}</Text></View>;
}

const shadow = {shadowColor: C.pine, shadowOffset: {height: 10, width: 0}, shadowOpacity: 0.08, shadowRadius: 20};

export const styles = StyleSheet.create({
  actionRow: {flexDirection: 'row', gap: 8, marginTop: 8},
  audience: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 12, flexDirection: 'row', gap: 7, marginTop: 12, paddingHorizontal: 11, paddingVertical: 10},
  audienceText: {color: C.pine2, fontFamily: F.s, fontSize: 12},
  chart: {gap: 4, marginTop: 12},
  chartFill: {borderRadius: 7, height: '100%'},
  chartLabel: {color: C.pine, fontFamily: F.m, fontSize: 12, width: 96},
  chartRow: {alignItems: 'center', flexDirection: 'row', gap: 8, paddingVertical: 5},
  chartTrack: {backgroundColor: '#eaeee5', borderRadius: 7, flex: 1, height: 14, overflow: 'hidden'},
  chartValue: {color: C.pine, fontFamily: F.b, fontSize: 12, minWidth: 40, textAlign: 'right'},
  feature: {...shadow, borderColor: 'rgba(255,255,255,.85)', borderRadius: 20, borderWidth: 1, marginTop: 16, overflow: 'hidden'},
  featureBody: {padding: 15},
  featureButton: {alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 14, minHeight: 48},
  featureButtonText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  featureFootnote: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 10},
  featureHead: {alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 15, paddingVertical: 15},
  featureIcon: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.18)', borderRadius: 17, height: 50, justifyContent: 'center', width: 50},
  featureSubtitle: {color: 'rgba(255,255,255,.78)', fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2},
  featureTitle: {color: '#fff', fontFamily: F.x, fontSize: 17},
  card: {...shadow, borderColor: 'rgba(255,255,255,.85)', borderRadius: 18, borderWidth: 1, marginTop: 13, padding: 14},
  colorDot: {borderRadius: 6, height: 12, width: 12},
  composer: {padding: 15},
  composerHead: {alignItems: 'center', flexDirection: 'row', gap: 10},
  composerIcon: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 13, height: 42, justifyContent: 'center', width: 42},
  confidenceText: {color: C.muted, fontFamily: F.m, fontSize: 12},
  empty: {alignItems: 'center', gap: 7, paddingVertical: 28},
  emptyText: {color: C.muted, fontFamily: F.r, fontSize: 12},
  errorBlock: {alignItems: 'center', backgroundColor: C.redSoft, borderRadius: 14, gap: 8, marginTop: 13, padding: 18},
  errorText: {color: C.red, fontFamily: F.m, fontSize: 12, textAlign: 'center'},
  formToggle: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 44},
  formToggleText: {color: C.pine, fontFamily: F.b, fontSize: 12},
  input: {backgroundColor: '#f6f8f3', borderColor: '#e1e6dd', borderRadius: 13, borderWidth: 1, color: C.pine, fontFamily: F.m, fontSize: 12, marginTop: 5, minHeight: 46, paddingHorizontal: 12, paddingVertical: 10},
  inputLabel: {color: C.pine, fontFamily: F.s, fontSize: 12, marginTop: 13},
  insight: {...shadow, alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 12, marginTop: 13, padding: 15},
  insightSub: {color: 'rgba(255,255,255,.76)', fontFamily: F.r, fontSize: 12, marginTop: 2},
  insightTitle: {color: '#fff', fontFamily: F.b, fontSize: 14},
  kindBadge: {alignItems: 'center', borderRadius: 8, height: 20, justifyContent: 'center', paddingHorizontal: 8},
  kindBadgeText: {fontFamily: F.b, fontSize: 12},
  loading: {alignItems: 'center', gap: 10, paddingVertical: 90},
  loadingText: {color: C.muted, fontFamily: F.r, fontSize: 12},
  logout: {alignItems: 'center', backgroundColor: C.redSoft, borderColor: 'rgba(201,103,97,.22)', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', marginTop: 14, minHeight: 48},
  logoutText: {color: C.red, fontFamily: F.b, fontSize: 12},
  menu: {alignItems: 'center', borderBottomColor: 'rgba(44,52,27,.08)', borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 68, paddingVertical: 10},
  menuIcon: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 13, height: 40, justifyContent: 'center', width: 40},
  messageInput: {minHeight: 92},
  pill: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 12, height: 32, justifyContent: 'center', paddingHorizontal: 12},
  pillActive: {backgroundColor: C.pine},
  pillRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, marginTop: 12},
  pillText: {color: C.pine2, fontFamily: F.m, fontSize: 12},
  pillTextActive: {color: '#fff'},
  pressed: {opacity: 0.78, transform: [{scale: 0.987}]},
  providerBadge: {alignItems: 'center', borderRadius: 8, height: 20, justifyContent: 'center', paddingHorizontal: 8},
  providerBadgeText: {fontFamily: F.b, fontSize: 12},
  publishButton: {alignItems: 'center', backgroundColor: C.pine, borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 12, minHeight: 48},
  publishText: {color: '#fff', fontFamily: F.b, fontSize: 12},
  refreshButton: {alignItems: 'center', backgroundColor: C.sageSoft, borderRadius: 14, flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 12, minHeight: 40},
  refreshButtonText: {color: C.pine, fontFamily: F.b, fontSize: 12},
  row: {alignItems: 'center', backgroundColor: '#f5f8f2', borderRadius: 13, flexDirection: 'row', gap: 10, marginTop: 9, minHeight: 64, padding: 11},
  rowDetail: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2},
  rowIcon: {alignItems: 'center', borderRadius: 13, height: 39, justifyContent: 'center', width: 39},
  rowSide: {fontFamily: F.s, fontSize: 12},
  rowTitle: {color: C.pine, fontFamily: F.s, fontSize: 12},
  sectionHead: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  sectionMeta: {color: C.muted, fontFamily: F.r, fontSize: 12},
  sectionTitle: {color: C.pine, fontFamily: F.b, fontSize: 13},
  shareBar: {borderRadius: 6, flexDirection: 'row', height: 10, marginTop: 10, overflow: 'hidden'},
  shareBarEmpty: {backgroundColor: C.mist, borderRadius: 6, height: 10, marginTop: 10},
  smallBtn: {alignItems: 'center', borderRadius: 11, flexDirection: 'row', gap: 4, height: 32, justifyContent: 'center', paddingHorizontal: 10},
  smallBtnText: {fontFamily: F.b, fontSize: 12},
  statHint: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 2},
  statLabel: {color: C.muted, fontFamily: F.s, fontSize: 12},
  statTile: {borderRadius: 14, flexGrow: 1, flexShrink: 1, minWidth: 96, padding: 11},
  statValue: {fontFamily: F.x, fontSize: 16, marginTop: 3},
  statusDegraded: {backgroundColor: C.amber},
  statusOperational: {backgroundColor: C.sage},
  statusOutage: {backgroundColor: C.red},
  statusUnknown: {backgroundColor: C.purple},
  summaryAction: {...shadow, alignItems: 'center', borderColor: 'rgba(255,255,255,.9)', borderRadius: 18, borderWidth: 1, flexDirection: 'row', gap: 12, minHeight: 78, paddingHorizontal: 15, paddingVertical: 10},
  summaryCopy: {flex: 1},
  summaryHint: {color: C.muted, fontFamily: F.r, fontSize: 12, marginTop: 1},
  summaryIcon: {alignItems: 'center', borderRadius: 18, height: 42, justifyContent: 'center', width: 42},
  summaryLabel: {color: C.pine, fontFamily: F.b, fontSize: 12},
  summaryList: {gap: 9, marginTop: 13},
  summaryValue: {fontFamily: F.x, fontSize: 21, lineHeight: 25, marginTop: 1},
  tileRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
});
