import {
  AccessibilityInfo,
  Animated,
  Easing,
  findNodeHandle,
  Modal,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';

export type AsyncActionStatus = 'idle' | 'confirming' | 'loading' | 'success' | 'error';

type AsyncPressHandler = () => Promise<unknown> | unknown;
type ButtonVariant = 'primary' | 'secondary' | 'danger';

type LoadingConfirmationButtonProps = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  loading?: boolean;
  loadingLabel?: string;
  onError?: (error: unknown) => void;
  onPress: AsyncPressHandler;
  style?: StyleProp<ViewStyle>;
  variant?: ButtonVariant;
};

type SuccessCheckmarkAnimationProps = {
  accessibilityLabel?: string;
  durationMs?: number;
  onAnimationComplete?: () => void;
  size?: number;
  visible?: boolean;
};

type AsyncActionOverlayProps = {
  allowDismissWhileLoading?: boolean;
  cancelLabel?: string;
  children?: ReactNode;
  confirmLabel?: string;
  errorMessage?: string;
  loadingMessage?: string;
  message?: string;
  onCancel?: () => void;
  onConfirm?: AsyncPressHandler;
  onRequestClose?: () => void;
  onRetry?: AsyncPressHandler;
  onSuccessAnimationComplete?: () => void;
  retryLabel?: string;
  slowAfterMs?: number;
  slowMessage?: string;
  status: AsyncActionStatus;
  successMessage?: string;
  testID?: string;
  title: string;
  visible?: boolean;
};

const lightPalette = {
  backdrop: 'rgba(27, 37, 27, .64)',
  body: '#6f7c6d',
  border: 'rgba(255, 255, 255, .84)',
  danger: '#9a5a56',
  dangerSoft: '#f9ece9',
  panel: ['#fbfcf8', '#eef4e9', '#ececf5'] as const,
  primary: ['#759871', '#4f774c'] as const,
  secondary: '#eef3eb',
  secondaryText: '#586b56',
  success: ['#89aa82', '#52794e'] as const,
  title: '#2d3b2d',
};

const darkPalette = {
  backdrop: 'rgba(8, 12, 8, .78)',
  body: '#c5cec2',
  border: 'rgba(222, 235, 217, .17)',
  danger: '#e7a19a',
  dangerSoft: '#4b302f',
  panel: ['#273026', '#20291f', '#272837'] as const,
  primary: ['#7da177', '#52794e'] as const,
  secondary: '#354034',
  secondaryText: '#d7dfd4',
  success: ['#89aa82', '#52794e'] as const,
  title: '#f1f5ef',
};

function useReducedMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => mounted && setReducedMotion(enabled))
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}

function usePalette() {
  return useColorScheme() === 'dark' ? darkPalette : lightPalette;
}

export function SuccessCheckmarkAnimation({
  accessibilityLabel = 'ดำเนินการสำเร็จ',
  durationMs = 820,
  onAnimationComplete,
  size = 80,
  visible = true,
}: SuccessCheckmarkAnimationProps) {
  const reducedMotion = useReducedMotionPreference();
  const [ringOpacity] = useState(() => new Animated.Value(0));
  const [ringScale] = useState(() => new Animated.Value(.72));
  const [checkOpacity] = useState(() => new Animated.Value(0));
  const [checkScale] = useState(() => new Animated.Value(.5));
  const completed = useRef(onAnimationComplete);

  useEffect(() => {
    completed.current = onAnimationComplete;
  }, [onAnimationComplete]);

  useEffect(() => {
    ringOpacity.stopAnimation();
    ringScale.stopAnimation();
    checkOpacity.stopAnimation();
    checkScale.stopAnimation();

    if (!visible) {
      ringOpacity.setValue(0);
      ringScale.setValue(.72);
      checkOpacity.setValue(0);
      checkScale.setValue(.5);
      return;
    }

    if (reducedMotion) {
      ringOpacity.setValue(1);
      ringScale.setValue(1);
      checkOpacity.setValue(1);
      checkScale.setValue(1);
      // Reduced motion still keeps the static success state visible long enough
      // to communicate completion without relying on movement.
      const timer = setTimeout(() => completed.current?.(), Math.min(1200, Math.max(700, durationMs)));
      return () => clearTimeout(timer);
    }

    const safeDuration = Math.min(900, Math.max(700, durationMs));
    const ringDuration = Math.round(safeDuration * .34);
    const checkDuration = Math.round(safeDuration * .4);
    const settleDuration = safeDuration - ringDuration - checkDuration;
    ringOpacity.setValue(0);
    ringScale.setValue(.72);
    checkOpacity.setValue(0);
    checkScale.setValue(.5);

    const animation = Animated.sequence([
      Animated.parallel([
        Animated.timing(ringOpacity, {duration: ringDuration, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true}),
        Animated.timing(ringScale, {duration: ringDuration, easing: Easing.out(Easing.back(1.25)), toValue: 1.08, useNativeDriver: true}),
      ]),
      Animated.parallel([
        Animated.timing(checkOpacity, {duration: checkDuration, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true}),
        Animated.timing(checkScale, {duration: checkDuration, easing: Easing.out(Easing.back(1.7)), toValue: 1, useNativeDriver: true}),
      ]),
      Animated.timing(ringScale, {duration: settleDuration, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true}),
    ]);
    animation.start(({finished}) => finished && completed.current?.());
    return () => animation.stop();
  }, [checkOpacity, checkScale, durationMs, reducedMotion, ringOpacity, ringScale, visible]);

  return (
    <Animated.View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      style={[
        styles.successCircle,
        {height: size, opacity: ringOpacity, transform: [{scale: ringScale}], width: size},
      ]}>
      <LinearGradient colors={lightPalette.success} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={StyleSheet.absoluteFill} />
      <Animated.Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.successCheck,
          {fontSize: Math.round(size * .48), opacity: checkOpacity, transform: [{scale: checkScale}]},
        ]}>
        ✓
      </Animated.Text>
    </Animated.View>
  );
}

