import { useRef, useState, type FormEvent } from 'react';
import { fundBalance, kstDate, salaryCycle, validateState } from '../shared/domain';
import { savingsAccounts, savingsActivity } from '../shared/savings';
import type { AppState, FundEntry } from '../shared/types';
import Pixel from './Pixel';

const money = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
type Account = typeof savingsAccounts[number]['id'];
// Optional user-provided values stay in the URL fragment and are never saved until confirmed.
function suggestedBalances(): Record<Account, string> {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return Object.fromEntries(savingsAccounts.map(({ id }) => {
    const value = params.get(id) ?? '';
    return [id, /^\d{1,12}$/.test(value) && Number(value) <= 100_000_000_000 ? value : ''];
  })) as Record<Account, string>;
}
export default function SavingsAccounts({ state, mutate, toast, onRecord }: {
  state: AppState; mutate: (next: AppState) => void; toast: (message: string) => void; onRecord: (fund: FundEntry['fund']) => void;
}) {
  const [balances, setBalances] = useState(suggestedBalances);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const missing = savingsAccounts.filter(account => fundBalance(state, account.id) === null);
  const cycle = salaryCycle(new Date(), state.config.salary.cycleStartDay);
  function save(event: FormEvent) {
    event.preventDefault(); if (submitted.current) return;
    const entries: FundEntry[] = missing.filter(account => balances[account.id].trim() !== '').map(account => ({ id: crypto.randomUUID(), fund: account.id, kind: 'adjust', amount: Number(balances[account.id]), date: kstDate(), note: '시작할 때 확인한 계좌 잔액' }));
    if (!entries.length) { setError('잔액을 확인한 계좌를 하나 이상 입력해 주세요.'); return; }
    const next = { ...state, fundEntries: [...state.fundEntries, ...entries] };
    const errors = validateState(next); if (errors.length) { setError(errors[0]); return; }
    submitted.current = true; mutate(next); setError('');
    setBalances({ youth: '', nonghyup: '', travel: '' });
    // Remove the optional prefill once used; no saved account balance is overwritten.
    if (location.hash.includes('?')) history.replaceState(null, '', `${location.pathname}${location.search}#savings`);
    toast('저축 계좌 잔액을 저장했어요. 기존 잔액은 새 적립액에 포함하지 않아요.');
  }
  return <section className="savings-accounts" aria-label="월급 분배 저축 계좌">
    <div className="section-heading"><h2>월급에서 모으는 저축</h2><a className="text-button" href="#settings">월 적립 계획 수정 ↗</a></div>
    <p className="fine-print">월급 분배의 저축 항목과 연결돼요. 계획만으로 잔액이 늘지는 않아요.</p>
    {missing.length > 0 && <form className="card savings-opening" onSubmit={save}>
      <h3>이미 모은 돈부터 시작해요</h3><p>오늘 계좌에서 확인한 잔액을 입력해 주세요. 모르는 계좌는 비워둬도 돼요.</p>
      {missing.map(account => <label className="field" key={account.id}>{account.name} 현재 잔액<span className="input-suffix"><input type="number" inputMode="numeric" min={0} max={100_000_000_000} step={1} value={balances[account.id]} placeholder="확인한 잔액 입력" onChange={event => { submitted.current = false; setBalances(current => ({ ...current, [account.id]: event.target.value })); }} /><span>원</span></span></label>)}
      {error && <p className="form-error" role="alert">{error}</p>}<button className="button mint wide">저축 계좌 잔액 저장</button>
      <p className="fine-print">기존 잔액은 적립 건수나 이번 달 저축액에 더하지 않아요.</p>
    </form>}
    {savingsAccounts.map(account => {
      const balance = fundBalance(state, account.id), planned = state.config.allocation.savings[account.id];
      const activity = savingsActivity(state, account.id, cycle);
      return <article className="fund-card linked-saving" data-fund={account.id} key={account.id}>
        <div className="fund-top"><div><span className="pill blue">월급 분배와 연결</span><h3>{account.name}</h3><div className={balance === null ? 'unknown-balance' : 'big-number'}>{balance === null ? '현재 잔액 미확인' : money(balance)}</div></div><Pixel kind={account.character} size={64} /></div>
        <div className="inline-note">월 적립 계획 <strong>{money(planned)}</strong></div>
        <p>이번 급여 주기 적립 {activity.count}건 · {money(activity.deposited)}{activity.withdrawn > 0 && ` · 인출 ${money(activity.withdrawn)}`}</p>
        <button className="button wide" onClick={() => onRecord(account.id)}>{balance === null ? '현재 잔액 입력하기' : '＋ 적립 · 인출 · 잔액 조정'}</button>
      </article>;
    })}
  </section>;
}
