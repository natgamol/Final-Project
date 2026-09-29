// Run via `npm run test:monthly-budget`, which forces TZ=UTC so the
// Asia/Bangkok assertions below prove the budget uses Bangkok time rather
// than inheriting the machine's clock.
import assert from 'node:assert/strict';

import {calculateBudgetTension, calculateDailyAllowance, calculateFinanceBudgetInsight} from '../src/services/dynamic-insights.ts';
import {
  currentMonthKey,
  isValidBudgetAmount,
  loadMonthlyBudget,
  MONTHLY_BUDGET_MAX,
  parseBudgetAmount,
  saveMonthlyBudget,
} from '../src/services/monthly-budget.ts';

assert.equal(
  new Date('2026-08-16T17:30:00Z').getDate(), 16,
  'this suite must run under TZ=UTC; run it with `npm run test:monthly-budget`',
);

const uid = 'student-1';
const tx = (amount, occurredAt, type = 'expense') => ({amount, occurredAt: new Date(occurredAt), type});

// --- The month a budget belongs to is the Bangkok month, not the device month.
// Spending is queried with `thailandRange`, so a device-local key would read a
// different month than the transactions it is compared against.
assert.equal(currentMonthKey(new Date('2026-08-31T16:00:00Z')), '2026-08', 'Aug 31 23:00 Bangkok is still August');
assert.equal(currentMonthKey(new Date('2026-08-31T17:30:00Z')), '2026-09', 'Sep 1 00:30 Bangkok is already September');
assert.equal(currentMonthKey(new Date('2026-09-30T17:00:00Z')), '2026-10', 'Oct 1 00:00 Bangkok is already October');

// --- Amounts that cannot describe a spending limit are rejected at the source
// instead of being stored and later rendered as a budget of zero.
for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY, MONTHLY_BUDGET_MAX + 1]) {
  assert.equal(isValidBudgetAmount(bad), false, `${bad} must not be a valid budget`);
  await assert.rejects(
    () => saveMonthlyBudget(uid, {amount: bad, monthKey: '2026-08', source: 'manual'}),
    `saving ${bad} must reject`,
  );
}
assert.equal(isValidBudgetAmount(5000), true);

// --- Nothing saved anywhere means no budget.
assert.equal(await loadMonthlyBudget(uid, '2026-08'), null, 'no stored budget yields null');

// --- A budget set in July carries into August instead of vanishing at midnight
// on the first, and says where it came from.
await saveMonthlyBudget(uid, {amount: 5000, monthKey: '2026-07', source: 'manual'});
const carried = await loadMonthlyBudget(uid, '2026-08');
assert.ok(carried, 'July budget must carry into August');
assert.equal(carried.amount, 5000);
assert.equal(carried.monthKey, '2026-08', 'carried budget is reported for the month asked for');
assert.equal(carried.rolledOverFrom, '2026-07', 'the origin month is disclosed');
assert.equal(carried.source, 'manual');

// --- An explicit budget for the month always wins over the carried one.
await saveMonthlyBudget(uid, {amount: 4200, monthKey: '2026-08', source: 'ai'});
const exact = await loadMonthlyBudget(uid, '2026-08');
assert.equal(exact.amount, 4200);
assert.equal(exact.source, 'ai');
assert.equal(exact.rolledOverFrom, undefined, 'an explicit budget is not marked as carried');

// --- The carry-forward window is bounded, so a year-old budget is not revived.
const stale = 'student-stale';
await saveMonthlyBudget(stale, {amount: 3000, monthKey: '2025-07', source: 'manual'});
assert.equal(await loadMonthlyBudget(stale, '2026-08'), null, 'a 13-month-old budget is not carried forward');
const withinWindow = await loadMonthlyBudget(stale, '2026-06');
assert.equal(withinWindow.amount, 3000, 'an 11-month-old budget is still within the window');
assert.equal(withinWindow.rolledOverFrom, '2025-07');

