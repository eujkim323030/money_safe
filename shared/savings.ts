import type { AppState, FundEntry } from './types';

export const savingsAccounts = [
  { id: 'youth', name: '청년미래저축', character: 'fairy' },
  { id: 'nonghyup', name: '농협 적금', character: 'hamster' },
  { id: 'travel', name: '여행 저축', character: 'cat' },
] as const;
export const fundNames: Record<FundEntry['fund'], string> = {
  emergency: '비상금', bigPurchase: '큰 지출 준비금',
  youth: '청년미래저축', nonghyup: '농협 적금', travel: '여행 저축',
};
export function initialFundBalance(state: AppState, fund: FundEntry['fund']): number | null {
  if (fund === 'emergency') return state.config.goals.emergencyFund.balance;
  if (fund === 'bigPurchase') return state.config.goals.bigPurchaseFund.balance;
  return null;
}
export function savingsActivity(state: AppState, fund: FundEntry['fund'], cycle: { start: string; end: string }) {
  const entries = state.fundEntries.filter(entry => entry.fund === fund && entry.date >= cycle.start && entry.date <= cycle.end);
  const deposits = entries.filter(entry => entry.kind === 'deposit');
  return { count: deposits.length, deposited: deposits.reduce((sum, entry) => sum + entry.amount, 0), withdrawn: entries.filter(entry => entry.kind === 'withdraw').reduce((sum, entry) => sum + entry.amount, 0) };
}
