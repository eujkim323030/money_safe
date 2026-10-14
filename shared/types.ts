export type CategoryId = string;
export interface Category { id: CategoryId; name: string; budget: number; icon?: string }
export interface Config {
  app: { name: string; locale: string; timezone: string; currency: string; theme: string };
  salary: { monthlyAmount: number; payday: number; cycleStartDay: number };
  allocation: {
    savings: { youth: number; nonghyup: number; travel: number };
    loanPayments: { otherLoan: number; bossLoanRegular: number; bossLoanExtra: number };
    fixedExpenses: number; emergencyContribution: number; bigPurchaseContribution: number; variableBudget: number;
  };
  categories: Category[];
  bossLoan: { initialBalance: number; currentBalance: number; annualInterestRate: number; regularPayment: number; extraPrincipalGoal: number; prepaymentFeeRate: number; repaymentType: string };
  goals: { emergencyFund: { balance: number; target: number; monthlyContribution: number }; bigPurchaseFund: { balance: number | null; monthlyContribution: number } };
  push: PushPreferences;
}
export interface PushPreferences {
  enabled: boolean;
  payday: { day: number; hour: number; minute?: number };
  weeklyReview: { dayOfWeek: number; hour: number; minute?: number };
  cycleEnd: { day: number; hour: number; minute?: number };
  budgetThreshold: number; inactivityDays: number; inactivityHour?: number;
}
export interface Expense { id: string; amount: number; date: string; category: CategoryId; note: string; emotion: string; createdAt: string }
export interface Repayment { id: string; loan: 'boss' | 'other'; date: string; total: number; principal: number | null; interest: number | null; note: string }
export interface FundEntry { id: string; fund: 'emergency' | 'bigPurchase'; kind: 'deposit' | 'withdraw' | 'adjust'; amount: number; date: string; note: string }
export interface MissionCompletion { id: string; key: string; period: string; completedAt: string }
export interface SpendingGoal { id: string; categoryId: string | null; categoryName: string; startDate: string; endDate: string; limit: number; createdAt: string; excludedExpenseIds?: string[] }
export interface PurchasePause { id: string; name: string; amount: number; createdAt: string; resolution?: 'skipped' | 'bought'; resolvedAt?: string }
export interface SpendingReview { date: string; reviewedAt: string }
export interface AppState {
  config: Config; expenses: Expense[]; repayments: Repayment[]; fundEntries: FundEntry[]; missions: MissionCompletion[];
  preferences: { effects: boolean; sound: boolean; nagIntensity: 'gentle' | 'normal' | 'firm' };
  spendingGoals?: SpendingGoal[];
  purchasePauses?: PurchasePause[];
  spendingReviews?: SpendingReview[];
  bridgeBudget?: { id: string; amount: number; startDate: string; endDate: string; excludedExpenseIds: string[] };
}
export interface User { id: string; email: string }
export interface StateResponse { state: AppState; revision: number }
export interface PushStatus { configured: boolean; publicKey: string | null; subscribed: boolean; deviceCount: number }
export interface NotificationPayload { title: string; body: string; url: string; tag: string }
