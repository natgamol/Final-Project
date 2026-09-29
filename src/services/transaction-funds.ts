import {thailandRange} from '@/lib/thailand-time';
import {transactions} from '@/services/firestore';

export type MonthFunds = {
  /** Income taken in this month, minus what has already been spent from it. */
  available: number;
  income: number;
  spent: number;
};

/**
 * What the month has actually taken in, against what it has already spent.
 *
 * This is deliberately not the budget maths in `dynamic-insights`: that answers
 * "how am I doing against the limit I set", and returns nothing at all when no
 * limit exists. This answers "is there money behind this expense", which holds
 * whether or not a budget was ever set -- the case a ฿700,000 expense against
 * ฿100,500 of income slipped through.
 *
 * It lives here rather than inside a screen because two places now ask it: the
 * full transaction form and the finance page's quick add. Amounts are stored
 * positive with `type` carrying the direction, so both totals are compared as
 * magnitudes.
 */
export async function monthFundsFor(uid: string, when: Date): Promise<MonthFunds> {
  const {from, to} = thailandRange('month', when);
  const rows = await transactions.between(uid, from, to);
  const totalOf = (kind: 'income' | 'expense') => rows
    .filter((row) => row.type === kind)
    .reduce((sum, row) => sum + Math.abs(Number(row.amount ?? 0)), 0);
  const income = totalOf('income');
  const spent = totalOf('expense');
  return {available: income - spent, income, spent};
}

/**
 * Whether an expense of `amount` would reach past the money on record. Kept
 * beside the lookup so both callers apply the same rule rather than each
 * writing their own comparison.
 */
export function exceedsAvailableFunds(amount: number, funds: MonthFunds) {
  return amount > funds.available;
}
