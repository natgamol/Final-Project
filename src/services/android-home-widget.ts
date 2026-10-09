import {Platform} from 'react-native';

type SmartLifeHomeWidgetPayload = {
  budgetLabel: string;
  dateLabel: string;
  dayNumber: string;
  focusTitle: string;
  headline: string;
  subheadline: string;
  updatedAtLabel: string;
};

/**
 * The widget methods are optional on purpose. The module's JS wrapper ships in
 * every bundle, so it resolves even on an installed build whose native side
 * predates the widget receivers -- and there the methods are simply missing.
 * Typing them optional makes every caller check before calling, so an older
 * build skips the widget quietly instead of throwing "undefined is not a
 * function" on each dashboard sync.
 */
type SmartLifeWidgetNativeMethods = {
  updateHomeWidgetAsync?: (
    dateLabel: string,
    dayNumber: string,
    headline: string,
    subheadline: string,
    focusTitle: string,
    budgetLabel: string,
    updatedAtLabel: string,
  ) => Promise<void>;
  updateSleepWidgetAsync?: (statusText: string) => Promise<void>;
};

let nativeModulePromise: Promise<SmartLifeWidgetNativeMethods | null> | null = null;

async function nativeModule() {
  if (Platform.OS !== 'android') return null;
  if (!nativeModulePromise) {
    nativeModulePromise = import('../../modules/smartlife-line-listener')
      .then((module) => module.default as SmartLifeWidgetNativeMethods)
      .catch(() => null);
  }
  return nativeModulePromise;
}

export async function updateAndroidHomeWidget(payload: SmartLifeHomeWidgetPayload) {
  const native = await nativeModule();
  if (typeof native?.updateHomeWidgetAsync !== 'function') return;
  await native.updateHomeWidgetAsync(
    payload.dateLabel,
    payload.dayNumber,
    payload.headline,
    payload.subheadline,
    payload.focusTitle,
    payload.budgetLabel,
    payload.updatedAtLabel,
  );
}

/**
 * The sleep widget is a second, separate home-screen widget -- just the two
 * "เข้านอน"/"ตื่นนอน" buttons -- so it gets its own status text rather than
 * reusing the dashboard summary widget's payload shape.
 */
export async function updateAndroidSleepWidget(statusText: string) {
  const native = await nativeModule();
  if (typeof native?.updateSleepWidgetAsync !== 'function') return;
  await native.updateSleepWidgetAsync(statusText);
}
