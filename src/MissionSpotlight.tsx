import { spendingGoalProgress } from '../shared/spending-missions';
import type { AppState } from '../shared/types';
import Pixel from './Pixel';

export default function MissionSpotlight({ state, open }: { state: AppState; open: () => void }) {
  const pending = (state.purchasePauses ?? []).filter(item => !item.resolution);
  const ready = pending.filter(item => Date.now() - Date.parse(item.createdAt) >= 86_400_000).length;
  const goals = (state.spendingGoals ?? []).map(goal => ({ goal, progress: spendingGoalProgress(state, goal) }));
  const active = goals.filter(({ progress }) => !progress.ended && progress.available);
  const review = goals.filter(({ progress }) => progress.ended && progress.available && progress.missingDates.length > 0);
  return <section className="mission-spotlight" aria-label="오늘의 절약 미션">
    <div className="mission-spotlight-title"><Pixel kind="fairy" size={48} /><div><span className="eyebrow">오늘의 절약 미션</span><h2>사기 전, 잠깐 멈추기</h2></div></div>
    <p>{ready > 0 ? `24시간이 지난 구매 ${ready}건, 이제 살지 말지 결정해요.` : pending.length > 0 ? `구매 ${pending.length}건 보류 중 · 기다리는 동안 한 번 더 생각해요.` : '갖고 싶은 물건은 24시간 보류하고, 쇼핑 예산을 지켜봐요.'}</p>
    {active.length > 0 && <p className="mission-live">도전 {active.length}개 진행 중 · {active[0].goal.categoryName} {active[0].progress.spent > active[0].goal.limit ? '목표 금액 초과' : `${active[0].progress.remaining.toLocaleString('ko-KR')}원 남음`}</p>}
    {review.length > 0 && <p className="mission-live">끝난 도전 {review.length}개 · 지출 기록 확인이 필요해요</p>}
    <button className="button primary wide" onClick={open}>{ready > 0 || review.length > 0 ? '미션 결과 확인하기 →' : active.length || pending.length ? '진행 중인 미션 보기 →' : '절약 미션 시작하기 →'}</button>
  </section>;
}
