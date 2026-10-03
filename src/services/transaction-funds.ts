import {thailandRange} from '@/lib/thailand-time';
import {transactions} from '@/services/firestore';
import type {Transaction} from '@/types/smartlife';

export type MonthFunds = {
  /** Income taken in this month, minus what has already been spent from it. */
  available: number;
  income: number;
  spent: number;
};

/**
 * What the month has actually taken in, against what it has already spent,
 * from rows the caller already holds.
 *
 * This is deliberately not the budget maths in `dynamic-insights`: that answers
 * "how am I doing against the limit I set", and returns nothing at all when no
 * limit exists. This answers "is there money behind this spending", which holds
 * whether or not a budget was ever set -- the case a ฿700,000 expense against
 * ฿100,500 of income slipped through.
 *
 * Amounts are stored positive with `type` carrying the direction, so both
 * totals are compared as magnitudes.
 */
export function monthFundsFrom(rows: Pick<Transaction, 'amount' | 'type'>[]): MonthFunds {
  const totalOf = (kind: 'income' | 'expense') => rows
    .filter((row) => row.type === kind)
    .reduce((sum, row) => sum + Math.abs(Number(row.amount ?? 0)), 0);
  const income = totalOf('income');
  const spent = totalOf('expense');
  return {available: income - spent, income, spent};
}

/**
 * The same figures, for a caller that does not have the month loaded yet --
 * the full transaction form and the finance page's quick add, which ask just
 * before writing.
 */
export async function monthFundsFor(uid: string, when: Date): Promise<MonthFunds> {
  const {from, to} = thailandRange('month', when);
  return monthFundsFrom(await transactions.between(uid, from, to));
}

/**
 * Whether an expense of `amount` would reach past the money on record. Kept
 * beside the lookup so every caller applies the same rule rather than each
 * writing their own comparison.
 */
export function exceedsAvailableFunds(amount: number, funds: MonthFunds) {
  return amount > funds.available;
}

/**
 * How far spending has already gone past the money taken in, or null when it
 * has not.
 *
 * Income has to be on record for this to mean anything: with none logged the
 * balance is unknown rather than zero, since plenty of people track only what
 * they spend. That is the same rule the notification feed's funds alert uses,
 * so a screen and the bell can never disagree about whether money ran out.
 */
export function fundsOverage(funds: MonthFunds): number | null {
  return funds.income > 0 && funds.spent > funds.income ? funds.spent - funds.income : null;
}
