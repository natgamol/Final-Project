import AsyncStorage from '@react-native-async-storage/async-storage';
import {createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren} from 'react';

import {useAuth} from '@/providers/auth-provider';
import {TOUR_STEPS, TOUR_TAB_KEYS, type TourTabKey} from '@/config/tour-steps';

export type TourRect = {x: number; y: number; width: number; height: number};

const storageKey = (tabKey: TourTabKey, uid?: string) => `@smartlife/tour-seen/${tabKey}/${uid ?? 'guest'}`;

type SeenState = {ownerKey: string; tabs: Set<TourTabKey>};

type TourContextValue = {
  activeTab: TourTabKey | null;
  activeStepId: string | null;
  stepIndex: number;
  stepCount: number;
  target: TourRect | null;
  registerTarget: (tabKey: TourTabKey, stepId: string, rect: TourRect) => void;
  maybeStartTour: (tabKey: TourTabKey) => void;
  /**
   * Ends `tabKey`'s tour, if it is the running one, without marking it seen:
   * its screen stopped being the visible one, so it starts again from the
   * first step next time that screen is focused. A stable identity, so a
   * screen can call it from an effect cleanup.
   */
  leaveTour: (tabKey: TourTabKey) => void;
  next: () => void;
  skip: () => void;
  /** Clears every "seen" flag for this user and restarts at the dashboard tour. */
  restartTour: () => Promise<void>;
};

const TourContext = createContext<TourContextValue | undefined>(undefined);

export function TourProvider({children}: PropsWithChildren) {
  const {user} = useAuth();
  const uid = user?.uid;
  const ownerKey = uid ?? 'guest';
  const [seen, setSeen] = useState<SeenState | null>(null);
  const [activeTab, setActiveTab] = useState<TourTabKey | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [target, setTarget] = useState<TourRect | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const entries = await Promise.all(
        TOUR_TAB_KEYS.map(async (tab) => [tab, await AsyncStorage.getItem(storageKey(tab, uid))] as const),
      );
      if (!active) return;
      const tabs = new Set<TourTabKey>(entries.filter(([, value]) => value === 'true').map(([tab]) => tab));
      setSeen({ownerKey, tabs});
    })();
    return () => {
      active = false;
    };
  }, [ownerKey, uid]);

  const steps = activeTab ? TOUR_STEPS[activeTab] : [];
  const activeStepId = activeTab ? (steps[stepIndex]?.id ?? null) : null;

  const maybeStartTour = useCallback((tabKey: TourTabKey) => {
    if (!seen || seen.ownerKey !== ownerKey || seen.tabs.has(tabKey) || activeTab) return;
    setActiveTab(tabKey);
    setStepIndex(0);
    setTarget(null);
  }, [seen, ownerKey, activeTab]);

  const leaveTour = useCallback((tabKey: TourTabKey) => {
    // Functional update, so this needs no dependencies: a cleanup holding an
    // old copy still compares against the tour running now. The step index
    // and target are reset by `maybeStartTour` when the tour next starts, and
    // nothing is drawn while no tab is active.
    setActiveTab((current) => (current === tabKey ? null : current));
  }, []);

  const registerTarget = useCallback((tabKey: TourTabKey, stepId: string, rect: TourRect) => {
    if (activeTab !== tabKey || activeStepId !== stepId) return;
    setTarget((current) => (
      current && current.x === rect.x && current.y === rect.y && current.width === rect.width && current.height === rect.height
        ? current
        : rect
    ));
  }, [activeTab, activeStepId]);

  const finishTab = useCallback((tabKey: TourTabKey) => {
    setSeen((current) => {
      const tabs = new Set(current?.ownerKey === ownerKey ? current.tabs : []);
      tabs.add(tabKey);
      return {ownerKey, tabs};
    });
    void AsyncStorage.setItem(storageKey(tabKey, uid), 'true');
    setActiveTab(null);
    setTarget(null);
  }, [ownerKey, uid]);

  const next = useCallback(() => {
    if (!activeTab) return;
    const total = TOUR_STEPS[activeTab].length;
    if (stepIndex + 1 >= total) {
      finishTab(activeTab);
      return;
    }
    setTarget(null);
    setStepIndex((index) => index + 1);
  }, [activeTab, stepIndex, finishTab]);

  const skip = useCallback(() => {
    if (activeTab) finishTab(activeTab);
  }, [activeTab, finishTab]);

  const restartTour = useCallback(async () => {
    await Promise.all(TOUR_TAB_KEYS.map((tab) => AsyncStorage.removeItem(storageKey(tab, uid))));
    setSeen({ownerKey, tabs: new Set()});
    setActiveTab(null);
    setStepIndex(0);
    setTarget(null);
  }, [ownerKey, uid]);

  const value = useMemo<TourContextValue>(() => ({
    activeTab,
    activeStepId,
    stepIndex,
    stepCount: steps.length,
    target,
    registerTarget,
    maybeStartTour,
    leaveTour,
    next,
    skip,
    restartTour,
  }), [activeTab, activeStepId, stepIndex, steps.length, target, registerTarget, maybeStartTour, leaveTour, next, skip, restartTour]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour() {
  const value = useContext(TourContext);
  if (!value) throw new Error('useTour must be used inside TourProvider.');
  return value;
}
