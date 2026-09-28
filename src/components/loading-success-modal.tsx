import {useEffect, useState} from 'react';
import {Animated, Easing, Modal, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

export type FeedbackPhase = 'loading' | 'success';

/**
 * Seconds since this was put on screen.
 *
 * Its own component so the count resets by mounting rather than by an effect
 * writing state during a render pass. It stays mounted across a job's stages,
 * so what the reader sees is the whole wait, not the current step.
 */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text style={styles.elapsed}>
    {`รอแล้ว ${seconds} วินาที${seconds >= 30 ? ' · ใช้เวลานานกว่าปกติ ไม่ต้องกดซ้ำ' : ''}`}
  </Text>;
}

export default function LoadingAndSuccessModal({
  onCancel,
  phase,
  showElapsed = false,
  subtitle,
  title,
  visible,
}: {
  onCancel?: () => void;
  phase: FeedbackPhase;
  showElapsed?: boolean;
  subtitle: string;
  title: string;
  visible: boolean;
}) {
  const [fade] = useState(() => new Animated.Value(0));
  const [pop] = useState(() => new Animated.Value(.72));
  const [rotate] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(1));
  const [progressWidth] = useState(() => new Animated.Value(0.2));

  useEffect(() => {
    if (!visible) {
      fade.setValue(0);
      return;
    }

    let spinnerLoop: Animated.CompositeAnimation | null = null;
    let pulseLoop: Animated.CompositeAnimation | null = null;
    let progressLoop: Animated.CompositeAnimation | null = null;

    Animated.timing(fade, {duration: 220, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true}).start();

    if (phase === 'loading') {
      pop.setValue(.9);
      rotate.setValue(0);
      Animated.spring(pop, {damping: 14, mass: .8, stiffness: 170, toValue: 1, useNativeDriver: true}).start();

      spinnerLoop = Animated.loop(Animated.timing(rotate, {
        duration: 980,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }));
      spinnerLoop.start();

      pulseLoop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, {duration: 700, easing: Easing.inOut(Easing.quad), toValue: 1.08, useNativeDriver: true}),
        Animated.timing(pulse, {duration: 700, easing: Easing.inOut(Easing.quad), toValue: 0.95, useNativeDriver: true}),
      ]));
      pulseLoop.start();

      progressLoop = Animated.loop(Animated.sequence([
        Animated.timing(progressWidth, {duration: 1200, easing: Easing.inOut(Easing.quad), toValue: 0.85, useNativeDriver: false}),
        Animated.timing(progressWidth, {duration: 1000, easing: Easing.inOut(Easing.quad), toValue: 0.35, useNativeDriver: false}),
      ]));
      progressLoop.start();
    } else {
      pulse.setValue(1);
      Animated.timing(progressWidth, {duration: 250, easing: Easing.out(Easing.quad), toValue: 1, useNativeDriver: false}).start();
      pop.setValue(.4);
      Animated.sequence([
        Animated.spring(pop, {damping: 8, mass: .7, stiffness: 220, toValue: 1.12, useNativeDriver: true}),
        Animated.spring(pop, {damping: 12, mass: .6, stiffness: 180, toValue: 1, useNativeDriver: true}),
      ]).start();
    }

    return () => {
      spinnerLoop?.stop();
      pulseLoop?.stop();
      progressLoop?.stop();
    };
  }, [fade, phase, pop, progressWidth, pulse, rotate, visible]);

  const spin = rotate.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  const dynamicWidth = progressWidth.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return <Modal animationType="none" statusBarTranslucent transparent visible={visible}>
    <Animated.View accessibilityLabel={`${title}. ${subtitle}`} accessibilityLiveRegion="polite" accessibilityViewIsModal style={[styles.overlay, {opacity: fade}]}>
      <LinearGradient colors={['rgba(31,45,25,.84)', 'rgba(52,61,43,.76)', 'rgba(88,80,105,.70)']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />
      <Animated.View style={[styles.panel, {transform: [{scale: pop}]}]}>
        <LinearGradient colors={phase === 'success' ? ['#f7fbf4', '#edf4e8', '#ecebf5'] : ['#f9fbf6', '#eef2e9', '#e9eaf4']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.panelGradient}>
          <View style={styles.glow} />
          {phase === 'loading' ? <View style={styles.spinnerTrack}>
            <Animated.View style={[styles.spinnerArc, {transform: [{rotate: spin}]}]} />
            <Animated.View style={[styles.spinnerCore, {transform: [{scale: pulse}]}]}>
              <Text style={styles.spinnerMark}>SL</Text>
            </Animated.View>
          </View> : <Animated.View style={{transform: [{scale: pop}]}}>
            <LinearGradient colors={['#89aa82', '#547a50']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.checkCircle}>
              <Text style={styles.check}>✓</Text>
            </LinearGradient>
          </Animated.View>}
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {showElapsed && phase === 'loading' ? <ElapsedSeconds /> : null}
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFillContainer, {width: dynamicWidth}]}>
              <LinearGradient colors={phase === 'success' ? ['#71956d', '#9297bb'] : ['#9297bb', '#71956d', '#c1cda9']} end={{x: 1, y: 0}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />
            </Animated.View>
          </View>
          {onCancel && phase === 'loading' ? <Touchable accessibilityLabel="ยกเลิก" accessibilityRole="button" onPress={onCancel} style={({pressed}) => [styles.cancel, pressed && styles.cancelPressed]}>
            <Text style={styles.cancelText}>ยกเลิก</Text>
          </Touchable> : null}
        </LinearGradient>
      </Animated.View>
    </Animated.View>
  </Modal>;
}

