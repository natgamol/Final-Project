import {useCallback, useEffect, useRef} from 'react';
import type {View} from 'react-native';

import type {TourTabKey} from '@/config/tour-steps';
import {useTour} from '@/providers/tour-provider';

type ScrollableNode = View & {scrollIntoView?: (options?: {block?: string; behavior?: string}) => void};

/** Rounded so sub-pixel jitter does not read as the element still moving. */
function rectKey(x: number, y: number, width: number, height: number) {
  return `${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`;
}

/** How often to re-read the position while waiting for it to stop changing. */
const STEP_MS = 80;
/** Identical readings in a row before the position counts as settled. */
const SETTLED_READINGS = 2;
/** Stop re-reading eventually, so a genuinely animating target cannot spin. */
const GIVE_UP_MS = 1600;

/**
 * Attach the returned `ref` + `onLayout` to whatever real button a tour step
 * should spotlight. It only measures while that exact step is the active
 * one, so screens pay nothing for this outside of a running tour.
 */
export function useTourTarget(tabKey: TourTabKey, stepId: string) {
  const {activeTab, activeStepId, registerTarget} = useTour();
  const ref = useRef<View>(null);
  const active = activeTab === tabKey && activeStepId === stepId;

  const measure = useCallback((report?: (key: string | null) => void) => {
    if (!active) { report?.(null); return; }
    const node = ref.current as ScrollableNode | null;
    if (!node) { report?.(null); return; }
    node.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) { report?.(null); return; }
      // A target further down a scrolling screen (e.g. dashboard's weekly
      // spending card) can lay out below the fold, which would spotlight an
      // invisible rect. `scrollIntoView` only exists on react-native-web's
      // DOM nodes, so this is a no-op on native and simply skips the target
      // there instead of crashing.
      const viewportHeight = typeof window === 'undefined' ? Infinity : window.innerHeight;
      const offscreen = y < 0 || y + height > viewportHeight;
      if (offscreen && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({block: 'center', behavior: 'instant'});
        requestAnimationFrame(() => {
          node.measureInWindow((x2, y2, width2, height2) => {
            if (width2 <= 0 || height2 <= 0) { report?.(null); return; }
            registerTarget(tabKey, stepId, {x: x2, y: y2, width: width2, height: height2});
            report?.(rectKey(x2, y2, width2, height2));
          });
        });
        return;
      }
      registerTarget(tabKey, stepId, {x, y, width, height});
      report?.(rectKey(x, y, width, height));
    });
  }, [active, tabKey, stepId, registerTarget]);

  useEffect(() => {
    if (!active) return undefined;
    // Re-read the position until it stops changing, rather than reading once
    // after a fixed delay and trusting the number.
    //
    // A single timed measurement was wrong on two counts. These targets sit
    // inside a `Reveal`, whose FadeInDown needs its stagger delay plus 420ms
    // to bring the element to rest -- 490ms for the finance period bar -- so
    // the old 120ms reading caught it mid-flight and pinned the ring to a
    // position the element was only passing through. And the correction that
    // should have followed never came: on web `onLayout` is backed by a
    // ResizeObserver, which reports size changes, not an element sliding into
    // place, so nothing re-measured once it arrived. Anything above the target
    // finishing later -- an async budget banner, a sync card -- shifted it the
    // same way, with the same silence.
    //
    // Each reading is registered as it happens, so the ring tracks the target
    // into place instead of jumping once at the end.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey: string | null = null;
    let matches = 0;
    let waited = 0;

    const again = () => {
      waited += STEP_MS;
      if (waited < GIVE_UP_MS) timer = setTimeout(tick, STEP_MS);
    };

    const tick = () => {
      if (cancelled) return;
      measure((key) => {
        if (cancelled) return;
        if (key && key === lastKey) {
          matches += 1;
          if (matches >= SETTLED_READINGS) return;
        } else {
          matches = 0;
          lastKey = key;
        }
        again();
      });
    };

    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [active, measure]);

  // `onLayout` hands its listener a layout event; swallow it so it is never
  // mistaken for the `report` callback.
  const onLayout = useCallback(() => measure(), [measure]);

  return {ref, onLayout};
}
