import {useEffect, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';

import {getGroundedAcademicSuggestions, recommendationLevel, type ActivitySuggestion} from '@/services/smartlife-recommendations';
import {useCurrentClock} from '@/hooks/use-current-clock';
import {futureSuggestion} from '@/lib/ux-time';
import {MaterialIcon} from '@/screens/native/user/user-ui';

type Props = {onNavigate: (page: string) => void; uid: string};

export default function AiActivityRecommendationCard({onNavigate, uid}: Props) {
  const now = useCurrentClock();
  const [suggestion, setSuggestion] = useState<ActivitySuggestion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getGroundedAcademicSuggestions(uid)
      .then((items) => { if (active) setSuggestion(items[0] ?? null); })
      .catch(() => { if (active) setSuggestion(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [uid]);

  if (!loading && !suggestion) return null;
  if (!loading && suggestion && !futureSuggestion(suggestion, now)) return (
    <View style={styles.card}>
      <Text style={styles.detail}>ช่วงเวลาที่แนะนำผ่านไปแล้ว เปิดคำแนะนำกิจกรรมเพื่อคำนวณช่วงว่างใหม่</Text>
      <Touchable accessibilityLabel="คำนวณช่วงว่างใหม่" onPress={() => onNavigate('smartlife_add_activity')} style={styles.action}><MaterialIcon color="#fff" name="refresh" size={18} /></Touchable>
    </View>
  );

  return (
    <View style={styles.card}>
      <View style={styles.icon}><MaterialIcon color="#5f835f" name="auto_awesome" size={19} /></View>
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>SMARTLIFE AI แนะนำ</Text>
        {loading ? <View style={styles.loading}><ActivityIndicator color="#5f835f" size="small" /><Text style={styles.detail}>กำลังตรวจงานสอบ งานส่ง และช่วงว่างจริง…</Text></View> : suggestion ? <>
          <Text numberOfLines={1} style={styles.title}>{suggestion.title}</Text>
          <Text numberOfLines={2} style={styles.detail}>{suggestion.time} · {suggestion.detail}</Text>
          <View style={styles.meta}><Text style={styles.badge}>{recommendationLevel(suggestion.score)}</Text><Text numberOfLines={1} style={styles.reason}>{suggestion.reasons[0] ?? 'อิงจากข้อมูลจริงของคุณ'}</Text></View>
        </> : null}
      </View>
      <Touchable accessibilityLabel="เปิดคำแนะนำกิจกรรม" onPress={() => onNavigate('smartlife_add_activity')} style={({pressed}) => [styles.action, pressed && styles.pressed]}><MaterialIcon color="#fff" name="arrow_forward" size={18} /></Touchable>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {alignItems: 'center', backgroundColor: '#5f835f', borderRadius: 15, height: 38, justifyContent: 'center', width: 38},
  badge: {backgroundColor: '#e7efe3', borderRadius: 99, color: '#5f835f', fontFamily: 'Prompt_700Bold', fontSize: 12, overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 4},
  card: {alignItems: 'center', backgroundColor: '#fff', borderColor: 'rgba(95,131,95,.14)', borderRadius: 18, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 12},
  copy: {flex: 1},
  detail: {color: '#7f8980', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  eyebrow: {color: '#6f8f6d', fontFamily: 'Prompt_700Bold', fontSize: 12, letterSpacing: .7},
  icon: {alignItems: 'center', backgroundColor: '#e7efe3', borderRadius: 15, height: 42, justifyContent: 'center', width: 42},
  loading: {alignItems: 'center', flexDirection: 'row', gap: 7, marginTop: 2},
  meta: {alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 6},
  pressed: {opacity: .82, transform: [{scale: .96}]},
  reason: {color: '#889286', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12},
  title: {color: '#2c341b', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2},
});
