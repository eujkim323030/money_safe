import type { Category, Config } from './types';
import { MAX_CATEGORIES } from './categories';

export const isRegular = (category?: Category) => category?.kind === 'regular';
export const categoryBudget = (categories: Category[], kind: 'regular' | 'variable') => categories.filter(category => isRegular(category) === (kind === 'regular')).reduce((sum, category) => sum + category.budget, 0);
export const regularPreset: Category[] = [
  { id: 'regular_finance', name: '보험, 세금, 기타금융', budget: 150000, icon: 'health', kind: 'regular' },
  { id: 'regular_chicken', name: '닭계', budget: 150000, icon: 'gift', kind: 'regular' },
  { id: 'regular_transport', name: '교통비', budget: 300000, icon: 'transport', kind: 'regular' },
  { id: 'regular_phone', name: '통신비', budget: 57000, icon: 'subscription', kind: 'regular' },
  { id: 'regular_donation', name: '기부금', budget: 30000, icon: 'gift', kind: 'regular' },
  { id: 'regular_subscription', name: '정기 결제', budget: 65000, icon: 'subscription', kind: 'regular' },
];
// A classification change moves its planned budget, never creates a paid expense.
export function changeCategories(config: Config, categories: Category[]): Config {
  const oldRegular = categoryBudget(config.categories, 'regular');
  const difference = categoryBudget(categories, 'regular') - oldRegular;
  const transferring = config.categories.some(old => { const next = categories.find(category => category.id === old.id); return !next || isRegular(old) !== isRegular(next); });
  const reserve = Math.max(0, config.allocation.fixedExpenses - oldRegular);
  const delta = difference - (!transferring && difference > 0 ? Math.min(reserve, difference) : 0);
  return { ...config, categories, allocation: { ...config.allocation, fixedExpenses: config.allocation.fixedExpenses + delta, variableBudget: config.allocation.variableBudget - delta } };
}
export function applyRegularPreset(config: Config): Config {
  const next = structuredClone(config);
  for (const preset of regularPreset) {
    const existing = next.categories.find(category => category.id === preset.id || category.name.trim() === preset.name);
    if (existing) Object.assign(existing, { ...preset, id: existing.id });
    else next.categories.push({ ...preset });
  }
  if (next.categories.length > MAX_CATEGORIES) throw new Error(`정기지출을 추가하면 ${MAX_CATEGORIES}개를 넘어요. 사용하지 않는 카테고리를 먼저 정리해 주세요.`);
  const regular = categoryBudget(next.categories, 'regular');
  const variable = config.allocation.fixedExpenses + config.allocation.variableBudget - regular;
  if (variable < 0) throw new Error('정기지출 예산이 전체 소비 예산보다 커요. 월급 분배를 먼저 확인해 주세요.');
  const others = next.categories.filter(category => !isRegular(category));
  if (!others.length) throw new Error('비정기 생활비 카테고리를 한 개 이상 남겨 주세요.');
  const total = categoryBudget(others, 'variable');
  const difference = variable - total;
  const remainder = others.find(category => category.id === 'other');
  // Keep familiar category budgets when the difference fits in the miscellaneous envelope.
  if (remainder && remainder.budget + difference >= 0) remainder.budget += difference;
  else {
    let allocated = 0;
    others.forEach((category, index) => {
      const amount = index === others.length - 1 ? variable - allocated : Math.floor(total ? category.budget / total * variable : variable / others.length);
      category.budget = amount; allocated += amount;
    });
  }
  next.allocation.fixedExpenses = regular; next.allocation.variableBudget = variable;
  return next;
}
