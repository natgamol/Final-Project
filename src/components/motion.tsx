import {useEffect, useRef, useState, type ReactNode} from 'react';
import {AccessibilityInfo, Platform, Text, type StyleProp, type TextProps, type TextStyle, type ViewStyle} from 'react-native';
import Animated, {Easing, FadeIn, FadeInDown, ReduceMotion} from 'react-native-reanimated';

/**
 * Wraps a screen section so it fades in and rises a few pixels, staggered by
 * `index` so a screen assembles top to bottom instead of appearing all at
 * once. Plays once when the section mounts. `slide={false}` fades only, for
 * anything the guided tour measures, so its highlight never lands on a card
 * that is still mid-rise.
 */
export function Reveal({children, index = 0, slide = true, style}: {children: ReactNode; index?: number; slide?: boolean; style?: StyleProp<ViewStyle>}) {
  const enter = slide ? FadeInDown : FadeIn;
  const timed = enter.delay(Math.min(index * 70, 420)).duration(420);
  // react-native-web cannot run custom easing curves for layout animations; it
  // logs a warning and falls back to linear, which looks mechanical. Its own
  // default curve is the smoother choice there.
  const entering = (Platform.OS === 'web' ? timed : timed.easing(Easing.out(Easing.cubic))).reduceMotion(ReduceMotion.System);
  return <Animated.View entering={entering} style={style}>{children}</Animated.View>;
}

/**
 * Counts a number up from zero to `value` when it first shows, then eases
 * between values on later changes. Reads as data arriving rather than a
 * static number. With reduced motion on it just shows the final value.
 */
export function AnimatedNumber({duration = 750, format = (n: number) => String(Math.round(n)), style, value, ...rest}: {duration?: number; format?: (n: number) => string; style?: StyleProp<TextStyle>; value: number} & Omit<TextProps, 'style'>) {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    const from = shownRef.current;
    const step = (start: number) => (now: number) => {
      if (cancelled) return;
      const t = Math.min((now - start) / duration, 1);
      const next = from + (value - from) * (1 - Math.pow(1 - t, 3));
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step(start));
    };
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced || from === value) { shownRef.current = value; setShown(value); return; }
      frame = requestAnimationFrame((now) => step(now)(now));
    }).catch(() => { shownRef.current = value; setShown(value); });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [duration, value]);
  return <Text {...rest} style={style}>{format(shown)}</Text>;
}
