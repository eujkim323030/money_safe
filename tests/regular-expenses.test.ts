import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeBudget, allocationTotal, budgetCategories, createInitialState, kstDate, validateState, variableSpent } from '../shared/domain';
import { applyRegularPreset, categoryBudget, changeCategories, isRegular } from '../shared/regular-expenses';
import { mergeCategory, reassignCategoryExpenses } from '../shared/categories';
import { spendingGoalProgress, suggestedGoalLimit } from '../shared/spending-missions';
import type { Expense } from '../shared/types';
const expense = (category: string, amount: number): Expense => ({ id: category, category, amount, date: kstDate(), createdAt: new Date().toISOString(), note: '', emotion: '' });

test('regular preset replaces the unassigned envelope, preserves salary and creates no actual transactions', () => {
  const state = createInitialState(), original = structuredClone(state);
  state.config = applyRegularPreset(state.config);
  assert.deepEqual(validateState(state), []);
  assert.equal(categoryBudget(state.config.categories, 'regular'), 752000);
  assert.equal(state.config.allocation.variableBudget, 1268000);
  assert.equal(state.config.categories.find(category => category.id === 'other')?.budget, 78000);
  assert.equal(allocationTotal(state.config), 3650000);
  assert.deepEqual(state.expenses, []);
  assert.deepEqual(applyRegularPreset(state.config), state.config);
  assert.equal(original.config.categories.length, 6);
});
test('regular payment amounts are actual integer KRW, separate from both monthly and temporary living budgets', () => {
  const state = createInitialState(); state.config = applyRegularPreset(state.config);
  state.expenses = [expense('regular_transport', 284530), expense('regular_phone', 57123), expense('food', 10000)];
  assert.deepEqual(validateState(state), []); assert.equal(variableSpent(state), 10000);
  const now = kstDate();
  state.bridgeBudget = { id: 'bridge', startDate: now, endDate: now, amount: 550000, excludedExpenseIds: ['food'] };
  assert.equal(variableSpent(state), 0); assert.equal(activeBudget(state).budget, 550000);
  assert.equal(budgetCategories(state).reduce((sum, category) => sum + category.budget, 0), 550000);
  assert.ok(budgetCategories(state).every(category => !isRegular(category)));
  state.expenses.push({ ...expense('shopping', 5000), id: 'new' });
  assert.equal(variableSpent(state), 5000);
  assert.equal(state.config.categories.find(category => category.id === 'regular_transport')?.budget, 300000);
});
test('category toggles and cross-group deletion move only the planned budgets and reclassify existing records once', () => {
  const state = createInitialState(); state.config = applyRegularPreset(state.config);
  state.expenses = [expense('regular_transport', 1200)];
  const original = structuredClone(state.expenses), salary = allocationTotal(state.config);
  state.config = changeCategories(state.config, state.config.categories.map(category => category.id === 'regular_transport' ? { ...category, kind: 'variable' } : category));
  assert.deepEqual(validateState(state), []); assert.equal(variableSpent(state), 1200);
  assert.equal(state.config.allocation.fixedExpenses, 452000); assert.equal(state.config.allocation.variableBudget, 1568000);
  assert.deepEqual(state.expenses, original); assert.equal(allocationTotal(state.config), salary);
  state.config = changeCategories(state.config, mergeCategory(state.config.categories, 'regular_transport', 'regular_phone'));
  state.expenses = reassignCategoryExpenses(state.expenses, [{ from: 'regular_transport', to: 'regular_phone' }]);
  assert.deepEqual(validateState(state), []); assert.equal(variableSpent(state), 0);
  assert.equal(state.config.allocation.fixedExpenses, 752000); assert.equal(allocationTotal(state.config), salary);
});
test('invalid group values, regular overspending plans and missing variable category budgets are rejected', () => {
  const state = createInitialState(); state.config = applyRegularPreset(state.config);
  (state.config.categories[0] as unknown as { kind: string }).kind = 'unknown';
  assert.ok(validateState(state).length); state.config.categories[0].kind = 'variable';
  state.config.categories.find(isRegular)!.budget += 1;
  assert.ok(validateState(state).some(error => error.includes('정기 카테고리')));
});
test('variable savings missions exclude recurring bills and stop qualifying reclassified targets', () => {
  const state = createInitialState(); state.config = applyRegularPreset(state.config);
  const date = kstDate(), now = new Date();
  state.expenses = [expense('regular_transport', 300000), expense('food', 2000)];
  const goal = { id: 'g', categoryId: null, categoryName: '생활비', startDate: date, endDate: date, limit: 5000, createdAt: now.toISOString() };
  assert.equal(spendingGoalProgress(state, goal, now).spent, 2000);
  assert.equal(spendingGoalProgress(state, { ...goal, categoryId: 'regular_transport' }, now).available, false);
  const prior = suggestedGoalLimit(state, null, 1, now);
  state.expenses[0].amount = 500000;
  assert.equal(suggestedGoalLimit(state, null, 1, now), prior);
});

test('manually itemizing the old unassigned regular envelope does not allocate it twice', () => {
  const state = createInitialState();
  state.config = changeCategories(state.config, [...state.config.categories, { id: 'bill', name: '통신비', budget: 57000, kind: 'regular' }]);
  assert.equal(state.config.allocation.fixedExpenses, 652000);
  assert.equal(state.config.allocation.variableBudget, 1368000);
  assert.deepEqual(validateState(state), []);
});