// --- Overspend stays a real number all the way through the insight, so the UI
// can say how far over the user is instead of clamping it to zero.
const now = new Date('2026-08-19T05:00:00Z'); // Wed 19 Aug, 12:00 in Bangkok
const over = calculateFinanceBudgetInsight({
  monthlyBudget: 5000,
  now,
  transactions: [tx(6200, '2026-08-10T06:00:00Z')],
});
assert.equal(over.spentSoFar, 6200);
assert.equal(over.remainingBudget, -1200, 'being 1,200 over budget must survive as -1200');
assert.equal(over.financePressureLevel, 'critical');
assert.equal(over.monthKey, '2026-08');
assert.equal(over.daysInMonth, 31, 'August has 31 Bangkok days');

// --- A non-positive budget yields no insight at all rather than a divide-by-zero.
assert.equal(calculateFinanceBudgetInsight({monthlyBudget: 0, now, transactions: []}), null);
assert.equal(calculateFinanceBudgetInsight({monthlyBudget: -1, now, transactions: []}), null);

// --- The weekly window is Monday-Sunday in Bangkok. A purchase at 00:30 on
// Monday Bangkok time falls on Sunday under a UTC clock; it must still be
// counted in this week.
const weekly = calculateFinanceBudgetInsight({
  monthlyBudget: 3100, // 100/day across 31 days
  now,
  transactions: [
    tx(300, '2026-08-16T17:30:00Z'), // Mon 17 Aug 00:30 Bangkok - inside this week
    tx(500, '2026-08-16T16:30:00Z'), // Sun 16 Aug 23:30 Bangkok - previous week
  ],
});
assert.equal(weekly.weekStart, '2026-08-17', 'the week starts Monday in Bangkok');
assert.equal(weekly.weekEnd, '2026-08-23', 'the week ends Sunday in Bangkok');
assert.equal(weekly.weekSpent, 300, 'only the Bangkok-Monday purchase counts toward this week');
assert.equal(weekly.spentSoFar, 800, 'both purchases still count toward the month');
assert.equal(weekly.weeklyBudget, 700, '7 days at 100/day');

// --- A week clipped by the start of the month is budgeted for its real length.
const clipped = calculateFinanceBudgetInsight({
  monthlyBudget: 3100,
  now: new Date('2026-08-01T05:00:00Z'), // Sat 1 Aug in Bangkok
  transactions: [],
});
assert.equal(clipped.weekStart, '2026-08-01', 'the week is clipped to the first of the month');
assert.equal(clipped.weekEnd, '2026-08-02', 'the containing Mon-Sun week ends on Sunday 2 Aug');
assert.equal(clipped.weeklyBudget, 200, '2 remaining days at 100/day');

// --- Typed and pasted text becomes a whole-baht limit. A decimal separator
// truncates instead of vanishing: dropping the dot turned a pasted "12.50"
// into 1250, a hundredfold overstatement of the budget.
assert.equal(parseBudgetAmount('12.50'), 12, 'a decimal amount truncates, it does not become 1250');
assert.equal(parseBudgetAmount('0.99'), 0, 'a sub-baht amount is not a usable limit');
assert.equal(parseBudgetAmount('007'), 7, 'leading zeros are normalised');
assert.equal(parseBudgetAmount('5,000'), 5000, 'thousands separators are not decimal points');
assert.equal(parseBudgetAmount('1,234.56'), 1234, 'separators and decimals combined');
assert.equal(parseBudgetAmount('฿4500'), 4500, 'currency symbols are ignored');
assert.equal(parseBudgetAmount('-500'), 500, 'a minus sign cannot make a negative limit');
assert.equal(parseBudgetAmount(''), 0, 'empty text is zero');
assert.equal(parseBudgetAmount('abc'), 0, 'text with no digits is zero');
assert.equal(parseBudgetAmount('99999999999'), MONTHLY_BUDGET_MAX, 'an oversized amount clamps to the cap');

