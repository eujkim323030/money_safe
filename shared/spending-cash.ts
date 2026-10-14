import type { AppState } from './types';
import { isRegular } from './regular-expenses';

// No bank linkage: this snapshot is based only on the balance the user entered
// and new, in-period records. Older records are already included in that balance.
export function bridgeCash(state: AppState) {
  const bridge = state.bridgeBudget;
  if (!bridge) return null;
  const excluded = new Set(bridge.excludedExpenseIds);
  const regularIds = new Set(state.config.categories.filter(isRegular).map(category => category.id));
  const records = state.expenses.filter(expense => !excluded.has(expense.id) && expense.date >= bridge.startDate && expense.date <= bridge.endDate);
  const regularPaid = records.filter(expense => regularIds.has(expense.category)).reduce((sum, expense) => sum + expense.amount, 0);
  const variablePaid = records.filter(expense => !regularIds.has(expense.category)).reduce((sum, expense) => sum + expense.amount, 0);
  const shared = bridge.cashScope === 'shared', reserve = shared ? bridge.regularReserve ?? 0 : 0;
  const cashRemaining = bridge.amount - variablePaid - (shared ? regularPaid : 0);
  const reservedRemaining = Math.max(0, reserve - regularPaid);
  const budget = shared ? Math.max(0, bridge.amount - Math.max(reserve, regularPaid)) : bridge.amount;
  return { shared, regularPaid, variablePaid, cashRemaining, reservedRemaining, budget, available: cashRemaining - reservedRemaining, shortfall: shared ? Math.max(0, regularPaid - bridge.amount) : 0 };
}
