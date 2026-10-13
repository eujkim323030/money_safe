import starter from './starter-config.json';
import type { AppState, Config, FundEntry } from './types';

const DAY = 86_400_000;
const KST = 9 * 3_600_000;
export function createInitialState(): AppState {
  return { config: structuredClone(starter) as Config, expenses: [], repayments: [], fundEntries: [], missions: [], preferences: { effects: true, sound: false, nagIntensity: 'gentle' } };
}
export function kstDate(value: Date | string = new Date()): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(new Date(value).getTime() + KST).toISOString().slice(0, 10);
}
export interface SalaryCycle { start: string; end: string; key: string; label: string }
export function salaryCycle(value: Date | string = new Date(), startDay = 25): SalaryCycle {
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) throw new Error('월급일은 1~28일로 설정해 주세요.');
  const today = kstDate(value);
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - (d < startDay ? 1 : 0), startDay));
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, startDay));
  const end = new Date(next.getTime() - DAY);
  const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
  return { start: s, end: e, key: s, label: `${Number(s.slice(5, 7))}.${Number(s.slice(8))} ~ ${Number(e.slice(5, 7))}.${Number(e.slice(8))}` };
}
export function allocationTotal(config: Config): number {
  const a = config.allocation;
  return Object.values(a.savings).reduce((s, v) => s + v, 0) + Object.values(a.loanPayments).reduce((s, v) => s + v, 0) + a.fixedExpenses + a.emergencyContribution + a.bigPurchaseContribution + a.variableBudget;
}
export const inCycle = (date: string, cycle: SalaryCycle) => date >= cycle.start && date <= cycle.end;
export function variableSpent(state: AppState, cycle = salaryCycle(new Date(), state.config.salary.cycleStartDay)): number {
  return state.expenses.filter(e => inCycle(e.date, cycle)).reduce((s, e) => s + e.amount, 0);
}
export function loanBalance(state: AppState): number {
  return state.config.bossLoan.currentBalance - state.repayments.filter(r => r.loan === 'boss').reduce((s, r) => s + (r.principal ?? 0), 0);
}
export function fundBalance(state: AppState, fund: FundEntry['fund']): number | null {
  let balance: number | null = fund === 'emergency' ? state.config.goals.emergencyFund.balance : state.config.goals.bigPurchaseFund.balance;
  for (const e of state.fundEntries.filter(e => e.fund === fund).map((e, i) => ({ ...e, i })).sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i)) {
    if (e.kind === 'adjust') balance = e.amount;
    else if (balance !== null) balance += e.kind === 'deposit' ? e.amount : -e.amount;
  }
  return balance;
}
export function cycleComparison(state: AppState, now: Date | string = new Date()) {
  const current = salaryCycle(now, state.config.salary.cycleStartDay);
  const previous = salaryCycle(new Date(new Date(`${current.start}T00:00:00+09:00`).getTime() - DAY), state.config.salary.cycleStartDay);
  return { current: { cycle: current, spent: variableSpent(state, current) }, previous: { cycle: previous, spent: variableSpent(state, previous) } };
}
export function missionDefinitions(state: AppState, now: Date | string = new Date()) {
  const cycle = salaryCycle(now, state.config.salary.cycleStartDay);
  const today = kstDate(now);
  const sunday = new Date(`${today}T00:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const week = sunday.toISOString().slice(0, 10);
  const repayments = state.repayments.filter(r => r.loan === 'boss' && inCycle(r.date, cycle)).reduce((s, r) => s + r.total, 0);
  const repaidPrincipal = state.repayments.filter(r => r.loan === 'boss' && inCycle(r.date, cycle)).reduce((s, r) => s + (r.principal ?? 0), 0);
  const emergency = state.fundEntries.filter(e => e.fund === 'emergency' && inCycle(e.date, cycle) && e.kind !== 'adjust').reduce((s, e) => s + (e.kind === 'deposit' ? e.amount : -e.amount), 0);
  return [
    { key: 'allocation', title: '월급 분배 확인', description: '예산을 살펴보고 실제 계좌 분배를 확인해요.', period: cycle.key, evidence: allocationTotal(state.config) === state.config.salary.monthlyAmount, points: 30 },
    { key: 'weekly', title: '이번 주 지출 결산', description: '기록을 한 번 살펴보는 것만으로도 한 걸음!', period: week, evidence: state.expenses.some(e => e.date >= week && e.date <= today), points: 20 },
    { key: 'extra', title: '추가 상환 확인', description: '정기 + 추가 납입 목표와 추가 목표 이상의 실제 원금 기록을 확인해요.', period: cycle.key, evidence: repayments >= state.config.bossLoan.regularPayment + state.config.bossLoan.extraPrincipalGoal && repaidPrincipal >= state.config.bossLoan.extraPrincipalGoal, points: 40 },
    { key: 'emergency', title: '비상금 적립 확인', description: '실제 적립 기록을 확인하고 햄찌를 응원해요.', period: cycle.key, evidence: emergency >= state.config.goals.emergencyFund.monthlyContribution, points: 30 }
  ];
}
export function simulateLoan(balance: number, annualRate: number, regular: number, extra: number) {
  let remaining = balance, interestTotal = 0;
  const rows: { month: number; interest: number; principal: number; remaining: number }[] = [];
  for (let month = 1; remaining > 0 && month <= 600; month++) {
    const interest = Math.round(remaining * annualRate / 12);
    const principal = Math.min(remaining, regular - interest + extra);
    if (principal <= 0) return { months: null, interestTotal, rows, assumption: '월 이자 = 잔액 × 연이율 ÷ 12, 수수료 제외' };
    remaining -= principal; interestTotal += interest;
    rows.push({ month, interest, principal, remaining });
  }
  return { months: remaining === 0 ? rows.length : null, interestTotal, rows, assumption: '월 이자 = 잔액 × 연이율 ÷ 12, 정기 원리금 + 추가 원금, 수수료 제외. 실제 상환방식·납부일 미확인' };
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
// With at most 10,000 records per ledger this cap also keeps aggregate sums
// exactly representable as integer KRW in JavaScript (below MAX_SAFE_INTEGER).
const isMoney = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000_000;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
export function validateState(value: unknown): string[] {
  const errors: string[] = [];
  const check = (ok: unknown, message: string) => { if (!ok) errors.push(message); };
  if (!isObject(value)) return ['데이터 형식이 올바르지 않습니다.'];
  try {
    const state = value as unknown as AppState;
    const c = state.config;
    check(isObject(c) && isObject(c.salary) && isObject(c.allocation) && isObject(c.bossLoan) && isObject(c.goals) && isObject(c.push), '설정 형식을 확인해 주세요.');
    if (errors.length) return errors;
    check(c.app?.timezone === 'Asia/Seoul' && c.app.currency === 'KRW', '시간대는 서울, 금액은 원화입니다.');
    check(isMoney(c.salary.monthlyAmount) && c.salary.monthlyAmount > 0, '월급은 양의 정수 원화로 입력해 주세요.');
    check(Number.isInteger(c.salary.payday) && c.salary.payday >= 1 && c.salary.payday <= 28 && c.salary.cycleStartDay === c.salary.payday, '월급일과 주기 시작일을 동일한 1~28일로 설정해 주세요.');
    const a = c.allocation;
    check(isObject(a.savings) && isObject(a.loanPayments), '저축·대출 배분 설정이 필요합니다.');
    const amounts = [a.savings.youth, a.savings.nonghyup, a.savings.travel, a.loanPayments.otherLoan, a.loanPayments.bossLoanRegular, a.loanPayments.bossLoanExtra, a.fixedExpenses, a.emergencyContribution, a.bigPurchaseContribution, a.variableBudget];
    check(amounts.every(isMoney), '배분 금액은 0 이상의 정수 원화입니다.');
    check(Object.keys(a.savings).length === 3 && Object.keys(a.loanPayments).length === 3, '지원하지 않는 배분 항목입니다.');
    check(allocationTotal(c) === c.salary.monthlyAmount, '월급 배분 합계가 월급과 같아야 합니다.');
    const categoryIds = ['food', 'cafe', 'date', 'shopping', 'running', 'other'];
    check(Array.isArray(c.categories) && c.categories.length === 6 && new Set(c.categories.map(x => x.id)).size === 6 && c.categories.every(x => categoryIds.includes(x.id) && isMoney(x.budget) && isText(x.name, 30)), '6개 카테고리 예산을 확인해 주세요.');
    check(c.categories.reduce((s, x) => s + x.budget, 0) === a.variableBudget, '카테고리 합계가 생활비 예산과 같아야 합니다.');
    const b = c.bossLoan;
    check([b.initialBalance, b.currentBalance, b.regularPayment, b.extraPrincipalGoal].every(isMoney) && b.initialBalance > 0, '대출 금액을 확인해 주세요.');
    check(Number.isFinite(b.annualInterestRate) && b.annualInterestRate >= 0 && b.annualInterestRate <= 1 && Number.isFinite(b.prepaymentFeeRate) && b.prepaymentFeeRate >= 0 && b.prepaymentFeeRate <= 1 && isText(b.repaymentType, 80), '대출 금리·상환방식을 확인해 주세요.');
    check(b.regularPayment === a.loanPayments.bossLoanRegular && b.extraPrincipalGoal === a.loanPayments.bossLoanExtra, '대출 상환 목표와 배분 금액을 맞춰 주세요.');
    check(isMoney(c.goals.emergencyFund.balance) && isMoney(c.goals.emergencyFund.target) && c.goals.emergencyFund.target > 0 && isMoney(c.goals.emergencyFund.monthlyContribution) && (c.goals.bigPurchaseFund.balance === null || isMoney(c.goals.bigPurchaseFund.balance)) && isMoney(c.goals.bigPurchaseFund.monthlyContribution), '저축 목표 금액을 확인해 주세요.');
    check(c.goals.emergencyFund.monthlyContribution === a.emergencyContribution && c.goals.bigPurchaseFund.monthlyContribution === a.bigPurchaseContribution, '저축 목표와 배분 금액을 맞춰 주세요.');
    const p = c.push;
    check(typeof p.enabled === 'boolean' && p.budgetThreshold === 0.8, '알림 설정을 확인해 주세요.');
    check([p.payday.hour, p.weeklyReview.hour, p.cycleEnd.hour, p.inactivityHour ?? 20].every(h => Number.isInteger(h) && h >= 0 && h <= 23) && [p.payday.minute ?? 0, p.weeklyReview.minute ?? 0, p.cycleEnd.minute ?? 0].every(m => Number.isInteger(m) && m >= 0 && m < 60), '알림 시간을 확인해 주세요.');
    check(Number.isInteger(p.inactivityDays) && p.inactivityDays >= 1 && p.inactivityDays <= 30 && p.weeklyReview.dayOfWeek === 0 && p.payday.day === c.salary.payday && p.cycleEnd.day === (c.salary.payday === 1 ? 31 : c.salary.payday - 1), '알림 날짜·미기록 일수를 확인해 주세요.');
    check(isObject(state.preferences) && typeof state.preferences.effects === 'boolean' && typeof state.preferences.sound === 'boolean' && ['gentle', 'normal', 'firm'].includes(state.preferences.nagIntensity), '효과 설정을 확인해 주세요.');
    for (const list of [state.expenses, state.repayments, state.fundEntries, state.missions]) check(Array.isArray(list) && list.length <= 10_000, '기록 배열은 최대 10,000개입니다.');
    if (errors.some(e => e.includes('기록 배열'))) return errors;
    const all = [...state.expenses, ...state.repayments, ...state.fundEntries, ...state.missions];
    check(all.every(e => isText(e.id, 100) && idPattern.test(e.id)) && new Set(all.map(e => e.id)).size === all.length, '기록 ID가 중복되거나 올바르지 않습니다.');
    const today = kstDate();
    check(state.expenses.every(e => isMoney(e.amount) && e.amount > 0 && isDate(e.date) && e.date <= today && categoryIds.includes(e.category) && isText(e.note) && isText(e.emotion, 40) && typeof e.createdAt === 'string' && Number.isFinite(Date.parse(e.createdAt))), '지출 금액·날짜·카테고리를 확인해 주세요. 미래 지출은 등록할 수 없습니다.');
    check(state.repayments.every(r => ['boss', 'other'].includes(r.loan) && isDate(r.date) && r.date <= today && isMoney(r.total) && r.total > 0 && isText(r.note) && ((r.loan === 'other' && r.principal === null && r.interest === null) || (isMoney(r.principal) && isMoney(r.interest) && r.total === r.principal + r.interest))), '상환 기록은 원금·이자 합계가 납입액과 같아야 합니다. 미확인 별도 대출은 총액만 기록합니다.');
    check(loanBalance(state) >= 0, '상환 원금 합계가 기록 기준 잔액을 초과합니다.');
    check(state.fundEntries.every(e => ['emergency', 'bigPurchase'].includes(e.fund) && ['deposit', 'withdraw', 'adjust'].includes(e.kind) && isMoney(e.amount) && (e.kind === 'adjust' || e.amount > 0) && isDate(e.date) && e.date <= today && isText(e.note)), '저축 기록 금액·날짜를 확인해 주세요.');
    for (const fund of ['emergency', 'bigPurchase'] as const) {
      let balance: number | null = fund === 'emergency' ? c.goals.emergencyFund.balance : c.goals.bigPurchaseFund.balance;
      for (const e of state.fundEntries.filter(e => e.fund === fund).map((e, i) => ({ ...e, i })).sort((x, y) => x.date.localeCompare(y.date) || x.i - y.i)) {
        if (e.kind === 'adjust') balance = e.amount;
        else if (e.kind === 'withdraw' && balance === null) check(false, '미확인 잔액은 잔액 조정 후 인출을 기록해 주세요.');
        else if (balance !== null) balance += e.kind === 'deposit' ? e.amount : -e.amount;
        check(balance === null || balance >= 0, '저축 잔액보다 많은 금액을 인출할 수 없습니다.');
      }
    }
    check(state.missions.every(m => ['allocation', 'weekly', 'extra', 'emergency'].includes(m.key) && isDate(m.period) && typeof m.completedAt === 'string' && Number.isFinite(Date.parse(m.completedAt))) && new Set(state.missions.map(m => `${m.key}:${m.period}`)).size === state.missions.length, '미션 기록이 올바르지 않거나 중복입니다.');
  } catch { errors.push('필수 설정과 기록 필드가 올바른지 확인해 주세요.'); }
  return [...new Set(errors)];
}
