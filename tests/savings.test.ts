import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialState, fundBalance, kstDate, salaryCycle, validateState, variableSpent } from '../shared/domain';
import { savingsAccounts, savingsActivity } from '../shared/savings';

test('allocation-linked accounts have unknown balances until confirmed, without changing monthly allocation', () => {
  const state = createInitialState(); const config = structuredClone(state.config);
  for (const account of savingsAccounts) assert.equal(fundBalance(state, account.id), null);
  state.fundEntries = [
    { id: 'opening-youth', fund: 'youth', kind: 'adjust', amount: 2000000, date: kstDate(), note: '' },
    { id: 'opening-nh', fund: 'nonghyup', kind: 'adjust', amount: 2700000, date: kstDate(), note: '' },
  ];
  assert.deepEqual(validateState(state), []);
  assert.equal(fundBalance(state, 'youth'), 2000000); assert.equal(fundBalance(state, 'nonghyup'), 2700000);
  assert.equal(fundBalance(state, 'travel'), null);
  assert.deepEqual(savingsActivity(state, 'youth', salaryCycle()), { count: 0, deposited: 0, withdrawn: 0 });
  assert.equal(variableSpent(state), 0); assert.deepEqual(state.config, config);
});
test('deposits and withdrawals stay in their own account and count actual deposits only', () => {
  const state = createInitialState(); const date = kstDate();
  state.fundEntries = [
    { id: 'a', fund: 'youth', kind: 'adjust', amount: 2000000, date, note: '' },
    { id: 'b', fund: 'youth', kind: 'deposit', amount: 500000, date, note: '' },
    { id: 'c', fund: 'youth', kind: 'withdraw', amount: 100000, date, note: '' },
    { id: 'd', fund: 'travel', kind: 'deposit', amount: 100000, date, note: '' },
  ];
  assert.deepEqual(validateState(state), []); assert.equal(fundBalance(state, 'youth'), 2400000);
  assert.equal(fundBalance(state, 'travel'), null);
  assert.deepEqual(savingsActivity(state, 'youth', salaryCycle()), { count: 1, deposited: 500000, withdrawn: 100000 });
  assert.deepEqual(savingsActivity(state, 'youth', { start: '2000-01-01', end: '2000-01-31' }), { count: 0, deposited: 0, withdrawn: 0 });
  assert.equal(variableSpent(state), 0);
});
test('all allocation-linked savings accounts enforce unknown balances and chronological overdraft rules', () => {
  for (const { id: fund } of savingsAccounts) {
    const state = createInitialState(); const date = kstDate();
    state.fundEntries = [{ id: 'withdraw', fund, kind: 'withdraw', amount: 1, date, note: '' }];
    assert.ok(validateState(state).some(error => error.includes('미확인 잔액')));
    state.fundEntries.unshift({ id: 'opening', fund, kind: 'adjust', amount: 0, date, note: '' });
    assert.ok(validateState(state).some(error => error.includes('많은 금액')));
    state.fundEntries[0].amount = 1;
    assert.deepEqual(validateState(state), []); assert.equal(fundBalance(state, fund), 0);
    state.fundEntries[0].amount = -1;
    assert.ok(validateState(state).length > 0);
  }
});
