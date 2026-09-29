import AsyncStorage from '@react-native-async-storage/async-storage';

import {shiftMonthKey, thailandMonthKey} from '@/lib/thailand-time';
import {readLatestRemoteBudgetBefore, readRemoteBudget, writeRemoteBudget} from '@/services/monthly-budget-remote';

export type MonthlyBudget = {
  amount: number;
  /**
   * A daily limit the user set themselves.
   *
   * Left unset when they have not, which is what keeps today's behaviour: the
   * calculators fall back to splitting the monthly amount, so the derived
   * figure follows the monthly limit whenever that changes. Storing the derived
   * number here instead would freeze it at whatever the month it was saved in
   * happened to be.
   */
  dailyAmount?: number;
  /** A weekly limit the user set themselves; see `dailyAmount`. */
  weeklyAmount?: number;
  monthKey: string;
  /** Month the amount was originally saved for, when it was carried forward. */
  rolledOverFrom?: string;
  source: 'ai' | 'manual';
  /** False when the limit is only on this device because the sync write failed. */
  synced?: boolean;
  updatedAt: string;
};

/** Upper bound for a single month's limit. Guards typos such as a stuck key. */
export const MONTHLY_BUDGET_MAX = 10_000_000;

/** How many past months are searched for a budget to carry forward. */
const ROLLOVER_LOOKBACK_MONTHS = 12;

/**
 * How long a Firestore round trip is given before the device copy is treated as
 * the answer. Offline, the SDK does not reject a write: it queues it and only
 * settles the promise once a server acknowledges it, which never comes. Without
 * a bound the save screen sat on "กำลังบันทึก…" forever instead of falling
 * through to the local path a failed write already takes.
 */
export const SYNC_TIMEOUT_MS = 6_000;

type SyncOptions = {syncTimeoutMs?: number};

class SyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Firestore did not answer within ${timeoutMs}ms`);
    this.name = 'SyncTimeoutError';
  }
}

/**
 * True only when the platform positively reports having no connection. The web
 * build answers instantly, so an offline save there never waits out the timeout
 * at all; React Native leaves `navigator.onLine` undefined, and the timeout
 * covers the phone.
 */
function knownOffline() {
  const {onLine} = (globalThis.navigator ?? {}) as {onLine?: unknown};
  return onLine === false;
}

function withSyncTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncTimeoutError(timeoutMs)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Starts the sync without waiting on it. The returned promise is pre-handled,
 * because a queued write that is still unacknowledged when the caller gives up
 * would otherwise surface as an unhandled rejection.
 */
function startSync(uid: string, budget: Pick<MonthlyBudget, 'amount' | 'dailyAmount' | 'monthKey' | 'source' | 'weeklyAmount'>) {
  const pending = writeRemoteBudget(uid, {
    amount: budget.amount,
    monthKey: budget.monthKey,
    source: budget.source,
    ...(budget.weeklyAmount ? {weeklyAmount: budget.weeklyAmount} : {}),
    ...(budget.dailyAmount ? {dailyAmount: budget.dailyAmount} : {}),
  });
  pending.catch(() => undefined);
  return pending;
}

/**
 * Clears the unsynced flag if the queued write lands after the caller stopped
 * waiting, so a save made offline becomes shared the moment the connection is
 * back rather than at the next reload. A newer save wins: only the exact copy
 * this write belongs to is upgraded.
 */
function markSyncedWhenItLands(uid: string, budget: MonthlyBudget, pending: Promise<void>) {
  void pending
    .then(async () => {
      const stored = parseStored(await AsyncStorage.getItem(storageKey(uid, budget.monthKey)), budget.monthKey);
      if (stored?.updatedAt === budget.updatedAt && stored.synced === false) {
        await writeCache(uid, {...budget, synced: true});
      }
    })
    .catch(() => undefined);
}

function storageKey(uid: string, monthKey: string) {
  return `smartlife:monthly-budget:${uid}:${monthKey}`;
}

/**
 * `YYYY-MM` for the current month in Asia/Bangkok. Spending is queried with
 * `thailandRange`, so the budget must be keyed to the same clock or the two
 * disagree for the seven hours around every month boundary on a device that is
 * not set to Bangkok time.
 */
export function currentMonthKey(date = new Date()) {
  return thailandMonthKey(date);
}

/**
 * Turns typed or pasted text into a whole-baht limit. Thousands separators are
 * dropped, but a decimal separator truncates rather than disappearing: simply
 * deleting the dot turned a pasted "12.50" into 1250, a hundredfold
 * overstatement. The number pad cannot produce a dot, so this mainly guards
 * paste and hardware keyboards.
 */
export function parseBudgetAmount(value: string) {
  const [whole] = String(value).replace(/[^\d.]/g, '').split('.');
  return Math.min(MONTHLY_BUDGET_MAX, Number(whole) || 0);
}

/** Rejects amounts that cannot represent a usable spending limit. */
export function isValidBudgetAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MONTHLY_BUDGET_MAX;
}

function parseStored(raw: string | null, monthKey: string): MonthlyBudget | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MonthlyBudget>;
    if (!isValidBudgetAmount(value.amount)) return null;
    return {
      amount: value.amount,
      monthKey,
      source: value.source === 'ai' ? 'ai' : 'manual',
      synced: value.synced !== false,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      // Read back explicitly: anything this parser does not name is dropped,
      // which would lose a user-set figure on every reload.
      ...(isValidBudgetAmount(value.weeklyAmount) ? {weeklyAmount: value.weeklyAmount} : {}),
      ...(isValidBudgetAmount(value.dailyAmount) ? {dailyAmount: value.dailyAmount} : {}),
    };
  } catch {
    return null;
  }
}

function earliestRolloverKey(monthKey: string) {
  return shiftMonthKey(monthKey, -ROLLOVER_LOOKBACK_MONTHS);
}

async function writeCache(uid: string, budget: MonthlyBudget) {
  await AsyncStorage.setItem(storageKey(uid, budget.monthKey), JSON.stringify({
    amount: budget.amount,
    monthKey: budget.monthKey,
    source: budget.source,
    synced: budget.synced !== false,
    updatedAt: budget.updatedAt,
    ...(budget.weeklyAmount ? {weeklyAmount: budget.weeklyAmount} : {}),
    ...(budget.dailyAmount ? {dailyAmount: budget.dailyAmount} : {}),
  }));
}

/**
 * Reads the device cache for `monthKey`, falling back to the most recent
 * earlier month. Used offline, and as the source for the one-time migration
 * of budgets saved before this feature moved to Firestore.
 */
async function readCache(uid: string, monthKey: string): Promise<MonthlyBudget | null> {
  const exact = parseStored(await AsyncStorage.getItem(storageKey(uid, monthKey)), monthKey);
  if (exact) return exact;

  const previousKeys = Array.from(
    {length: ROLLOVER_LOOKBACK_MONTHS},
    (_, index) => shiftMonthKey(monthKey, -(index + 1)),
  );
  const entries = await AsyncStorage.multiGet(previousKeys.map((key) => storageKey(uid, key)));
  for (const [index, previousKey] of previousKeys.entries()) {
    const carried = parseStored(entries[index]?.[1] ?? null, previousKey);
    if (carried) return {...carried, monthKey, rolledOverFrom: previousKey};
  }
  return null;
}

/**
 * Reads the limit for `monthKey` from Firestore so it is the same on every
 * device the user signs in on, keeping a device copy for offline use.
 *
 * When that month has none, the most recent earlier limit is carried forward
 * and flagged with `rolledOverFrom`; without this the budget, the daily tension
 * read-out and the assistant's finance context all disappeared without
 * explanation at midnight on the first of the month.
 *
 * A budget saved before this moved to Firestore lives only on the device that
 * saved it, so the first read that finds nothing stored remotely uploads the
 * cached one rather than letting it silently disappear.
 */
export async function loadMonthlyBudget(
  uid: string,
  monthKey = currentMonthKey(),
  {syncTimeoutMs = SYNC_TIMEOUT_MS}: SyncOptions = {},
): Promise<MonthlyBudget | null> {
  const cached = await readCache(uid, monthKey).catch(() => null);
  // Every remote call below is bounded: offline, the SDK answers reads from its
  // own cache but leaves writes queued indefinitely, which would hang the
  // screen on its loading state instead of showing the device copy.
  const bounded = <T>(work: Promise<T>) => {
    if (knownOffline()) return Promise.reject(new SyncTimeoutError(0));
    return withSyncTimeout(work, syncTimeoutMs);
  };

  try {
    // A cached limit flagged unsynced is a save the user already confirmed on
    // this device that never reached the server. Push it before reading, or the
    // server's older amount is read back over it and a save that could not sync
    // is indistinguishable from a save that never happened: the screen returns
    // to the previous limit with nothing to explain why.
    if (cached && cached.synced === false) {
      const originMonth = cached.rolledOverFrom ?? cached.monthKey;
      const pending = startSync(uid, {amount: cached.amount, dailyAmount: cached.dailyAmount, monthKey: originMonth, source: cached.source, weeklyAmount: cached.weeklyAmount});
      try {
        await bounded(pending);
      } catch (error) {
        markSyncedWhenItLands(uid, {...cached, monthKey: originMonth}, pending);
        throw error;
      }
      const restored: MonthlyBudget = {...cached, synced: true};
      await writeCache(uid, {...restored, monthKey: originMonth}).catch(() => undefined);
      return restored;
    }

    const exact = await bounded(readRemoteBudget(uid, monthKey));
    if (exact) {
      const budget: MonthlyBudget = {...exact, monthKey, synced: true};
      await writeCache(uid, budget).catch(() => undefined);
      return budget;
    }

    const carried = await bounded(readLatestRemoteBudgetBefore(uid, monthKey, earliestRolloverKey(monthKey)));
    if (carried) {
      return {...carried, monthKey, rolledOverFrom: carried.monthKey, synced: true};
    }

    // Nothing stored remotely for this month or the year before it. Anything in
    // the device cache predates the move to Firestore, or failed to sync, so
    // push it up now instead of losing it.
    if (cached) {
      const originMonth = cached.rolledOverFrom ?? cached.monthKey;
      const pending = startSync(uid, {amount: cached.amount, dailyAmount: cached.dailyAmount, monthKey: originMonth, source: cached.source, weeklyAmount: cached.weeklyAmount});
      try {
        await bounded(pending);
        const migrated = {...cached, synced: true};
        await writeCache(uid, {...migrated, monthKey: originMonth}).catch(() => undefined);
        return migrated;
      } catch (error) {
        console.error('[MonthlyBudget] Could not upload the device budget', error);
        await writeCache(uid, {...cached, monthKey: originMonth, synced: false}).catch(() => undefined);
        markSyncedWhenItLands(uid, {...cached, monthKey: originMonth, synced: false}, pending);
        return {...cached, synced: false};
      }
    }
    return null;
  } catch (error) {
    // Offline or rules failure: the cached limit is better than none, and is
    // marked unsynced so the screen can say so.
    console.error('[MonthlyBudget] Sync unavailable, using the device copy', error);
    return cached ? {...cached, synced: false} : null;
  }
}

/**
 * Stores the limit. The device copy is written before the sync is attempted, so
 * a save made with no connection is durable the moment the user presses the
 * button and never waits on the network to be usable. `synced` reports whether
 * the other devices can see it yet; when it is false the write stays queued in
 * the SDK and the flag clears itself as soon as it lands.
 */
export async function saveMonthlyBudget(
  uid: string,
  budget: Omit<MonthlyBudget, 'rolledOverFrom' | 'synced' | 'updatedAt'>,
  {syncTimeoutMs = SYNC_TIMEOUT_MS}: SyncOptions = {},
) {
  if (!isValidBudgetAmount(budget.amount)) {
    throw new Error(`Monthly budget must be between 1 and ${MONTHLY_BUDGET_MAX}.`);
  }
  if (budget.weeklyAmount !== undefined && !isValidBudgetAmount(budget.weeklyAmount)) {
    throw new Error(`Weekly budget must be between 1 and ${MONTHLY_BUDGET_MAX}.`);
  }
  if (budget.dailyAmount !== undefined && !isValidBudgetAmount(budget.dailyAmount)) {
    throw new Error(`Daily budget must be between 1 and ${MONTHLY_BUDGET_MAX}.`);
  }
  const next: MonthlyBudget = {
    amount: budget.amount,
    monthKey: budget.monthKey,
    source: budget.source,
    synced: true,
    updatedAt: new Date().toISOString(),
    ...(budget.weeklyAmount ? {weeklyAmount: budget.weeklyAmount} : {}),
    ...(budget.dailyAmount ? {dailyAmount: budget.dailyAmount} : {}),
  };

  await writeCache(uid, {...next, synced: false});
  const pending = startSync(uid, next);

  try {
    // An offline device is not worth a wait it cannot win, so skip straight to
    // the local path where the platform already knows there is no connection.
    if (knownOffline()) throw new SyncTimeoutError(0);
    await withSyncTimeout(pending, syncTimeoutMs);
  } catch (error) {
    console.error('[MonthlyBudget] Sync failed, keeping the budget on this device', error);
    markSyncedWhenItLands(uid, next, pending);
    return {...next, synced: false};
  }
  await writeCache(uid, next);
  return next;
}
