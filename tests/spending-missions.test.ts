import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeBudget, budgetCategories, createInitialState, validateState, variableSpent } from '../shared/domain';
import { savingMissionXP, spendingGoalProgress, suggestedGoalLimit } from '../shared/spending-missions';
import type { SpendingGoal } from '../shared/types';
const now = new Date('2026-10-14T01:00:00Z');
const goal: SpendingGoal = { id: 'goal', categoryId: 'shopping', categoryName: '쇼핑', startDate: '2026-10-11', endDate: '2026-10-13', limit: 30000, createdAt: '2026-10-11T01:00:00Z' };

test('no records never imply a successful savings mission; each closed day needs explicit review', () => {
  const state = createInitialState(); state.spendingGoals = [goal];
  assert.equal(spendingGoalProgress(state, goal, now).complete, false);
  assert.equal(savingMissionXP(state, now), 0);
  state.spendingReviews = ['2026-10-11', '2026-10-12', '2026-10-13'].map(date => ({ date, reviewedAt: now.toISOString() }));
  assert.equal(spendingGoalProgress(state, goal, new Date('2026-10-13T10:00:00Z')).complete, false);
  assert.equal(spendingGoalProgress(state, goal, now).complete, true);
  assert.equal(savingMissionXP(state, now), 40);
  state.expenses.push({ id: 'expense', category: 'shopping', amount: 30001, date: '2026-10-12', note: '', emotion: '', createdAt: '2026-10-12T01:00:00Z' });
  assert.equal(spendingGoalProgress(state, goal, now).complete, false);
  assert.equal(savingMissionXP(state, now), 0);
  assert.equal(state.config.goals.emergencyFund.balance, 5000000);
});

test('purchase pauses require a full 24 hours, persist decisions, and never create money or expenses', () => {
  const state = createInitialState();
  state.purchasePauses = [{ id: 'pause', name: '운동화', amount: 70000, createdAt: '2026-10-12T01:00:00Z', resolution: 'skipped', resolvedAt: '2026-10-13T00:59:59Z' }];
  assert.ok(validateState(state).some(error => error.includes('24시간')));
  assert.equal(savingMissionXP(state, now), 0);
  state.purchasePauses[0].resolvedAt = '2026-10-13T01:00:00Z';
  assert.deepEqual(validateState(state), []);
  assert.equal(savingMissionXP(state, now), 20);
  assert.equal(state.expenses.length, 0); assert.equal(state.fundEntries.length, 0);
  state.purchasePauses[0].resolution = 'bought';
  assert.equal(savingMissionXP(state, now), 0);
});

test('550000 bridge budget lasts 11 KST dates, excludes existing purchases, and reverts at payday', () => {
  const state = createInitialState(), original = structuredClone(state.config);
  state.expenses = [{ id: 'old', category: 'shopping', amount: 80000, date: '2026-10-14', note: '', emotion: '', createdAt: now.toISOString() }];
  state.bridgeBudget = { id: 'bridge', amount: 550000, startDate: '2026-10-14', endDate: '2026-10-24', excludedExpenseIds: ['old'] };
  const current = activeBudget(state, now);
  assert.equal(current.budget, 550000); assert.equal(current.temporary, true);
  assert.equal(variableSpent(state, current), 0);
  assert.equal(550000 / 11, 50000);
  assert.equal(budgetCategories(state, now).reduce((sum, category) => sum + category.budget, 0), 550000);
  assert.equal(suggestedGoalLimit(state, null, 3, now), 135000);
  state.expenses.push({ ...state.expenses[0], id: 'new', amount: 10000 });
  assert.equal(variableSpent(state, current), 10000);
  assert.equal(activeBudget(state, '2026-10-24T14:59:59Z').temporary, true);
  assert.equal(activeBudget(state, '2026-10-24T15:00:00Z').temporary, false);
  assert.equal(activeBudget(state, '2026-10-24T15:00:00Z').budget, 1368000);
  assert.deepEqual(state.config, original);
  assert.deepEqual(validateState(state), []);
});

test('goals preserve their fixed limit, skip pre-start records and stop claiming success after category deletion', () => {
  const state = createInitialState();
  const savedGoal = { ...goal, excludedExpenseIds: ['old'] };
  state.expenses = [{ id: 'old', category: 'shopping', amount: 50000, date: '2026-10-11', note: '', emotion: '', createdAt: '2026-10-11T00:00:00Z' }];
  assert.equal(spendingGoalProgress(state, savedGoal, now).spent, 0);
  state.config.categories.find(category => category.id === 'shopping')!.budget = 999999;
  assert.equal(savedGoal.limit, 30000);
  state.config.categories = state.config.categories.filter(category => category.id !== 'shopping');
  assert.equal(spendingGoalProgress(state, savedGoal, now).available, false);
  assert.equal(spendingGoalProgress(state, savedGoal, now).complete, false);
});
