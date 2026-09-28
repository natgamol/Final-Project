import {type ReactNode} from 'react';
import {Platform, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';

/**
 * Colour motion for the web build, the surface the app is presented on.
 *
 * Everything here animates between colours the app already uses -- the sage
 * greens, the finance lavender (#9297bb family) and the paper whites -- so the
 * palette stays exactly the same; only how it moves changes.
 *
 * All of it is plain CSS keyframes (react-native-web compiles
 * `animationKeyframes` into @keyframes), so it runs off the JS thread and costs
 * nothing on native, where each component falls back to the static look it
 * had before. When the OS asks for reduced motion the static look is used on
 * web too.
 */

const web = Platform.OS === 'web';

function reduceMotion() {
  if (!web || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Point = {x: number; y: number};
type Colors = readonly [string, string, ...string[]];

/**
 * A drop-in for `LinearGradient` whose colours slowly drift across the
 * surface, like light moving over it. Use it for hero cards.
 */
export function AuroraGradient({children, colors, end, start, style}: {children?: ReactNode; colors: Colors; end?: Point; start?: Point; style?: StyleProp<ViewStyle>}) {
  if (!web || reduceMotion()) return <LinearGradient colors={colors} end={end} start={start} style={style}>{children}</LinearGradient>;
  // c0 c1 c2 c1 c0 so the loop has no visible seam when it wraps around.
  const loop = [...colors, ...colors.slice(0, -1).reverse()];
  const image = {backgroundImage: `linear-gradient(125deg, ${loop.join(', ')})`} as unknown as ViewStyle;
  return <View style={[style, motion.aurora, image]}>{children}</View>;
}

/**
 * A soft band of light that sweeps across a button now and then. Place it as
 * the first child of a button's surface; it never takes taps.
 */
export function Sheen({radius = 0}: {radius?: number}) {
  if (!web || reduceMotion()) return null;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, motion.sheen, {borderRadius: radius}]} />;
}

/**
 * A second colour layer that fades in and out over a page background, so the
 * whole screen gently shifts tone. Opacity only, which the browser composites
 * without repainting, so it stays cheap even full-screen.
 */
export function BackdropGlow({colors}: {colors: Colors}) {
  if (!web || reduceMotion()) return null;
  return <LinearGradient colors={colors} end={{x: 0, y: 1}} pointerEvents="none" start={{x: 1, y: 0}} style={[StyleSheet.absoluteFill, motion.glow]} />;
}

/** Keyframes for a breathing ring around the main add button. */
export const pulseRingStyle: StyleProp<ViewStyle> = web && !reduceMotion() ? (StyleSheet.create({
  ring: {
    animationDuration: '2.6s',
    animationIterationCount: 'infinite',
    animationKeyframes: {
      '0%': {boxShadow: '0 8px 13px rgba(35, 48, 30, 0.28), 0 0 0 0 rgba(113, 147, 110, 0.5)'},
      '70%': {boxShadow: '0 8px 13px rgba(35, 48, 30, 0.28), 0 0 0 16px rgba(113, 147, 110, 0)'},
      '100%': {boxShadow: '0 8px 13px rgba(35, 48, 30, 0.28), 0 0 0 0 rgba(113, 147, 110, 0)'},
    },
    animationTimingFunction: 'ease-out',
  } as unknown as ViewStyle,
}).ring) : null;

const motion = StyleSheet.create({
  aurora: {
    animationDuration: '9s',
    animationIterationCount: 'infinite',
    animationKeyframes: {
      '0%': {backgroundPosition: '0% 50%'},
      '50%': {backgroundPosition: '100% 50%'},
      '100%': {backgroundPosition: '0% 50%'},
    },
    animationTimingFunction: 'ease-in-out',
    backgroundSize: '300% 300%',
  } as unknown as ViewStyle,
  glow: {
    animationDirection: 'alternate',
    animationDuration: '14s',
    animationIterationCount: 'infinite',
    animationKeyframes: {'0%': {opacity: 0}, '100%': {opacity: 1}},
    animationTimingFunction: 'ease-in-out',
    opacity: 0,
  } as unknown as ViewStyle,
  sheen: {
    animationDuration: '4.2s',
    animationIterationCount: 'infinite',
    animationKeyframes: {
      '0%': {backgroundPosition: '160% 0'},
      '45%': {backgroundPosition: '-60% 0'},
      '100%': {backgroundPosition: '-60% 0'},
    },
    animationTimingFunction: 'ease-in-out',
    backgroundImage: 'linear-gradient(105deg, rgba(255, 255, 255, 0) 38%, rgba(255, 255, 255, 0.34) 50%, rgba(255, 255, 255, 0) 62%)',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '250% 100%',
  } as unknown as ViewStyle,
});
