import { useState, type FormEvent } from 'react';
import type { AppState } from '../shared/types';
import { activeBudget, kstDate, salaryCycle, variableSpent } from '../shared/domain';
import { bridgeCash } from '../shared/spending-cash';
import { addDays } from '../shared/spending-missions';
const money = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
export default function BridgeBudget({ state, mutate, toast }: { state: AppState; mutate: (next: AppState | ((state: AppState) => AppState)) => void; toast: (message: string) => void }) {
  const active = activeBudget(state), today = kstDate(), cash = active.temporary ? bridgeCash(state) : null;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(550000);
  const [scope, setScope] = useState<'living' | 'shared' | ''>('');
  const [reserve, setReserve] = useState(0);
  const [end, setEnd] = useState(() => salaryCycle(new Date(), state.config.salary.payday).end);
  const [error, setError] = useState('');
  const days = Math.round((Date.parse(end) - Date.parse(today)) / 86_400_000) + 1;
  const available = amount - (scope === 'shared' ? reserve : 0);
  function toggle() {
    if (!open) {
      setAmount(cash ? Math.max(0, cash.cashRemaining) : 550000);
      setScope(active.temporary ? state.bridgeBudget?.cashScope ?? '' : '');
      setReserve(cash?.reservedRemaining ?? 0); setEnd(active.end); setError('');
    }
    setOpen(!open);
  }
  function start(event: FormEvent) {
    event.preventDefault();
    if (!scope) { setError('정기지출도 이 돈에서 내는지 선택해 주세요.'); return; }
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000 || !Number.isInteger(days) || days < 1 || days > 31 || (scope === 'shared' && (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > amount))) { setError('잔액·기간과 남겨둘 정기지출 금액을 확인해 주세요. 정기지출로 남길 돈은 잔액 이내여야 해요.'); return; }
    if (active.temporary && !confirm('지금 입력한 잔액으로 다시 시작할까요? 이전 기록은 보존하고 이 잔액에서 다시 빼지 않아요.')) return;
    mutate(current => ({ ...current, bridgeBudget: { id: crypto.randomUUID(), amount, cashScope: scope, regularReserve: scope === 'shared' ? reserve : 0, startDate: today, endDate: end, excludedExpenseIds: current.expenses.map(expense => expense.id) } }));
    setOpen(false); setError(''); toast('쓸 수 있는 생활비를 설정했어요. 새로 기록한 지출부터 반영해요.');
  }
  return <section className="card bridge-setup"><div className="section-heading"><h2>{active.temporary ? '쓸 수 있는 돈 설정' : '월급 전에도 바로 시작'}</h2><span className="pill mint">지금 가진 돈으로</span></div>
    <p>{active.temporary ? `${active.start} ~ ${active.end} · 생활비 ${money(cash?.available ?? active.budget - variableSpent(state))}` : '현재 잔액에서 앞으로 낼 돈을 남겨두고, 생활비만 따로 확인해요.'}</p>
    {active.temporary && <p className="fine-print">{state.bridgeBudget?.cashScope === 'shared' ? `정기지출도 같은 돈에서 납부 · 앞으로 남겨둔 돈 ${money(cash?.reservedRemaining ?? 0)}` : state.bridgeBudget?.cashScope === 'living' ? '정기지출은 다른 돈으로 납부 · 입력한 잔액은 생활비 전용' : '기존 예산은 정기지출이 별도라고 계산 중이에요. 아래에서 확인해 주세요.'}</p>}
    <button className="button wide" aria-expanded={open} onClick={toggle}>{open ? '입력 닫기' : active.temporary ? '현재 잔액으로 다시 설정' : '월급 전 예산으로 시작'}</button>
    {open && <form onSubmit={start}>
      <label className="field">지금 쓸 수 있는 돈 (원)<input type="number" inputMode="numeric" required min={1} max={100_000_000_000} step={1} value={amount} onChange={event => setAmount(Number(event.target.value))} /></label>
      <fieldset className="cash-scope"><legend>정기지출도 이 돈에서 내나요?</legend><label><input type="radio" name="cash-scope" required checked={scope === 'living'} onChange={() => setScope('living')} />아니요, 이 돈은 생활비 전용이에요</label><label><input type="radio" name="cash-scope" required checked={scope === 'shared'} onChange={() => setScope('shared')} />네, 정기지출도 여기서 내요</label></fieldset>
      {scope === 'shared' && <label className="field">종료일까지 정기지출로 남겨둘 돈 (원)<input type="number" inputMode="numeric" required min={0} max={amount} step={1} value={reserve} onChange={event => setReserve(Number(event.target.value))} /><small>이미 낸 돈은 제외해요. 앞으로 이 잔액에서 낼 통신비·교통비 등의 합계예요.</small></label>}
      <label className="field">이 돈으로 지낼 마지막 날<input type="date" required min={today} max={addDays(today, 30)} value={end} onChange={event => setEnd(event.target.value)} /></label>
      {scope && Number.isInteger(days) && days > 0 && available >= 0 && <div className="validation-strip"><strong>{money(available)} ÷ {days}일 = 하루 {money(Math.floor(available / days))}</strong><span>정기지출로 남겨둔 돈을 뺀 생활비예요. 납부액이 예상보다 크면 생활비도 줄어들어요.</span></div>}
      <p className="fine-print">기존 지출은 현재 잔액에 포함된 것으로 보고 다시 빼지 않아요. 종료 다음 날에는 월급 분배 예산으로 돌아가요.</p>
      {error && <p className="form-error" role="alert">{error}</p>}<button className="button primary wide">이 금액으로 시작하기</button>
    </form>}
  </section>;
}
