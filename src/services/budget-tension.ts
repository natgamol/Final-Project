import { loadMonthlyBudget, currentMonthKey } from '@/services/monthly-budget';
import { transactions } from '@/services/firestore';
import { calculateBudgetTension } from '@/services/dynamic-insights';
import { thailandRange } from '@/lib/thailand-time';

// The calculation itself lives with the other budget maths in
// `dynamic-insights`, so the notification feed and the dashboard can reach it
// without pulling in Firestore. Re-exported here so existing importers of this
// module keep working.
export { calculateBudgetTension };
export type { BudgetTension, TensionLevel } from '@/services/dynamic-insights';

/** Loads today's expenses and the saved limit, then reports the tension. */
export async function evaluateBudgetTension(uid: string) {
  const monthlyData = await loadMonthlyBudget(uid, currentMonthKey());
  if (!monthlyData || typeof monthlyData.amount !== 'number') {
    return null;
  }

  const now = new Date();
  const { from, to } = thailandRange('day', now);
  const txList = await transactions.between(uid, from, to, 'expense');
  const todaySpent = txList.reduce((sum, tx) => sum + (tx.amount || 0), 0);

  return calculateBudgetTension({ dailyBudget: monthlyData.dailyAmount, monthlyBudget: monthlyData.amount, now, todaySpent });
}
