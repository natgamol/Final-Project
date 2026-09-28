import {useEffect} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Animated, {Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming} from 'react-native-reanimated';

import {TOUR_STEPS} from '@/config/tour-steps';
import {useTour} from '@/providers/tour-provider';

const ACCENT = '#6f8f6d';
const ACCENT_DARK = '#5f835f';
const INK = '#2c341b';
const SCRIM = 'rgba(20, 26, 17, 0.58)';
const GAP = 6;

/**
 * Mounted once at the app root, beside `ToastHost`. Renders nothing unless a
 * tour step is active AND its real on-screen target has been measured, so
 * there is never a flash of a scrim with no highlight to show for it.
 */
export default function TourOverlay() {
  const {activeTab, activeStepId, stepIndex, target, next, skip} = useTour();
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();

  const enter = useSharedValue(0);
  const ring = useSharedValue(1);

  useEffect(() => {
    if (!target) return;
    enter.value = 0;
    enter.value = withTiming(1, {duration: 260, easing: Easing.out(Easing.cubic)});
    ring.value = 1;
    ring.value = withRepeat(withSequence(
      withTiming(1.06, {duration: 700, easing: Easing.inOut(Easing.quad)}),
      withTiming(1, {duration: 700, easing: Easing.inOut(Easing.quad)}),
    ), -1, false);
    // Restart the entrance/breathing animation every time a new target appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeStepId, Boolean(target)]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{translateY: (1 - enter.value) * 14}],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{scale: ring.value}],
  }));

  if (!activeTab || !activeStepId || !target) return null;
  const steps = TOUR_STEPS[activeTab];
  const step = steps[stepIndex];
  if (!step) return null;
  const isLast = stepIndex + 1 >= steps.length;

  const rect = {
    height: target.height + GAP * 2,
    left: target.x - GAP,
    top: target.y - GAP,
    width: target.width + GAP * 2,
  };
  const radius = Math.min(step.radius ?? 16, rect.width / 2, rect.height / 2);

  const showCardBelow = rect.top < windowHeight / 2;
  const cardVerticalStyle = showCardBelow
    ? {top: Math.min(rect.top + rect.height + 16, windowHeight - insets.bottom - 220)}
    : {bottom: Math.max(windowHeight - rect.top + 16, insets.bottom + 16)};

  return (
    <View pointerEvents="auto" style={StyleSheet.absoluteFill}>
      {/* Four scrim bands around the target rect, dimming everything except the spotlight. */}
      <View style={[styles.band, {height: Math.max(rect.top, 0), left: 0, right: 0, top: 0}]} />
      <View style={[styles.band, {bottom: 0, left: 0, right: 0, top: rect.top + rect.height}]} />
      <View style={[styles.band, {height: rect.height, left: 0, top: rect.top, width: Math.max(rect.left, 0)}]} />
      <View style={[styles.band, {height: rect.height, left: rect.left + rect.width, right: 0, top: rect.top}]} />

      <Animated.View
        pointerEvents="none"
        style={[styles.ring, ringStyle, {
          borderRadius: radius,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          width: rect.width,
        }]}
      />

      <Animated.View style={[styles.card, cardStyle, cardVerticalStyle, {marginHorizontal: 16}]}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={styles.title}>{step.title}</Text>
          <Touchable accessibilityLabel="ข้ามคำแนะนำ" hitSlop={8} onPress={skip}>
            <Text style={styles.skip}>ข้าม</Text>
          </Touchable>
        </View>
        <Text style={styles.description}>{step.description}</Text>
        <View style={styles.footerRow}>
          <View style={styles.dots}>
            {steps.map((entry, index) => (
              <View key={entry.id} style={[styles.dot, index === stepIndex && styles.dotActive]} />
            ))}
          </View>
          <Touchable accessibilityLabel={isLast ? 'เข้าใจแล้ว' : 'ถัดไป'} onPress={next} style={({pressed}) => [styles.nextButton, pressed && styles.nextButtonPressed]}>
            <Text style={styles.nextText}>{isLast ? 'เข้าใจแล้ว' : 'ถัดไป'}</Text>
          </Touchable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {backgroundColor: SCRIM, position: 'absolute'},
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 18,
    position: 'absolute',
    shadowColor: INK,
    shadowOffset: {height: 12, width: 0},
    shadowOpacity: .22,
    shadowRadius: 26,
    left: 0,
    right: 0,
  },
  description: {color: '#6b7268', fontSize: 14, lineHeight: 20, marginBottom: 16},
  dot: {backgroundColor: '#dfe7dc', borderRadius: 3, height: 6, width: 6},
  dotActive: {backgroundColor: ACCENT_DARK, width: 16},
  dots: {flexDirection: 'row', gap: 5},
  footerRow: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  handle: {alignSelf: 'center', backgroundColor: '#e2e6dd', borderRadius: 3, height: 4, marginBottom: 12, width: 36},
  headerRow: {alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6},
  nextButton: {backgroundColor: ACCENT, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 11},
  nextButtonPressed: {opacity: .85},
  nextText: {color: '#ffffff', fontSize: 14, fontWeight: '700'},
  ring: {borderColor: ACCENT, borderWidth: 2.5, position: 'absolute'},
  skip: {color: '#8b9085', fontSize: 13.5, fontWeight: '600', paddingLeft: 12, paddingVertical: 2},
  title: {color: INK, flex: 1, fontSize: 17, fontWeight: '800'},
});