const styles = StyleSheet.create({
  cancel: {alignItems: 'center', borderColor: 'rgba(44,52,27,.16)', borderRadius: 15, borderWidth: 1, marginTop: 16, paddingHorizontal: 20, paddingVertical: 8},
  cancelPressed: {backgroundColor: 'rgba(44,52,27,.06)'},
  cancelText: {color: '#5c6553', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  elapsed: {color: '#8d9487', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, marginTop: 6, textAlign: 'center'},
  check: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 34, lineHeight: 43},
  checkCircle: {alignItems: 'center', borderColor: 'rgba(255,255,255,.9)', borderRadius: 40, borderWidth: 4, height: 78, justifyContent: 'center', shadowColor: '#52754e', shadowOffset: {height: 12, width: 0}, shadowOpacity: .3, shadowRadius: 22, width: 78},
  glow: {backgroundColor: 'rgba(146,151,187,.13)', borderRadius: 120, height: 180, position: 'absolute', right: -72, top: -78, width: 180},
  overlay: {alignItems: 'center', flex: 1, justifyContent: 'center', padding: 28},
  panel: {borderColor: 'rgba(255,255,255,.74)', borderRadius: 27, borderWidth: 1, maxWidth: 330, overflow: 'hidden', shadowColor: '#182013', shadowOffset: {height: 22, width: 0}, shadowOpacity: .32, shadowRadius: 36, width: '100%'},
  panelGradient: {alignItems: 'center', minHeight: 282, overflow: 'hidden', padding: 28},
  progressComplete: {width: '100%'},
  progressFill: {borderRadius: 4, height: '100%', width: '68%'},
  progressFillContainer: {borderRadius: 4, height: '100%', overflow: 'hidden'},
  progressTrack: {backgroundColor: 'rgba(44,52,27,.09)', borderRadius: 4, height: 6, marginTop: 22, overflow: 'hidden', width: '100%'},
  spinnerArc: {borderColor: '#789a75', borderLeftColor: '#9297bb', borderRadius: 40, borderRightColor: 'rgba(120,154,117,.18)', borderWidth: 6, height: 78, position: 'absolute', width: 78},
  spinnerCore: {alignItems: 'center', backgroundColor: 'rgba(255,255,255,.88)', borderRadius: 25, height: 50, justifyContent: 'center', width: 50},
  spinnerMark: {color: '#5b7857', fontFamily: 'Prompt_700Bold', fontSize: 14},
  spinnerTrack: {alignItems: 'center', height: 78, justifyContent: 'center', width: 78},
  subtitle: {color: '#7d8678', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 5, textAlign: 'center'},
  title: {color: '#2c341b', fontFamily: 'Prompt_700Bold', fontSize: 18, marginTop: 18, textAlign: 'center'},
});
