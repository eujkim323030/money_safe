import { expect, test, type Page } from '@playwright/test';
const headers = { 'X-Requested-With': 'salary-guardians' };
const password = 'Test-password-2026';
async function startAccount(page: Page) {
  const email = `guardian-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.request.post('/api/auth/register', { headers, data: { email, password } });
  await page.goto('/');
  await expect(page.locator('.budget-card .big-number')).toHaveText('1,368,000원');
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  return email;
}
async function go(page: Page, route: string) {
  await page.evaluate(route => { location.hash = route; }, route);
  await expect(page).toHaveURL(new RegExp(`#${route}$`));
}
async function addExpense(page: Page, amount: number, note = '') {
  await page.getByRole('button', { name: '＋ 지출 기록', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: '지출 금액' }).fill(String(amount));
  if (note) await dialog.locator('input[name=note]').fill(note);
  await dialog.getByRole('button', { name: '기록 완료하기 ♡' }).click();
  await expect(dialog).not.toBeVisible();
}

test('Korean signup and mobile pixel home show only true starter balances with no horizontal overflow', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('이메일', { exact: true }).fill(`signup-${Date.now()}@example.test`);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '내 수비대 시작하기 →' }).click();
  await expect(page.locator('.budget-card .big-number')).toHaveText('1,368,000원');
  await expect(page.locator('.budget-card')).toContainText('기록한 지출 0원');
  await expect(page.locator('.status-grid')).toContainText('5,000,000원');
  await expect(page.locator('.status-grid')).toContainText('잔액 확인이 필요해요');
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('expense add/edit/delete updates the persisted budget immediately and prevents duplicate records', async ({ page }) => {
  await startAccount(page); await go(page, 'expenses');
  await addExpense(page, 12000, '점심 한 끼');
  await expect(page.locator('.record-row')).toHaveCount(1);
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  await page.getByRole('button', { name: /12000원 지출 수정/ }).click();
  await page.getByRole('spinbutton', { name: '지출 금액' }).fill('15000');
  await page.getByRole('button', { name: '수정 저장하기 ♡' }).click();
  await expect(page.locator('.record-row')).toContainText('15,000원');
  await go(page, 'home');
  await expect(page.locator('.budget-card .big-number')).toHaveText('1,353,000원');
  await go(page, 'expenses'); page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: /15000원 지출 삭제/ }).click();
  await expect(page.locator('.record-row')).toHaveCount(0);
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  const response = await page.request.get('/api/state');
  expect((await response.json()).state.expenses).toHaveLength(0);
});
test('actual principal/interest repayment and fund ledgers affect their balances without double-counting expenses', async ({ page }) => {
  await startAccount(page); await go(page, 'loan');
  await page.getByRole('button', { name: '⚔ 실제 상환 내역 기록하기' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('실제 납부한 총액').fill('330000');
  await dialog.getByLabel('그중 실제 원금 상환액').fill('296667');
  await dialog.getByLabel('그중 실제 이자 납부액').fill('33333');
  await dialog.getByRole('button', { name: '상환 기록 저장하기' }).click();
  await expect(page.locator('.boss-health')).toContainText('4,703,333원');
  await expect(page.locator('.simulation')).toContainText('가정');
  await go(page, 'savings');
  await page.locator('.emergency').getByRole('button', { name: '＋ 적립 · 인출 · 잔액 조정' }).click();
  await page.getByRole('dialog').getByLabel('실제로 적립한 금액').fill('100000');
  await page.getByRole('button', { name: '창고 기록 저장하기' }).click();
  await expect(page.locator('.emergency .big-number')).toHaveText('5,100,000원');
  await expect(page.locator('.big-purchase')).toContainText('현재 잔액 미확인');
  await page.locator('.big-purchase').getByRole('button', { name: '＋ 적립 · 인출 · 잔액 조정' }).click();
  await page.getByRole('dialog').getByLabel('계좌에서 확인한 실제 잔액').fill('200000');
  await page.getByRole('button', { name: '창고 기록 저장하기' }).click();
  await expect(page.locator('.big-purchase .big-number')).toHaveText('200,000원');
  await page.locator('.emergency').getByRole('button', { name: '＋ 적립 · 인출 · 잔액 조정' }).click();
  await page.getByRole('dialog').getByLabel('기록 종류').selectOption('withdraw');
  await page.getByRole('dialog').getByLabel('실제로 인출한 금액').fill('50000');
  await page.getByRole('button', { name: '창고 기록 저장하기' }).click();
  await expect(page.locator('.emergency .big-number')).toHaveText('5,050,000원');
  await go(page, 'home'); await expect(page.locator('.budget-card .big-number')).toHaveText('1,368,000원');
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
});
test('missions completion/cancellation uses evidence and XP and settings export returns this user only', async ({ page }) => {
  await startAccount(page); await go(page, 'missions');
  await expect(page.getByRole('button', { name: '비상금 적립 확인 완료', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '월급 분배 확인 완료', exact: true }).click();
  await expect(page.locator('.level-card')).toContainText('30 XP');
  await page.getByRole('button', { name: '월급 분배 확인 완료 취소', exact: true }).click();
  await expect(page.locator('.level-card')).toContainText('0 XP');
  await go(page, 'settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ 내 기록 JSON 내보내기' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('월급수비대');
  const exported = await page.request.get('/api/export');
  expect((await exported.json()).state.expenses).toEqual([]);
});
test('PWA installs its real service worker, caches shell offline and resynchronizes queued expense', async ({ page, context }) => {
  await startAccount(page); await go(page, 'expenses');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const manifest = await page.request.get('/manifest.webmanifest');
  expect((await manifest.json()).display).toBe('standalone');
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('button', { name: '＋ 지출 기록', exact: true })).toBeVisible();
  await addExpense(page, 8000, '오프라인 기록');
  await expect(page.locator('.record-row')).toHaveCount(1);
  await expect(page.locator('.sync-badge')).toContainText('기기 저장됨');
  await context.setOffline(false);
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  const response = await page.request.get('/api/state');
  expect((await response.json()).state.expenses[0].amount).toBe(8000);
});
test('two rapid edits merge server timestamps rather than leaving a blocked synchronization queue', async ({ page }) => {
  await startAccount(page); await go(page, 'expenses');
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await addExpense(page, 2000); await addExpense(page, 3000);
  release();
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  const response = await page.request.get('/api/state');
  expect((await response.json()).state.expenses).toHaveLength(2);
  await expect(page.locator('.notice.warning')).toHaveCount(0);
});
test('edited payday and notification times persist and budget inconsistencies are rejected visibly', async ({ page }) => {
  await startAccount(page); await go(page, 'settings');
  const budgetSettings = page.locator('details').filter({ has: page.locator('summary', { hasText: '월급' }) }).first();
  if ((await budgetSettings.getAttribute('open')) === null) await budgetSettings.locator('summary').click();
  await page.getByLabel('월급일 / 주기 시작일').fill('10');
  const notificationSettings = page.locator('details').filter({ has: page.locator('summary', { hasText: '서버 알림 시간' }) });
  await notificationSettings.locator('summary').click();
  await page.getByLabel('월급일 분배 알림').fill('08:30');
  await page.getByRole('button', { name: '예산 · 목표 · 알림 시간 저장하기' }).click();
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  const result = await (await page.request.get('/api/state')).json();
  expect(result.state.config.salary.payday).toBe(10);
  expect(result.state.config.salary.cycleStartDay).toBe(10);
  expect(result.state.config.push.payday).toMatchObject({ day: 10, hour: 8, minute: 30 });
  expect(result.state.config.push.cycleEnd.day).toBe(9);
  await page.getByLabel('월급 (실수령액)').fill('4000000');
  await page.getByRole('button', { name: '예산 · 목표 · 알림 시간 저장하기' }).click();
  await expect(page.getByRole('alert')).toContainText('배분 합계');
  expect((await (await page.request.get('/api/state')).json()).state.config.salary.monthlyAmount).toBe(3650000);
});
test('push permission is requested only after a click and a denial is explained without saving a subscription', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__permissionRequests = 0;
    Object.defineProperty(Notification, 'requestPermission', { value: () => { (window as any).__permissionRequests++; return Promise.resolve('denied'); }, configurable: true });
  });
  await startAccount(page); await go(page, 'settings');
  await page.getByText('🔔 알림 · 아이폰 설치', { exact: true }).click();
  await expect(page.locator('.push-status')).toContainText('설정됨');
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(0);
  await page.getByRole('button', { name: '이 기기 알림 켜기' }).click();
  await expect(page.locator('.push-message')).toContainText('권한이 거부');
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(1);
  expect((await (await page.request.get('/api/push/status')).json()).deviceCount).toBe(0);
});
test('a changed server revision produces an explicit conflict with local export and confirmed reload', async ({ page }) => {
  await startAccount(page); await go(page, 'expenses');
  const remote = await (await page.request.get('/api/state')).json();
  remote.state.preferences.effects = false;
  expect((await page.request.put('/api/state', { headers, data: remote })).ok()).toBe(true);
  await addExpense(page, 9000, '충돌 시 기기 기록 보존');
  await expect(page.locator('.notice.warning')).toContainText('다른 기기');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '기기 기록 내보내기' }).click();
  expect((await download).suggestedFilename()).toContain('기기기록');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '서버 기록 불러오기' }).click();
  await expect(page.locator('.record-row')).toHaveCount(0);
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
});
test('logging out with an in-flight offline queue cannot recreate its cache or write it into the next account', async ({ page }) => {
  await startAccount(page); await go(page, 'expenses');
  const firstUser = (await (await page.request.get('/api/auth/me')).json()).user;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => { /* Logout deliberately aborts this request. */ });
  });
  await addExpense(page, 17000); await addExpense(page, 18000);
  await go(page, 'settings');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '내 수비대 시작하기 →' })).toBeVisible();
  expect(await page.evaluate(id => localStorage.getItem(`salary-guardians:state:${id}`), firstUser.id)).toBeNull();
  await startAccount(page);
  release();
  await expect(page.locator('.budget-card .big-number')).toHaveText('1,368,000원');
  const other = await (await page.request.get('/api/state')).json();
  expect(other.state.expenses).toEqual([]);
  expect(await page.evaluate(id => localStorage.getItem(`salary-guardians:state:${id}`), firstUser.id)).toBeNull();
});