export function LoadingConfirmationButton({
  accessibilityLabel,
  disabled = false,
  label,
  loading = false,
  loadingLabel = 'กำลังดำเนินการ…',
  onError,
  onPress,
  style,
  variant = 'primary',
}: LoadingConfirmationButtonProps) {
  const palette = usePalette();
  const inFlight = useRef(false);
  const [internalLoading, setInternalLoading] = useState(false);
  const busy = loading || internalLoading;
  const blocked = disabled || busy;

  const handlePress = useCallback(async () => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setInternalLoading(true);
    try {
      await onPress();
    } catch (error) {
      if (onError) onError(error);
      else console.warn('[AsyncActionUI] Button action failed without an onError handler.', error);
    } finally {
      inFlight.current = false;
      setInternalLoading(false);
    }
  }, [blocked, onError, onPress]);

  const content = (
    <View style={styles.buttonContent}>
      {busy ? <LoadingGlyph color={variant === 'secondary' ? palette.secondaryText : '#ffffff'} size={18} /> : null}
      <Text style={[styles.buttonText, variant === 'secondary' && {color: palette.secondaryText}]}>
        {busy ? loadingLabel : label}
      </Text>
    </View>
  );

  return (
    <Touchable
      accessibilityLabel={accessibilityLabel ?? (busy ? loadingLabel : label)}
      accessibilityRole="button"
      accessibilityState={{busy, disabled: blocked}}
      disabled={blocked}
      onPress={() => void handlePress()}
      style={({pressed}) => [styles.button, style, pressed && !blocked && styles.buttonPressed, blocked && styles.buttonDisabled]}>
      {variant === 'secondary' ? (
        <View style={[styles.buttonSurface, {backgroundColor: palette.secondary}]}>{content}</View>
      ) : (
        <LinearGradient
          colors={variant === 'danger' ? ['#bd7770', '#965750'] : palette.primary}
          end={{x: 1, y: 1}}
          start={{x: 0, y: 0}}
          style={styles.buttonSurface}>
          {content}
        </LinearGradient>
      )}
    </Touchable>
  );
}

