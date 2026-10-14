import { useState } from 'react';
import type { AppState, Config } from '../shared/types';
import { categoryArt } from '../shared/categories';
import { inCycle, salaryCycle } from '../shared/domain';
import { applyRegularPreset, categoryBudget, isRegular, regularPreset } from '../shared/regular-expenses';
const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;

export function RegularPreset({ config, onChange }: { config: Config; onChange: (next: Config) => void }) {
  const [error, setError] = useState('');
  const configured = regularPreset.every(preset => config.categories.some(category => category.name === preset.name && isRegular(category)));
  return <div className="regular-preset">
    <details><summary>정기지출 6개 · 예상 752,000원</summary><ul>{regularPreset.map(category => <li key={category.id}>{category.name} · {money(category.budget)}</li>)}</ul></details>
    <p>반올림한 예상 금액으로 시작하고, 실제 납부액은 지출 기록에서 입력해요. 불러오면 기존 정기 총액을 항목별 예산으로 바꾸고 차액은 비정기 예산에 반영해요.</p>
    <button type="button" className="button wide" disabled={configured} onClick={() => { try { onChange(applyRegularPreset(config)); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '정기지출 항목을 확인해 주세요.'); } }}>{configured ? '정기지출 6개가 준비됐어요' : '정기지출 6개 불러오기'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="fine-print">기타 예산에서 차액을 먼저 맞추고, 부족하면 비정기 항목 비율대로 조정해요. 아래 저장 버튼을 눌러야 내 계정에 반영돼요.</p>
  </div>;
}
export default function RegularExpenses({ state, onRecord, onPay, compact = false }: { state: AppState; onRecord?: (category: string) => void; onPay?: (category: string) => void; compact?: boolean }) {
  const categories = state.config.categories.filter(isRegular), cycle = salaryCycle(new Date(), state.config.salary.cycleStartDay);
  const ids = new Set(categories.map(category => category.id));
  const records = state.expenses.filter(expense => ids.has(expense.category) && inCycle(expense.date, cycle));
  const spent = records.reduce((sum, expense) => sum + expense.amount, 0);
  const budget = state.config.allocation.fixedExpenses, unassigned = budget - categoryBudget(categories, 'regular');
  return <section className="card regular-expenses" aria-label="정기지출 현황">
    <div className="section-heading"><h2>정기지출</h2><a className="text-button" href="#settings">항목 관리 ↗</a></div>
    <p className="fine-print">급여 주기 {cycle.label} · 월 예상 예산이에요. 실제 납부한 금액만 기록해요.</p>
    <div className="budget-details"><span>예산 <strong>{money(budget)}</strong></span><span>실제 사용 <strong>{money(spent)}</strong></span></div>
    <p className={spent > budget ? 'form-error' : 'inline-note'}>{money(Math.abs(budget - spent))} {spent > budget ? '예산 초과' : '예산 남음'} · {records.length}건 기록</p>
    <details className="regular-details" open={compact ? undefined : true}><summary>정기 항목 보기 · {categories.length}개</summary>
    {categories.map(category => {
      const actual = records.filter(expense => expense.category === category.id).reduce((sum, expense) => sum + expense.amount, 0), remaining = category.budget - actual;
      return <div className="category-row" key={category.id}><span className="category-icon category-art" style={{ backgroundColor: categoryArt(category).color }}>{categoryArt(category).symbol}</span><div className="category-main"><div><strong>{category.name}</strong><span>{money(Math.abs(remaining))} {remaining < 0 ? '초과' : '남음'}</span></div><small className="category-spent">실제 {money(actual)} / 예상 {money(category.budget)}</small>{onPay && <button className="text-button quick-pay" aria-label={`${category.name} 납부 기록`} onClick={() => onPay(category.id)}>납부 기록 ＋</button>}</div></div>;
    })}
    {unassigned > 0 && <p className="inline-note">아직 나누지 않은 정기 예산 {money(unassigned)} · 항목 관리에서 세부 항목을 추가해 주세요.</p>}
    {onRecord && categories.length > 0 && <button className="button wide" onClick={() => onRecord(categories[0].id)}>＋ 정기지출 기록하기</button>}
    </details><p className="fine-print">{state.bridgeBudget?.cashScope === 'shared' ? '같은 돈에서 납부하도록 설정한 기간에는 정기 납부액과 남겨둘 돈을 함께 계산해요.' : '정기지출은 별도 예산이에요. 같은 돈에서 낸다면 쓸 수 있는 돈 설정을 바꿔 주세요.'}</p>
  </section>;
}
