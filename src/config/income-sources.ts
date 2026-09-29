export type IncomeSource = {
  /** Material Symbols name, matching how expense categories carry theirs. */
  icon: string;
  /** What the button says. */
  label: string;
  /** What gets stored on the transaction's `category`. */
  value: string;
};

/**
 * The one list of income sources, for the same reason `EXPENSE_CATEGORIES`
 * exists: the finance screen groups and charts by the stored string, so two
 * screens offering slightly different wording would split one source into two.
 *
 * It was previously a literal inside the income form, which was fine while
 * that form was the only way to record income. The finance page's quick add is
 * the second, so the list moved here rather than being copied.
 */
export const INCOME_SOURCES: IncomeSource[] = [
  {icon: 'home', label: 'จากบ้าน', value: 'เงินโอน'},
  {icon: 'work', label: 'งานพิเศษ', value: 'รายได้'},
  {icon: 'account_balance', label: 'ทุน', value: 'ทุนการศึกษา'},
  {icon: 'receipt_long', label: 'เงินคืน', value: 'คืนเงิน'},
];
