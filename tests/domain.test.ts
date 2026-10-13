import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocationTotal, createInitialState, cycleComparison, fundBalance, kstDate, loanBalance, missionDefinitions, salaryCycle, simulateLoan, validateState, variableSpent } from '../shared/domain';
import type { Expense } from '../shared/types';
const expense = (id: string, amount: number, date: string): Expense => ({ id, amount, date, category: 'food', note: '', emotion: '', createdAt: '2026-01-01T00:00:00Z' });

test('starter has exactly balanced 3,650,000 allocation, six-category 1,368,000 budget, no fabricated records', () => {
  const state = createInitialState();
  assert.equal(allocationTotal(state.config), 3_650_000);
  assert.equal(state.config.categories.reduce((s, c) => s + c.budget, 0), 1_368_000);
  assert.equal(variableSpent(state), 0);
  assert.equal(loanBalance(state), 5_000_000);
  assert.equal(fundBalance(state, 'emergency'), 5_000_000);
  assert.equal(fundBalance(state, 'bigPurchase'), null);
  assert.deepEqual(validateState(state), []);
  assert.deepEqual([state.expenses.length, state.repayments.length, state.fundEntries.length, state.missions.length], [0, 0, 0, 0]);
});
test('salary cycle crosses at KST midnight, independent of host timezone and DST', () => {
  assert.equal(kstDate('2026-10-24T14:59:59Z'), '2026-10-24');
  assert.equal(kstDate('2026-10-24T15:00:00Z'), '2026-10-25');
  assert.deepEqual(salaryCycle('2026-10-24T14:59:59Z'), { start: '2026-09-25', end: '2026-10-24', key: '2026-09-25', label: '9.25 ~ 10.24' });
  assert.equal(salaryCycle('2026-10-24T15:00:00Z').key, '2026-10-25');
  assert.equal(salaryCycle('2026-01-02').start, '2025-12-25');
  assert.equal(salaryCycle('2028-02-25').end, '2028-03-24');
  assert.equal(salaryCycle('2028-02-15', 1).end, '2028-02-29');
  assert.throws(() => salaryCycle('2026-01-01', 31));
});
test('expense edits and deletion change only their salary-cycle spending, never savings or repayments', () => {
  const state = createInitialState();
  state.expenses = [expense('a', 1000, '2026-09-24'), expense('b', 2000, '2026-09-25'), expense('c', 3000, '2026-10-24'), expense('d', 4000, '2026-10-25')];
  const cycle = salaryCycle('2026-10-01');
  assert.equal(variableSpent(state, cycle), 5000);
  state.expenses[1].amount = 2500;
  assert.equal(variableSpent(state, cycle), 5500);
  state.expenses = state.expenses.filter(e => e.id !== 'c');
  assert.equal(variableSpent(state, cycle), 2500);
  assert.equal(fundBalance(state, 'emergency'), 5_000_000);
  assert.equal(loanBalance(state), 5_000_000);
  const comparison = cycleComparison(state, '2026-10-01');
  assert.equal(comparison.current.spent, 2500);
  assert.equal(comparison.previous.spent, 1000);
});
test('boss HP follows actual principal only and other unknown loan is separate', () => {
  const state = createInitialState();
  state.repayments = [{ id: 'r', loan: 'boss', date: '2026-01-01', total: 330000, principal: 296667, interest: 33333, note: '' }, { id: 'other', loan: 'other', date: '2026-01-01', total: 200000, principal: null, interest: null, note: '' }];
  assert.equal(loanBalance(state), 4_703_333);
  assert.equal(variableSpent(state), 0);
  assert.deepEqual(validateState(state), []);
  state.repayments[0].interest = 33334;
  assert.ok(validateState(state).some(e => e.includes('원금·이자')));
  const sim = simulateLoan(5_000_000, .08, 230000, 100000);
  assert.equal(sim.rows[0].interest, 33333);
  assert.equal(sim.rows[0].principal, 296667);
  assert.ok(sim.months && sim.months > 1);
  assert.equal(sim.rows.at(-1)?.remaining, 0);
  assert.equal(simulateLoan(5_000_000, .08, 1000, 0).months, null);
});
test('fund balances keep unknown base null until explicit adjustment and reject overdrafts', () => {
  const state = createInitialState();
  state.fundEntries = [
    { id: 'a', fund: 'bigPurchase', kind: 'deposit', amount: 100000, date: '2026-01-01', note: '' },
    { id: 'b', fund: 'emergency', kind: 'deposit', amount: 100000, date: '2026-01-01', note: '' },
    { id: 'c', fund: 'emergency', kind: 'withdraw', amount: 50000, date: '2026-01-02', note: '' }
  ];
  assert.equal(fundBalance(state, 'bigPurchase'), null);
  assert.equal(fundBalance(state, 'emergency'), 5_050_000);
  state.fundEntries.push({ id: 'd', fund: 'bigPurchase', kind: 'adjust', amount: 300000, date: '2026-01-03', note: '' });
  state.fundEntries.push({ id: 'e', fund: 'bigPurchase', kind: 'withdraw', amount: 50000, date: '2026-01-04', note: '' });
  assert.equal(fundBalance(state, 'bigPurchase'), 250000);
  assert.deepEqual(validateState(state), []);
  state.fundEntries.at(-1)!.amount = 500000;
  assert.ok(validateState(state).some(e => e.includes('인출')));
});
test('mission feedback uses recorded data, completion/cancellation never invents money movements', () => {
  const state = createInitialState();
  const now = '2026-01-10';
  const defs = missionDefinitions(state, now);
  assert.equal(defs.find(m => m.key === 'emergency')?.evidence, false);
  assert.equal(defs.find(m => m.key === 'weekly')?.evidence, false);
  state.fundEntries.push({ id: 'f', fund: 'emergency', kind: 'deposit', amount: 100000, date: '2026-01-05', note: '' });
  assert.equal(missionDefinitions(state, now).find(m => m.key === 'emergency')?.evidence, true);
  state.repayments.push({ id: 'r', loan: 'boss', date: '2026-01-05', total: 330000, principal: 0, interest: 330000, note: '' });
  assert.equal(missionDefinitions(state, now).find(m => m.key === 'extra')?.evidence, false);
  state.repayments[0].principal = 296667; state.repayments[0].interest = 33333;
  assert.equal(missionDefinitions(state, now).find(m => m.key === 'extra')?.evidence, true);
  state.missions.push({ id: 'm', key: 'allocation', period: defs[0].period, completedAt: new Date().toISOString() });
  assert.deepEqual(validateState(state), []);
  state.missions = [];
  assert.equal(state.fundEntries.length, 1);
  assert.equal(state.expenses.length, 0);
});
test('validation rejects fractional KRW, invalid dates, malformed data and inconsistent allocations', () => {
  const state = createInitialState();
  state.expenses.push(expense('a', .5, '2026-02-30'));
  assert.ok(validateState(state).length);
  state.expenses = [];
  state.config.allocation.variableBudget++;
  assert.ok(validateState(state).some(e => e.includes('배분 합계')));
  assert.ok(validateState(state).some(e => e.includes('카테고리 합계')));
  assert.ok(validateState({ config: {} }).length);
  assert.ok(validateState(null).length);
});
test('KRW bounds also protect aggregate calculations from floating-point precision loss', () => {
  const state = createInitialState();
  const date = kstDate();
  state.expenses = Array.from({ length: 10_000 }, (_, i) => expense(`expense-${i}`, 100_000_000_000, date));
  assert.deepEqual(validateState(state), []);
  assert.equal(variableSpent(state), 1_000_000_000_000_000);
  assert.ok(Number.isSafeInteger(variableSpent(state)));
  state.expenses[0].amount = 999_999_999_999;
  assert.ok(validateState(state).length);
});