test('purpose menus and custom category editing preserve old records and sync new category expenses', async ({ page }) => {
  await startAccount(page);
  const menu = page.getByRole('navigation', { name: '주 메뉴', exact: true });
  await expect(menu.getByRole('button')).toHaveCount(4);
  await menu.getByRole('button', { name: '기록', exact: true }).click();
  await addExpense(page, 1200, '기존 기록');
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  await page.getByRole('button', { name: '카테고리 관리' }).click();
  await expect(page.getByLabel('카테고리 1 이름', { exact: true })).toBeVisible();
  await page.getByLabel('카테고리 1 이름', { exact: true }).fill('집밥·외식');
  await page.getByRole('button', { name: /카테고리 추가/ }).click();
  await page.getByRole('button', { name: '교통', exact: true }).click();
  await page.getByLabel('카테고리 7 이름', { exact: true }).fill('교통비');
  await page.getByLabel('카테고리 7 예산', { exact: true }).fill('10000');
  await page.getByRole('button', { name: '예산 · 목표 · 알림 시간 저장하기' }).click();
  await expect(page.getByRole('alert')).toContainText('카테고리 합계');
  const firstBudget = page.getByLabel('카테고리 1 예산', { exact: true });
  await firstBudget.fill(String(Number(await firstBudget.inputValue()) - 10000));
  await page.getByRole('button', { name: '예산 · 목표 · 알림 시간 저장하기' }).click();
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  await page.reload();
  await expect(page.getByLabel('카테고리 7 이름', { exact: true })).toHaveValue('교통비');
  await expect(page.getByRole('button', { name: '교통비 아이콘 선택' })).toHaveText('🚇');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/category-editor.png', fullPage: true });
  await menu.getByRole('button', { name: '기록', exact: true }).click();
  await expect(page.locator('.record-row')).toContainText('집밥·외식');
  await page.getByRole('button', { name: '＋ 지출 기록', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '🚇 교통비', exact: true }).click();
  await page.getByRole('spinbutton', { name: '지출 금액' }).fill('1500');
  await page.getByRole('button', { name: '기록 완료하기 ♡' }).click();
  await expect(page.locator('.sync-badge')).toContainText('동기화됨');
  const saved = await (await page.request.get('/api/state')).json();
  expect(saved.state.expenses[0].category).toBe('food');
  expect(saved.state.expenses[1].category).toBe(saved.state.config.categories[6].id);
  expect(saved.state.config.categories[6].icon).toBe('transport');
  await page.getByRole('navigation', { name: '기록 메뉴' }).getByRole('button', { name: '소비 통계' }).click();
  await expect(page.locator('.category-stats')).toContainText('교통비');
  await menu.getByRole('button', { name: '목표', exact: true }).click();
  const goals = page.getByRole('navigation', { name: '목표 메뉴' });
  await goals.getByRole('button', { name: '대출 상환' }).click();
  await expect(page).toHaveURL(/#loan$/);
  await expect(menu.getByRole('button', { name: '목표', exact: true })).toHaveAttribute('aria-current', 'page');
  await goals.getByRole('button', { name: '실천 미션' }).click();
  await expect(page).toHaveURL(/#missions$/);
});
