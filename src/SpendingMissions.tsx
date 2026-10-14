import { useEffect, useState, type FormEvent } from 'react';
import type { AppState } from '../shared/types';
import { kstDate } from '../shared/domain';
import { addDays, goalDates, spendingGoalProgress, suggestedGoalLimit } from '../shared/spending-missions';
import { categoryArt } from '../shared/categories';

type Props = { state: AppState; mutate: (next: AppState | ((state: AppState) => AppState)) => void; toast: (message: string) => void; onRecord: () => void };
const money = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
const DAY = 86_400_000;
export default function SpendingMissions({ state, mutate, toast, onRecord }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [category, setCategory] = useState(() => state.config.categories.find(item => item.id === 'shopping' || item.icon === 'shopping')?.id ?? '');
  const [days, setDays] = useState(3);
  const [limit, setLimit] = useState(() => suggestedGoalLimit(state, state.config.categories.find(item => item.id === 'shopping' || item.icon === 'shopping')?.id ?? null, 3));
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => setNow(new Date()); const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const today = kstDate(now), goals = state.spendingGoals ?? [], pauses = state.purchasePauses ?? [];
  const activeGoals = goals.filter(goal => !spendingGoalProgress(state, goal, now).ended && spendingGoalProgress(state, goal, now).available);
  const reviewDates = [...new Set(goals.flatMap(goalDates))].filter(date => date < today).sort().reverse();
  function recommend(nextCategory: string, nextDays: number) { setCategory(nextCategory); setDays(nextDays); setLimit(suggestedGoalLimit(state, nextCategory || null, nextDays, new Date())); }
  function startGoal(event: FormEvent) {
    event.preventDefault(); const date = kstDate();
    if (activeGoals.length >= 3 || goals.length >= 100) { setError('진행 중인 도전은 3개까지예요. 먼저 진행 중인 도전을 마무리해 주세요.'); return; }
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100_000_000_000) { setError('목표 금액은 0 이상의 정수 원화로 입력해 주세요.'); return; }
    if (goals.some(goal => goal.categoryId === (category || null) && goal.startDate <= date && goal.endDate >= date)) { setError('같은 항목의 도전이 진행 중이에요. 기존 도전을 먼저 마무리해 주세요.'); return; }
    const goal = { id: crypto.randomUUID(), categoryId: category || null, categoryName: state.config.categories.find(item => item.id === category)?.name ?? '전체 생활비', startDate: date, endDate: addDays(date, days - 1), limit, excludedExpenseIds: state.expenses.map(expense => expense.id), createdAt: new Date().toISOString() };
    mutate(current => ({ ...current, spendingGoals: [...(current.spendingGoals ?? []), goal] })); setError(''); toast('절약 도전을 시작했어요. 지출을 기록하며 남은 금액을 확인해요.');
  }
  function startPause(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
    const name = String(values.get('item') ?? '').trim(), amount = Number(values.get('price'));
    if (!name || name.length > 80 || !Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000 || pauses.length >= 100) { setError('물건 이름·가격을 확인해 주세요. 구매 보류는 최대 100개까지 기록할 수 있어요.'); return; }
    mutate(current => ({ ...current, purchasePauses: [...(current.purchasePauses ?? []), { id: crypto.randomUUID(), name, amount, createdAt: new Date().toISOString() }] }));
    form.reset(); setError(''); toast('구매를 24시간 보류했어요. 장바구니에 두고 내일 다시 생각해요.');
  }
  function resolvePause(id: string, resolution: 'skipped' | 'bought') {
    const time = new Date(); const pause = pauses.find(item => item.id === id);
    if (!pause || pause.resolution || (resolution === 'skipped' && time.getTime() - Date.parse(pause.createdAt) < DAY)) return;
    mutate(current => ({ ...current, purchasePauses: (current.purchasePauses ?? []).map(item => item.id === id ? { ...item, resolution, resolvedAt: time.toISOString() } : item) }));
    toast(resolution === 'skipped' ? '하루 기다리고 안 사기로 결정했어요. +20 XP' : '구매 결정을 기록했어요. 실제 결제 금액은 지출에 따로 남겨 주세요.');
  }
  return <section className="spending-missions" aria-label="소비 줄이기 미션">
    <section className="card pause-mission"><span className="pill lavender">충동구매 브레이크 · +20 XP</span><h2>사기 전에, 24시간</h2><p>장바구니에 두고 하루만 기다려요. 내일도 필요한지, 이미 비슷한 게 있는지 다시 생각해요.</p>
      <form onSubmit={startPause}><label className="field">사고 싶은 물건<input name="item" required maxLength={80} placeholder="예: 세일 중인 운동화" /></label><label className="field">예상 가격 (원)<input name="price" type="number" inputMode="numeric" min={1} max={100_000_000_000} step={1} required placeholder="50000" /></label><button className="button primary wide" disabled={pauses.length >= 100}>24시간 보류 시작</button></form>
      {pauses.filter(pause => !pause.resolution).map(pause => {
        const minutes = Math.max(0, Math.ceil((Date.parse(pause.createdAt) + DAY - now.getTime()) / 60_000));
        return <article className="pause-item" key={pause.id}><strong>{pause.name} <span>{money(pause.amount)}</span></strong><p>{minutes ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 뒤 다시 결정해요.` : '하루가 지났어요. 지금도 꼭 필요한가요?'}</p><div className="button-row"><button className="button" disabled={minutes > 0} onClick={() => resolvePause(pause.id, 'skipped')}>안 사기로 했어요</button><button className="text-button" onClick={() => { if (confirm('이 물건을 구매하기로 결정했나요? 실제 결제 금액은 지출에 따로 기록해 주세요.')) resolvePause(pause.id, 'bought'); }}>구매하기로 했어요</button></div></article>;
      })}
      {pauses.some(pause => pause.resolution) && <details className="pause-history"><summary>내가 다시 생각한 구매 {pauses.filter(pause => pause.resolution).length}건</summary>{pauses.filter(pause => pause.resolution).slice().reverse().map(pause => <p key={pause.id}>{pause.name} · {money(pause.amount)} · {pause.resolution === 'skipped' ? '안 사기로 결정' : '구매 결정'}</p>)}<button className="text-button" onClick={onRecord}>구매한 금액 지출 기록하기 →</button></details>}
      <p className="fine-print">보류한 물건의 가격은 실제 절약액이나 저축 잔액에 더하지 않아요. 앱을 닫아도 대기 시간은 이어져요.</p>
    </section>
    <section className="card goal-builder"><span className="pill mint">작게 시작하는 절약 · 성공 시 +40 XP</span><h2>쇼핑부터, 예산 안에서</h2><p>줄이고 싶은 항목 하나를 골라요. 시작 뒤 새로 기록한 지출을 기준으로 해요. 목표는 도중에 자동으로 늘어나지 않아요.</p>
      <form onSubmit={startGoal}><div className="field-grid"><label className="field">줄일 지출<select value={category} onChange={event => recommend(event.target.value, days)}><option value="">전체 생활비</option>{state.config.categories.map(item => <option key={item.id} value={item.id}>{categoryArt(item).symbol} {item.name}</option>)}</select></label><label className="field">도전 기간<select value={days} onChange={event => recommend(category, Number(event.target.value))}><option value={1}>오늘 하루</option><option value={3}>3일</option><option value={7}>7일</option></select></label></div><label className="field">기간 동안 쓸 최대 금액 (원)<input type="number" inputMode="numeric" required min={0} max={100_000_000_000} step={1} value={limit} onChange={event => setLimit(Number(event.target.value))} /></label><p className="fine-print">추천값은 현재 적용 중인 예산의 남은 금액을 남은 일수로 나눈 뒤, 도전 일수만큼 잡아 10% 낮춘 금액이에요. 새 급여 주기의 예산은 미리 포함하지 않아요. 내 상황에 맞게 바꿔도 괜찮아요.</p><button className="button primary wide" disabled={activeGoals.length >= 3 || goals.length >= 100}>절약 도전 시작</button></form>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {goals.length > 0 && <div className="section-heading spaced"><h2>내 절약 도전</h2><button className="text-button" onClick={onRecord}>지출 기록 →</button></div>}
    {goals.slice().reverse().map(goal => {
      const progress = spendingGoalProgress(state, goal, now);
      const categoryName = state.config.categories.find(item => item.id === goal.categoryId)?.name ?? goal.categoryName;
      return <article className={`card saving-goal ${progress.complete ? 'completed' : ''}`} key={goal.id}><div className="section-heading"><h3>{categoryName} 예산 지키기</h3><span className="pill">{!progress.available ? '항목 삭제로 종료' : progress.complete ? '성공 +40 XP' : progress.spent > goal.limit ? '목표 초과' : progress.ended ? '기록 확인 필요' : '진행 중'}</span></div><p>{goal.startDate} ~ {goal.endDate} · 한국 시간</p><strong className="saving-amount">{money(progress.spent)} <small>/ 목표 {money(goal.limit)}</small></strong><div className="progress blue" role="progressbar" aria-label={`${categoryName} 도전 예산 사용률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={goal.limit ? Math.min(100, Math.round(progress.spent / goal.limit * 100)) : progress.spent ? 100 : 0}><span style={{ width: `${goal.limit ? Math.min(100, progress.spent / goal.limit * 100) : progress.spent ? 100 : 0}%` }} /></div><p>{progress.spent > goal.limit ? `${money(progress.spent - goal.limit)} 초과했어요. 다음 도전의 목표를 현실적으로 조정해 봐요.` : progress.ended ? `${money(progress.remaining)} 목표 여유 · 이 금액은 실제 절약액이 아니에요.` : `남은 금액 ${money(progress.remaining)} · 남은 ${progress.daysLeft}일 하루 가이드 ${money(progress.dailyGuide)}`}</p><small>지출 확인 {goalDates(goal).length - progress.missingDates.length}/{goalDates(goal).length}일 · 기간 종료와 모든 날짜의 기록 확인 후 성공을 판정해요.</small><button className="text-button danger" onClick={() => { if (confirm('이 도전을 지울까요? 지출 기록과 예산은 그대로 남아요.')) mutate(current => ({ ...current, spendingGoals: (current.spendingGoals ?? []).filter(item => item.id !== goal.id) })); }}>도전 지우기</button></article>;
    })}
    {reviewDates.length > 0 && <section className="card spending-reviews"><h2>빠진 지출 없이 돌아보기</h2><p>그날의 카드·현금 지출을 모두 기록했는지 확인해요. 지출이 없던 날도 직접 확인해야 해요.</p>{reviewDates.map(date => { const checked = (state.spendingReviews ?? []).some(review => review.date === date); return <div className="review-day" key={date}><span>{date}</span><button className="button small" aria-pressed={checked} onClick={() => {
      if (!checked && !confirm(`${date}의 지출을 모두 기록했나요? 지출이 없었다면 무지출이 맞는지 확인해 주세요.`)) return;
      mutate(current => ({ ...current, spendingReviews: checked ? (current.spendingReviews ?? []).filter(review => review.date !== date) : [...(current.spendingReviews ?? []), { date, reviewedAt: new Date().toISOString() }] }));
    }}>{checked ? '확인 취소' : '기록 확인 완료'}</button></div>; })}<p className="fine-print">은행 내역과 자동 대조하지 않아요. 성공과 XP는 현재 지출 기록·확인 여부로 계산하며 기록을 수정하면 달라질 수 있어요.</p></section>}
  </section>;
}
