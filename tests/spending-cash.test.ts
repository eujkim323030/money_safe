import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeBudget, allocationTotal, budgetCategories, createInitialState, kstDate, validateState } from '../shared/domain';
import { bridgeCash } from '../shared/spending-cash';
import { applyRegularPreset, balanceSpendingPlan } from '../shared/regular-expenses';
import type { Expense } from '../shared/types';
const date = kstDate();
const expense = (id: string, category: string, amount: number): Expense => ({ id, category, amount, date, createdAt: new Date().toISOString(), note: '', emotion: '' });
function sharedState() {
  const state = createInitialState(); state.config = applyRegularPreset(state.config);
  state.bridgeBudget = { id: 'cash', amount: 550000, cashScope: 'shared', regularReserve: 57000, startDate: date, endDate: date, excludedExpenseIds: ['old'] };
  return state;
}
test('shared cash reserves upcoming bills once, actual overages lower available spending, edits and deletes recalculate', () => {
  const state = sharedState(); state.expenses.push(expense('old', 'regular_phone', 99999));
  assert.equal(bridgeCash(state)!.available, 493000);
  state.expenses.push(expense('bill', 'regular_phone', 55000));
  assert.equal(bridgeCash(state)!.cashRemaining, 495000); assert.equal(bridgeCash(state)!.reservedRemaining, 2000);
  assert.equal(bridgeCash(state)!.available, 493000);
  state.expenses[1].amount = 57123;
  assert.equal(bridgeCash(state)!.available, 492877); assert.equal(activeBudget(state).budget, 492877);
  state.expenses.push(expense('food', 'food', 5000));
  assert.equal(bridgeCash(state)!.available, 487877);
  assert.equal(budgetCategories(state).reduce((sum, category) => sum + category.budget, 0), 492877);
  state.expenses.splice(1, 1);
  assert.equal(bridgeCash(state)!.available, 488000);
  assert.deepEqual(validateState(state), []);
});
test('legacy and living-only balances stay separate from regular payments; out-of-period bills do not consume cash', () => {
  const state = sharedState(); state.bridgeBudget!.cashScope = 'living'; state.bridgeBudget!.regularReserve = 0;
  state.expenses = [expense('bill', 'regular_phone', 57123), expense('food', 'food', 5000)];
  assert.equal(bridgeCash(state)!.available, 545000);
  delete state.bridgeBudget!.cashScope;
  assert.equal(bridgeCash(state)!.available, 545000);
  state.bridgeBudget!.cashScope = 'shared'; state.bridgeBudget!.regularReserve = 57000;
  state.expenses[0].date = '2000-01-01';
  assert.equal(bridgeCash(state)!.available, 488000);
});
test('insufficient cash remains negative instead of being hidden; reserve inputs are validated', () => {
  const state = sharedState(); state.expenses = [expense('bill', 'regular_phone', 600000)];
  assert.equal(bridgeCash(state)!.available, -50000); assert.equal(activeBudget(state).budget, 0);
  assert.ok(budgetCategories(state).every(category => category.budget === 0));
  for (const value of [-1, 1.5, 550001]) { state.bridgeBudget!.regularReserve = value; assert.ok(validateState(state).length > 0); }
  delete state.bridgeBudget!.regularReserve; assert.ok(validateState(state).length > 0);
});
test('one-click budget balancing preserves other allocations and stages only integer variable category budgets', () => {
  const state = sharedState(), original = structuredClone(state.config);
  state.config.categories[0].budget += 10000;
  const balanced = balanceSpendingPlan(state.config);
  assert.equal(balanced.categories.find(category => category.id === 'other')!.budget, 68000);
  assert.deepEqual(balanced.allocation, original.allocation);
  assert.equal(allocationTotal(balanced), balanced.salary.monthlyAmount);
  assert.deepEqual(validateState({ ...state, config: balanced }), []);
  state.config.allocation.fixedExpenses += 100000;
  assert.equal(balanceSpendingPlan(state.config).allocation.variableBudget, 1168000);
  state.config.salary.monthlyAmount = 1;
  assert.throws(() => balanceSpendingPlan(state.config));
});