// --- The dashboard tile and the assistant's instant answer used a single day's
// income minus expenses, which is ฿0 for anyone who does not record income
// daily, whatever limit they had set. The figure they show now comes from the
// monthly limit and moves with it.
{
  const spendable = calculateDailyAllowance({
    monthlyBudget: 6200, // 200/day across 31 days
    now,                 // Wed 19 Aug, 12:00 Bangkok -- 13 days left including today
    transactions: [tx(1000, '2026-08-05T06:00:00Z')],
  });
  assert.equal(spendable.remainingBudget, 5200);
  assert.equal(spendable.amount, 400, '5,200 left over the 13 remaining days, today included');
  assert.equal(spendable.overBudget, false);
  assert.equal(spendable.spentSoFar, 1000);
  assert.equal(spendable.monthlyBudget, 6200);

  // No income recorded is exactly the case that always read ฿0 before.
  const withoutIncome = calculateDailyAllowance({
    monthlyBudget: 6200,
    now,
    transactions: [tx(1000, '2026-08-05T06:00:00Z'), tx(500, '2026-08-06T06:00:00Z', 'income')],
  });
  assert.equal(withoutIncome.amount, 400, 'income does not enter the allowance; only the limit and the spending do');

  // Raising the limit must move the number the tile shows.
  assert.equal(
    calculateDailyAllowance({monthlyBudget: 12_400, now, transactions: [tx(1000, '2026-08-05T06:00:00Z')]}).amount, 877,
    'doubling the monthly limit raises the daily allowance',
  );

  // Spending today tightens it, rather than leaving a flat monthly average.
  assert.ok(
    calculateDailyAllowance({monthlyBudget: 6200, now, transactions: [tx(1000, '2026-08-05T06:00:00Z'), tx(650, '2026-08-19T05:00:00Z')]}).amount < 400,
    'money spent today comes off what is left to spend today',
  );
}

// --- Over budget is reported as over budget, not as a bare zero the surfaces
// cannot tell apart from having no limit at all.
{
  const spent = calculateDailyAllowance({monthlyBudget: 5000, now, transactions: [tx(6200, '2026-08-10T06:00:00Z')]});
  assert.equal(spent.amount, 0, 'nothing is left to spend today');
  assert.equal(spent.overBudget, true);
  assert.equal(spent.remainingBudget, -1200, 'and by how much, for the over-budget wording');
}

// --- No limit set yields no figure, so the surfaces prompt for one instead of
// showing a ฿0 that reads as "you have nothing left".
assert.equal(calculateDailyAllowance({monthlyBudget: 0, now, transactions: [tx(300, '2026-08-05T06:00:00Z')]}), null);
assert.equal(calculateDailyAllowance({monthlyBudget: Number.NaN, now, transactions: []}), null);

