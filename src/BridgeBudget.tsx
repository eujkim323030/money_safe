import { useState, type FormEvent } from 'react';
import type { AppState } from '../shared/types';
import { activeBudget, kstDate, salaryCycle } from '../shared/domain';
import { addDays } from '../shared/spending-missions';

export default function BridgeBudget({ state, mutate, toast }: { state: AppState; mutate: (next: AppState | ((state: AppState) => AppState)) => void; toast: (message: string) => void }) {
  const active = activeBudget(state), today = kstDate();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(550000);
  const [end, setEnd] = useState(() => salaryCycle(new Date(), state.config.salary.payday).end);
  const [error, setError] = useState('');
  const days = Math.round((Date.parse(end) - Date.parse(today)) / 86_400_000) + 1;
  function start(event: FormEvent) {
    event.preventDefault();
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000 || !Number.isInteger(days) || days < 1 || days > 31) { setError('사용 가능한 금액과 오늘부터 1~31일 이내의 종료일을 입력해 주세요.'); return; }
    if (active.temporary && !confirm('현재 남은 돈을 기준으로 임시 예산을 새로 시작할까요? 이미 기록한 지출은 보존하고 새 잔액에서 다시 차감하지 않아요.')) return;
    mutate(current => ({ ...current, bridgeBudget: { id: crypto.randomUUID(), amount, startDate: today, endDate: end, excludedExpenseIds: current.expenses.map(expense => expense.id) } }));
    setOpen(false); setError(''); toast('월급 전 예산으로 시작했어요. 월급 전체를 다시 배분하지 않아도 돼요.');
  }
  return <section className="card bridge-setup"><div className="section-heading"><h2>{active.temporary ? '월급 전 예산 사용 중' : '월급 전에도 바로 시작'}</h2><span className="pill mint">지금 가진 돈으로</span></div><p>{active.temporary ? `${active.start} ~ ${active.end} · 이 기간이 끝나면 원래 월급 예산으로 돌아가요.` : '월급 전체를 맞춰 나누지 않아도 괜찮아요. 지금 쓸 수 있는 잔액과 날짜만 정해요.'}</p><button className="button wide" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '입력 닫기' : active.temporary ? '현재 잔액으로 다시 설정' : '월급 전 예산으로 시작'}</button>
    {open && <form onSubmit={start}><label className="field">지금 쓸 수 있는 돈 (원)<input type="number" inputMode="numeric" required min={1} max={100_000_000_000} step={1} value={amount} onChange={event => setAmount(Number(event.target.value))} /></label><label className="field">이 돈으로 지낼 마지막 날<input type="date" required min={today} max={addDays(today, 30)} value={end} onChange={event => setEnd(event.target.value)} /></label>{Number.isInteger(days) && days > 0 && <div className="validation-strip"><strong>{amount.toLocaleString('ko-KR')}원 ÷ {days}일 = 하루 {Math.floor(amount / days).toLocaleString('ko-KR')}원</strong><span>오늘부터 종료일까지 포함해요. 하루 금액은 참고용이며 남은 금액에 따라 달라져요.</span></div>}<p className="fine-print">현재 잔액이므로 이미 입력한 지출은 다시 빼지 않아요. 시작 후 새로 입력한 기간 내 지출부터 차감해요. 카테고리별 금액은 기존 예산 비율로 나누며 월급·저축 계획은 유지해요.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary wide">이 금액으로 시작하기</button></form>}
  </section>;
}
