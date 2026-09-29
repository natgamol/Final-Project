// In-memory stand-in for the Firestore budget collection, so the sync,
// carry-forward and migration logic can be driven without a live backend.
// Keyed `uid/monthKey`, mirroring `users/{uid}/monthlyBudgets/{monthKey}`.
// The document shape itself is covered by the emulator rules test.
const server = new Map();

let readsFail = false;
let writesFail = false;
let writesQueue = false;

/** Writes accepted while `queueWrites` was on, waiting for a reconnect. */
let queued = [];

/**
 * Simulates losing the network.
 *
 * `reads`/`writes` reject, the way a rules failure or an explicitly terminated
 * client does. `queueWrites` is what the real SDK does when the device is
 * simply offline: the write is accepted, held locally, and its promise stays
 * pending until a server acknowledges it -- so it neither fails nor completes.
 * Nothing but `__flushQueuedWrites` ends that wait.
 */
export function __setOffline({queueWrites = false, reads = false, writes = false} = {}) {
  readsFail = reads;
  writesFail = writes;
  writesQueue = queueWrites;
}

/** Reconnects: every held write lands, in the order it was made. */
export async function __flushQueuedWrites() {
  const pending = queued;
  queued = [];
  writesQueue = false;
  for (const {budget, resolve, uid} of pending) {
    commit(uid, budget);
    resolve();
  }
  // Let the continuations attached to those promises run before asserting.
  await new Promise((resolve) => setImmediate(resolve));
}

/** How many writes are still held offline. */
export function __queuedWriteCount() {
  return queued.length;
}

export function __reset() {
  server.clear();
  queued = [];
  readsFail = false;
  writesFail = false;
  writesQueue = false;
}

/** Everything the "server" holds, for asserting on what actually synced. */
export function __dump() {
  return [...server.entries()].map(([key, value]) => ({key, ...value}));
}

function commit(uid, budget) {
  server.set(`${uid}/${budget.monthKey}`, {
    amount: budget.amount,
    monthKey: budget.monthKey,
    source: budget.source,
    updatedAt: new Date().toISOString(),
    // Optional, exactly as the real module writes them: absent unless the user
    // set one. Dropping them here made a saved limit come back without them.
    ...(budget.weeklyAmount ? {weeklyAmount: budget.weeklyAmount} : {}),
    ...(budget.dailyAmount ? {dailyAmount: budget.dailyAmount} : {}),
  });
}

export async function readRemoteBudget(uid, monthKey) {
  if (readsFail) throw new Error('offline');
  return server.get(`${uid}/${monthKey}`) ?? null;
}

export async function readLatestRemoteBudgetBefore(uid, monthKey, earliestKey) {
  if (readsFail) throw new Error('offline');
  return [...server.entries()]
    .filter(([key]) => key.startsWith(`${uid}/`))
    .map(([, value]) => value)
    .filter((value) => value.monthKey < monthKey && value.monthKey >= earliestKey)
    .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1))[0] ?? null;
}

export function writeRemoteBudget(uid, budget) {
  if (writesFail) return Promise.reject(new Error('offline'));
  if (writesQueue) return new Promise((resolve) => { queued.push({budget, resolve, uid}); });
  commit(uid, budget);
  return Promise.resolve();
}