// --- User-set weekly and daily limits.
//
// The first assertion is the one that matters most: with no override passed,
// every figure has to be exactly what it was before overrides existed, because
// six call sites reach these functions and any of them can still call without
// them.
{
  const spending = [tx(900, '2026-08-05T06:00:00Z'), tx(400, '2026-08-19T05:00:00Z')];
  const plain = calculateFinanceBudgetInsight({monthlyBudget: 6200, now, transactions: spending});
  const explicitlyUndefined = calculateFinanceBudgetInsight({
    dailyBudget: undefined, monthlyBudget: 6200, now, transactions: spending, weeklyBudget: undefined,
  });
  assert.deepEqual(explicitlyUndefined, plain, 'passing no override changes nothing at all');

  // A weekly override replaces the split, and the percentage follows it.
  const weekly = calculateFinanceBudgetInsight({monthlyBudget: 6200, now, transactions: spending, weeklyBudget: 2000});
  assert.equal(weekly.weeklyBudget, 2000, 'the weekly figure is the one that was set');
  assert.equal(weekly.weeklyUsagePercent, Math.round(weekly.weekSpent / 2000 * 100), 'usage is measured against it');
  assert.equal(weekly.monthlyBudget, plain.monthlyBudget, 'the monthly limit is untouched by a weekly override');
  assert.equal(weekly.spentSoFar, plain.spentSoFar, 'and so is the spending it reports');

  // A daily override becomes what is left today, instead of re-spreading the
  // month's remainder over the days left.
  const daily = calculateFinanceBudgetInsight({dailyBudget: 150, monthlyBudget: 6200, now, transactions: spending});
  assert.equal(daily.averageDailyBudget, 150, 'the daily figure is the one that was set');
  assert.equal(daily.remainingDailyBudget, 150, 'and it is what today has left');
  assert.notEqual(plain.remainingDailyBudget, 150, 'which the even split would not have produced');

  // The month still wins: an override cannot report room the month has spent.
  const blown = calculateFinanceBudgetInsight({dailyBudget: 150, monthlyBudget: 1000, now, transactions: [tx(1800, '2026-08-05T06:00:00Z')]});
  assert.equal(blown.remainingDailyBudget, 0, 'nothing is left today once the month is over its limit');

  // The allowance wrapper passes both through rather than recomputing.
  assert.equal(
    calculateDailyAllowance({dailyBudget: 150, monthlyBudget: 6200, now, transactions: spending}).amount, 150,
    'the daily allowance honours an override too',
  );
  assert.equal(
    calculateDailyAllowance({monthlyBudget: 6200, now, transactions: spending}).amount,
    calculateDailyAllowance({dailyBudget: undefined, monthlyBudget: 6200, now, transactions: spending}).amount,
    'and is unchanged without one',
  );

  // Zero and NaN are "not set", not "a limit of zero".
  assert.equal(
    calculateFinanceBudgetInsight({dailyBudget: 0, monthlyBudget: 6200, now, transactions: spending}).averageDailyBudget,
    plain.averageDailyBudget,
    'a zero override falls back to the split',
  );
  assert.equal(
    calculateFinanceBudgetInsight({weeklyBudget: Number.NaN, monthlyBudget: 6200, now, transactions: spending}).weeklyBudget,
    plain.weeklyBudget,
    'and so does a NaN one',
  );
}

// --- Today's pressure uses a daily limit that was set, as given.
{
  const derived = calculateBudgetTension({monthlyBudget: 6200, now, todaySpent: 100});
  const set = calculateBudgetTension({dailyBudget: 250, monthlyBudget: 6200, now, todaySpent: 100});
  assert.equal(set.dailyLimit, 250, 'the limit that was set is used unrounded');
  assert.equal(set.todayRemaining, 150);
  assert.equal(
    calculateBudgetTension({dailyBudget: undefined, monthlyBudget: 6200, now, todaySpent: 100}).dailyLimit,
    derived.dailyLimit,
    'without one, the rounded even split is unchanged',
  );
}

// --- The optional amounts survive a save and reload, and are left off the
// stored copy entirely when they were never set.
{
  const monthKey = currentMonthKey(now);
  const saved = await saveMonthlyBudget('user-scoped-limits', {
    amount: 6000, dailyAmount: 180, monthKey, source: 'manual', weeklyAmount: 1400,
  }, {syncTimeoutMs: 1});
  assert.equal(saved.weeklyAmount, 1400);
  assert.equal(saved.dailyAmount, 180);
  const reloaded = await loadMonthlyBudget('user-scoped-limits', monthKey);
  assert.equal(reloaded.weeklyAmount, 1400, 'the weekly limit survives the round trip through storage');
  assert.equal(reloaded.dailyAmount, 180, 'and so does the daily one');

  const monthlyOnly = await saveMonthlyBudget('user-monthly-only', {amount: 6000, monthKey, source: 'manual'}, {syncTimeoutMs: 1});
  assert.equal(monthlyOnly.weeklyAmount, undefined, 'a budget with no override stores none');
  assert.equal(monthlyOnly.dailyAmount, undefined);
  assert.equal((await loadMonthlyBudget('user-monthly-only', monthKey)).dailyAmount, undefined);
}

console.log('SmartLife monthly budget tests passed');
