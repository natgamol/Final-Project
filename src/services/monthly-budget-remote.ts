import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

import {db} from '@/lib/firebase';
import {isDemoMode} from '@/lib/demo-mode';

/**
 * The shape stored at `users/{uid}/monthlyBudgets/{monthKey}`. The document id
 * is the Bangkok month key, so a month can only ever hold one limit and the
 * ids sort chronologically, which is what the carry-forward query relies on.
 */
export type RemoteBudget = {
  amount: number;
  /** Present only when the user set a daily figure rather than deriving one. */
  dailyAmount?: number;
  monthKey: string;
  source: 'ai' | 'manual';
  updatedAt: string;
  /** Present only when the user set a weekly figure rather than deriving one. */
  weeklyAmount?: number;
};

/** Absent and zero both mean "not set", so both come back as undefined. */
function optionalAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function budgets(uid: string) {
  return collection(db, 'users', uid, 'monthlyBudgets');
}

function toRemote(monthKey: string, data: Record<string, unknown> | undefined): RemoteBudget | null {
  if (!data) return null;
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const updatedAt = data.updatedAt as {toDate?: () => Date} | undefined;
  return {
    amount,
    monthKey,
    source: data.source === 'ai' ? 'ai' : 'manual',
    updatedAt: typeof updatedAt?.toDate === 'function' ? updatedAt.toDate().toISOString() : new Date().toISOString(),
    ...(optionalAmount(data.weeklyAmount) === undefined ? {} : {weeklyAmount: optionalAmount(data.weeklyAmount)}),
    ...(optionalAmount(data.dailyAmount) === undefined ? {} : {dailyAmount: optionalAmount(data.dailyAmount)}),
  };
}

export async function readRemoteBudget(uid: string, monthKey: string): Promise<RemoteBudget | null> {
  if (isDemoMode) return null;
  const snapshot = await getDoc(doc(db, 'users', uid, 'monthlyBudgets', monthKey));
  return snapshot.exists() ? toRemote(monthKey, snapshot.data()) : null;
}

/**
 * Most recent limit strictly before `monthKey` and not older than `earliestKey`.
 * The rules pin `monthKey` to the document id, so ordering by that one field
 * is chronological and needs no composite index.
 */
export async function readLatestRemoteBudgetBefore(
  uid: string,
  monthKey: string,
  earliestKey: string,
): Promise<RemoteBudget | null> {
  if (isDemoMode) return null;
  const snapshot = await getDocs(query(
    budgets(uid),
    where('monthKey', '>=', earliestKey),
    where('monthKey', '<', monthKey),
    orderBy('monthKey', 'desc'),
    limit(1),
  ));
  const first = snapshot.docs[0];
  return first ? toRemote(first.id, first.data()) : null;
}

export async function writeRemoteBudget(uid: string, budget: Omit<RemoteBudget, 'updatedAt'>) {
  if (isDemoMode) return;
  const reference = doc(db, 'users', uid, 'monthlyBudgets', budget.monthKey);
  const existing = await getDoc(reference);
  // `createdAt` must stay fixed across updates; the rules reject a write that
  // moves it, so it is only sent when the document is new.
  // The optional figures are spread in only when set. The rules accept the
  // document without them, and writing an explicit `undefined` would be a
  // field the rules then reject.
  await setDoc(reference, {
    amount: budget.amount,
    monthKey: budget.monthKey,
    ownerId: uid,
    source: budget.source,
    updatedAt: serverTimestamp(),
    ...(budget.weeklyAmount ? {weeklyAmount: budget.weeklyAmount} : {}),
    ...(budget.dailyAmount ? {dailyAmount: budget.dailyAmount} : {}),
    ...(existing.exists() ? {createdAt: existing.data().createdAt} : {createdAt: serverTimestamp()}),
  });
}
