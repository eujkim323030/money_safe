import { isRegular } from './regular-expenses';
import { kstDate, activeBudget, budgetCategories, budgetExpenses } from './domain';
import type { AppState, SpendingGoal } from './types';

const DAY = 86_400_000;
export function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}
export function goalDates(goal: SpendingGoal): string[] {
  const dates: string[] = [];
  for (let date = goal.startDate; date <= goal.endDate && dates.length < 7; date = addDays(date, 1)) dates.push(date);
  return dates;
}
export function spendingGoalProgress(state: AppState, goal: SpendingGoal, now = new Date()) {
  const today = kstDate(now);
  const excluded = new Set(goal.excludedExpenseIds ?? []);
  const spent = state.expenses.filter(expense => !isRegular(state.config.categories.find(category => category.id === expense.category)) && !excluded.has(expense.id) && expense.date >= goal.startDate && expense.date <= goal.endDate && (goal.categoryId === null || expense.category === goal.categoryId)).reduce((sum, expense) => sum + expense.amount, 0);
  const dates = goalDates(goal);
  const reviewed = new Set((state.spendingReviews ?? []).map(review => review.date));
  const missingDates = dates.filter(date => !reviewed.has(date));
  const available = goal.categoryId === null || state.config.categories.some(category => category.id === goal.categoryId && !isRegular(category));
  const ended = today > goal.endDate;
  const complete = available && ended && missingDates.length === 0 && spent <= goal.limit;
  const remaining = Math.max(0, goal.limit - spent);
  const daysLeft = dates.filter(date => date >= today).length;
  return { spent, remaining, daysLeft, missingDates, available, ended, complete, dailyGuide: daysLeft ? Math.floor(remaining / daysLeft) : 0 };
}
export function suggestedGoalLimit(state: AppState, categoryId: string | null, days: number, now = new Date()): number {
  const cycle = activeBudget(state, now);
  const today = kstDate(now);
  const budget = categoryId === null ? cycle.budget : budgetCategories(state, now).find(category => category.id === categoryId)?.budget ?? 0;
  const spent = budgetExpenses(state, cycle).filter(expense => expense.date >= cycle.start && expense.date <= today && (categoryId === null || expense.category === categoryId)).reduce((sum, expense) => sum + expense.amount, 0);
  const daysRemaining = Math.round((Date.parse(cycle.end) - Date.parse(today)) / DAY) + 1;
  return Math.floor(Math.max(0, budget - spent) / daysRemaining * Math.min(days, daysRemaining) * 0.9);
}
export function savingMissionXP(state: AppState, now = new Date()): number {
  return (state.spendingGoals ?? []).filter(goal => spendingGoalProgress(state, goal, now).complete).length * 40
    + (state.purchasePauses ?? []).filter(pause => pause.resolution === 'skipped' && pause.resolvedAt && Date.parse(pause.resolvedAt) - Date.parse(pause.createdAt) >= DAY).length * 20;
}
