import {useCallback, useState, type Ref} from 'react';
import {
  Platform,
  Pressable,
  type LayoutChangeEvent,
  type PressableProps,
  type PressableStateCallbackType,
  StyleSheet,
  type View,
  type ViewStyle,
} from 'react-native';

/**
 * A drop-in replacement for `Pressable` that always gives some visible
 * feedback on tap (mobile) or mouse interaction (web/desktop), so a screen
 * with no bespoke `pressed &&` styling of its own still tells the user "this
 * is tappable" instead of looking identical whether it responds to touch or
 * not.
 *
 * Web and mobile feel deliberately different: a mouse has a hover state a
 * touchscreen never does, so desktop gets a hover "lift" that grows further
 * while the mouse is actually held down, matching how buttons behave on
 * desktop apps. Touch has no hover, so mobile keeps the shrink-and-dim tap
 * feedback that reads as a physical press instead.
 *
 * On web the hover is a small rise, a grow and, for anything with a visible
 * surface, a deeper shadow. The grow is sized from the element's measured size:
 * a flat 3% is right for a small button but makes a full-width row jump by
 * ~30px, so large elements grow by a few pixels instead, with a floor so they
 * still visibly respond.
 *
 * Only elements that actually do something get the effect. A `disabled`
 * control, or one with no `onPress`/`onLongPress`, stays still, so hover never
 * promises an action that is not there.
 *
 * Swap the import and the JSX tag; `style` keeps working whether it was a
 * plain object or already a `({pressed}) => [...]` function, since this
 * layers the default feedback on top rather than replacing what is there. A
 * `transform` already in that style is kept and the scale is appended to it.
 */

const web = Platform.OS === 'web';

// Growth is a pixel budget across the element's larger side, capped as a ratio
// so small icons do not balloon, with a floor so a full-width row still visibly
// responds (12px on a 1000px row alone would be a 1% change nobody notices).
const HOVER_GROW_PX = 12;
const HOVER_MAX_RATIO = 0.03;
const HOVER_MIN_RATIO = 0.012;
const HOVER_LIFT_PX = -2;
const PRESS_GROW_PX = 14;
const PRESS_MAX_RATIO = 0.06;
const PRESS_MIN_RATIO = 0.01;
const TOUCH_PRESS_SCALE = 0.985;

function growScale(size: number, growPx: number, maxRatio: number, minRatio: number) {
  if (!size) return 1 + minRatio;
  return 1 + Math.max(minRatio, Math.min(maxRatio, growPx / size));
}

function hasSurface(style: ViewStyle | undefined) {
  const background = style?.backgroundColor;
  return typeof background === 'string' && background !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)$/.test(background);
}

export function Touchable({onLayout, ref, style, ...props}: PressableProps & {ref?: Ref<View>}) {
  const [size, setSize] = useState(0);
  const interactive = !props.disabled && Boolean(props.onPress || props.onLongPress);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const {height, width} = event.nativeEvent.layout;
    setSize(Math.max(width, height));
    onLayout?.(event);
  }, [onLayout]);

  return (
    <Pressable
      {...props}
      onLayout={handleLayout}
      ref={ref}
      style={(state: PressableStateCallbackType) => {
        const own = typeof style === 'function' ? style(state) : style;
        if (!interactive) return own;

        // react-native-web adds `hovered` to this callback at runtime; core
        // RN's type only declares `pressed`, so it has to be read via a cast.
        const hovered = Boolean((state as PressableStateCallbackType & {hovered?: boolean}).hovered);
        let scale = 1;
        let lift = 0;
        if (web && state.pressed) { scale = growScale(size, PRESS_GROW_PX, PRESS_MAX_RATIO, PRESS_MIN_RATIO); lift = HOVER_LIFT_PX / 2; }
        else if (web && hovered) { scale = growScale(size, HOVER_GROW_PX, HOVER_MAX_RATIO, HOVER_MIN_RATIO); lift = HOVER_LIFT_PX; }
        else if (!web && state.pressed) scale = TOUCH_PRESS_SCALE;

        const flat = StyleSheet.flatten(own) as ViewStyle | undefined;
        const baseTransform = flat?.transform;
        const transform = [...(Array.isArray(baseTransform) ? baseTransform : []), ...(lift ? [{translateY: lift}] : []), {scale}] as ViewStyle['transform'];
        // A raised shadow only where there is a visible surface to cast it; around
        // a bare icon or a transparent row it would draw a floating empty box.
        const raised = web && (hovered || state.pressed) && hasSurface(flat);

        return [
          webTransition,
          own,
          web && touchableStyles.webCursor,
          scale !== 1 && {transform},
          raised && touchableStyles.webRaised,
          !web && state.pressed && touchableStyles.touchPressed,
        ];
      }}
    />
  );
}

// Smooth the hover/press scale on web so it eases instead of snapping; react-native-web
// forwards these CSS transition props, and native ignores them.
const webTransition = web ? ({transitionDuration: '160ms', transitionProperty: 'transform, opacity, box-shadow', transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)'} as object) : {};

const touchableStyles = StyleSheet.create({
  touchPressed: {opacity: 0.82},
  webCursor: web ? ({cursor: 'pointer'} as object) : {},
  // A soft glow in the app's own sage green, so a hovered card lights up in
  // brand colour rather than just casting a grey shadow.
  webRaised: web ? ({boxShadow: '0 10px 26px rgba(95, 131, 95, 0.30), 0 2px 6px rgba(35, 48, 30, 0.10)'} as object) : {},
});