export function AsyncActionOverlay({
  allowDismissWhileLoading = false,
  cancelLabel = 'ยกเลิก',
  children,
  confirmLabel = 'ยืนยัน',
  errorMessage,
  loadingMessage,
  message,
  onCancel,
  onConfirm,
  onRequestClose,
  onRetry,
  onSuccessAnimationComplete,
  retryLabel = 'ลองอีกครั้ง',
  slowAfterMs = 4500,
  slowMessage = 'กำลังตรวจสอบข้อมูลเพิ่มเติม อาจใช้เวลาอีกสักครู่…',
  status,
  successMessage,
  testID,
  title,
  visible = status !== 'idle',
}: AsyncActionOverlayProps) {
  const palette = usePalette();
  const reducedMotion = useReducedMotionPreference();
  const [overlayOpacity] = useState(() => new Animated.Value(0));
  const [panelScale] = useState(() => new Animated.Value(.94));
  const panelRef = useRef<View>(null);
  const loading = status === 'loading';
  const canDismiss = !loading || allowDismissWhileLoading;

  useEffect(() => {
    overlayOpacity.stopAnimation();
    panelScale.stopAnimation();
    if (!visible) {
      overlayOpacity.setValue(0);
      panelScale.setValue(.94);
      return;
    }
    if (reducedMotion) {
      overlayOpacity.setValue(1);
      panelScale.setValue(1);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(overlayOpacity, {duration: 180, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true}),
      Animated.spring(panelScale, {damping: 16, mass: .8, stiffness: 190, toValue: 1, useNativeDriver: true}),
    ]);
    animation.start();
    return () => animation.stop();
  }, [overlayOpacity, panelScale, reducedMotion, visible]);

  useEffect(() => {
    if (!visible) return;
    // `findNodeHandle` throws outright on react-native-web, so on web this
    // threw an uncaught error every time an overlay opened. The web platform
    // moves focus for a modal on its own, so skipping it there loses nothing.
    if (Platform.OS === 'web') return;
    const timer = setTimeout(() => {
      const handle = findNodeHandle(panelRef.current);
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    }, reducedMotion ? 0 : 220);
    return () => clearTimeout(timer);
  }, [reducedMotion, status, visible]);

  const close = () => {
    if (!canDismiss) return;
    onRequestClose?.();
  };
  const phaseMessage = status === 'loading'
    ? loadingMessage ?? message
    : status === 'success'
      ? successMessage ?? message
      : status === 'error'
        ? errorMessage ?? message
        : message;
  const announcement = [title, phaseMessage].filter(Boolean).join('. ');

  return (
    <Modal animationType="none" onRequestClose={close} statusBarTranslucent transparent visible={visible}>
      <Animated.View
        accessibilityViewIsModal
        style={[styles.overlay, {backgroundColor: palette.backdrop, opacity: overlayOpacity}]}
        testID={testID}>
        <Animated.View
          accessible
          accessibilityLabel={announcement}
          accessibilityLiveRegion={status === 'error' ? 'assertive' : 'polite'}
          accessibilityRole="alert"
          ref={panelRef}
          style={[
            styles.panel,
            {borderColor: palette.border, transform: [{scale: panelScale}]},
          ]}>
          <LinearGradient colors={palette.panel} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={styles.panelSurface}>
            <View pointerEvents="none" style={styles.decorativeGlow} />

            {status === 'loading' ? <LoadingGlyph color="#648761" size={78} /> : null}
            {status === 'success' ? (
              <SuccessCheckmarkAnimation onAnimationComplete={onSuccessAnimationComplete} visible />
            ) : null}
            {status === 'error' ? (
              <View style={[styles.errorBadge, {backgroundColor: palette.dangerSoft}]}>
                <Text accessibilityElementsHidden style={[styles.errorMark, {color: palette.danger}]}>!</Text>
              </View>
            ) : null}
            {status === 'confirming' ? (
              <View style={styles.confirmBadge}>
                <Text accessibilityElementsHidden style={styles.confirmMark}>✓</Text>
              </View>
            ) : null}

            <Text style={[styles.title, {color: palette.title}]}>{title}</Text>
            {phaseMessage ? <Text style={[styles.message, {color: palette.body}]}>{phaseMessage}</Text> : null}
            {loading ? <SlowLoadingMessage color={palette.body} delayMs={slowAfterMs} message={slowMessage} /> : null}
            {status === 'confirming' && children ? <View style={styles.details}>{children}</View> : null}

            {status === 'confirming' ? (
              <View accessibilityElementsHidden={false} style={styles.actions}>
                {onCancel ? <LoadingConfirmationButton label={cancelLabel} onPress={onCancel} variant="secondary" /> : null}
                {onConfirm ? <LoadingConfirmationButton label={confirmLabel} onPress={onConfirm} /> : null}
              </View>
            ) : null}
            {status === 'error' ? (
              <View accessibilityElementsHidden={false} style={styles.actions}>
                {(onCancel || onRequestClose) ? (
                  <LoadingConfirmationButton label={cancelLabel} onPress={onCancel ?? onRequestClose ?? (() => undefined)} variant="secondary" />
                ) : null}
                {onRetry ? <LoadingConfirmationButton label={retryLabel} onPress={onRetry} /> : null}
              </View>
            ) : null}
          </LinearGradient>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function LoadingGlyph({color, size}: {color: string; size: number}) {
  const reducedMotion = useReducedMotionPreference();
  const [rotation] = useState(() => new Animated.Value(0));

  useEffect(() => {
    rotation.stopAnimation();
    rotation.setValue(0);
    if (reducedMotion) return;
    const loop = Animated.loop(Animated.timing(rotation, {
      duration: 900,
      easing: Easing.linear,
      toValue: 1,
      useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, rotation]);

  const spin = rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  const stroke = Math.max(2, Math.round(size * .07));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{alignItems: 'center', height: size, justifyContent: 'center', width: size}}>
      <Animated.View
        style={{
          borderColor: `${color}33`,
          borderLeftColor: color,
          borderRadius: size / 2,
          borderTopColor: color,
          borderWidth: stroke,
          height: size,
          position: 'absolute',
          transform: [{rotate: spin}],
          width: size,
        }}
      />
      {size >= 40 ? <View style={[styles.loadingCore, {height: size * .62, width: size * .62}]}><Text style={[styles.loadingCoreText, {color}]}>SL</Text></View> : null}
    </View>
  );
}

function SlowLoadingMessage({color, delayMs, message}: {color: string; delayMs: number; message: string}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), Math.max(1000, delayMs));
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!visible) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.slowMessageBox}>
      <Text style={[styles.slowMessage, {color}]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {flexDirection: 'row', gap: 10, marginTop: 22, width: '100%'},
  button: {borderRadius: 17, flex: 1, minHeight: 50, overflow: 'hidden'},
  buttonContent: {alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'center'},
  buttonDisabled: {opacity: .56},
  buttonPressed: {opacity: .88, transform: [{scale: .985}]},
  buttonSurface: {alignItems: 'center', borderRadius: 17, flex: 1, justifyContent: 'center', minHeight: 50, paddingHorizontal: 15},
  buttonText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 12, textAlign: 'center'},
  confirmBadge: {alignItems: 'center', backgroundColor: '#e7f1e3', borderRadius: 29, height: 58, justifyContent: 'center', width: 58},
  confirmMark: {color: '#5d8059', fontFamily: 'Prompt_800ExtraBold', fontSize: 27},
  decorativeGlow: {backgroundColor: 'rgba(146, 151, 187, .15)', borderRadius: 110, height: 180, position: 'absolute', right: -76, top: -92, width: 180},
  details: {alignSelf: 'stretch', marginTop: 18},
  errorBadge: {alignItems: 'center', borderRadius: 31, height: 62, justifyContent: 'center', width: 62},
  errorMark: {fontFamily: 'Prompt_800ExtraBold', fontSize: 31},
  loadingCore: {alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, .88)', borderRadius: 999, justifyContent: 'center'},
  loadingCoreText: {fontFamily: 'Prompt_800ExtraBold', fontSize: 12},
  message: {fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 7, textAlign: 'center'},
  overlay: {alignItems: 'center', flex: 1, justifyContent: 'center', padding: 20},
  panel: {borderRadius: 29, borderWidth: 1, elevation: 18, maxWidth: 520, overflow: 'hidden', shadowColor: '#182013', shadowOffset: {height: 20, width: 0}, shadowOpacity: .31, shadowRadius: 34, width: '100%'},
  panelSurface: {alignItems: 'center', minHeight: 250, overflow: 'hidden', paddingHorizontal: 24, paddingVertical: 28},
  slowMessage: {fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, textAlign: 'center'},
  slowMessageBox: {backgroundColor: 'rgba(120, 144, 116, .10)', borderRadius: 13, marginTop: 15, paddingHorizontal: 13, paddingVertical: 9, width: '100%'},
  successCheck: {color: '#ffffff', fontFamily: 'Prompt_800ExtraBold', lineHeight: 44},
  successCircle: {alignItems: 'center', borderColor: 'rgba(255, 255, 255, .9)', borderRadius: 999, borderWidth: 4, elevation: 8, justifyContent: 'center', overflow: 'hidden', shadowColor: '#52754e', shadowOffset: {height: 10, width: 0}, shadowOpacity: .28, shadowRadius: 20},
  title: {fontFamily: 'Prompt_800ExtraBold', fontSize: 20, lineHeight: 28, marginTop: 17, textAlign: 'center'},
});
