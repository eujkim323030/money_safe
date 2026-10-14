import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COOKIE = 'salary_guardians';
const messages = {
  cpu_limit: 'Cloudflare 1102: 무료 Worker의 CPU 제한을 초과했습니다. 인증 작업의 실제 CPU 사용량과 무료 배포 구성을 확인해야 합니다.',
  missing_session_secret: '서버 SESSION_SECRET 설정이 없어 회원가입을 처리할 수 없습니다. 대시보드 배포 초기화를 확인해 주세요.',
  missing_push: '서버 푸시 설정이 준비되지 않았습니다. VAPID 키와 암호화 키 설정을 확인해 주세요.',
  server_error: '서버가 요청을 처리하지 못했습니다. D1 마이그레이션·바인딩과 배포 로그를 확인해 주세요.',
  worker_exception: 'Cloudflare Worker 실행 오류입니다. 배포 로그와 서버 설정을 확인해 주세요.',
  network: '공개 HTTPS 앱에 연결하지 못했습니다. 공개 주소와 실행 환경의 네트워크 접근을 확인해 주세요.',
  http_error: '앱이 예상 HTTP 상태를 반환하지 않았습니다.',
  origin_mismatch: '서버 PUBLIC_ORIGIN과 공개 HTTPS 주소가 일치하지 않습니다. 기존 주소 설정을 확인해 주세요.',
  invalid_response: '앱 응답의 형식이나 필수 필드가 예상과 다릅니다.',
  invalid_url: '스모크 검증에는 사용자 정보·쿼리가 없는 공개 HTTPS 주소가 필요합니다.',
  cleanup_failed: '새로 만든 임시 검증 계정을 삭제하지 못했습니다. 보고서의 임시 이메일로 정리가 필요합니다.',
};
class SmokeError extends Error {
  constructor(kind, httpStatus) { super(messages[kind]); this.kind = kind; this.httpStatus = httpStatus; }
}
const ensure = (condition, kind = 'invalid_response', status) => { if (!condition) throw new SmokeError(kind, status); };
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));

/** Exercise only a newly generated account. Responses, credentials and cookies never enter logs/reports. */
export async function runPublicSmoke(options = {}) {
  const startedAt = new Date().toISOString();
  const report = { url: null, startedAt, finishedAt: null, success: false, assertions: [], testAccountCleanup: true };
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? console.log;
  const reportPath = options.reportPath ?? '.smoke-public-results.json';
  const email = `smoke-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString('base64url');
  let base, cookie = '', accountPossible = false;
  const failure = (error, status) => {
    const safe = error instanceof SmokeError ? error : new SmokeError('network', status);
    return { kind: safe.kind, message: safe.message, ...(safe.httpStatus !== undefined ? { httpStatus: safe.httpStatus } : {}) };
  };
  const rememberCookie = response => {
    const values = response.headers.getSetCookie?.() ?? [response.headers.get('Set-Cookie') ?? ''];
    const value = values.find(value => value.startsWith(`${COOKIE}=`));
    if (value !== undefined) cookie = value.split(';')[0];
    return value;
  };
  const get = async (path, body, method = body === undefined ? 'GET' : 'POST', expected = 200, cookieOverride) => {
    let response;
    try {
      response = await fetcher(new URL(path, base).href, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Origin: base, 'X-Requested-With': 'salary-guardians',
          ...((cookieOverride ?? cookie) ? { Cookie: cookieOverride ?? cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new SmokeError('network'); }
    rememberCookie(response);
    const type = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (path.endsWith('.png') && response.status === expected) return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
    const text = await response.text();
    const errorText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    if (/\b(?:error(?:\s+code\s*:?)?\s*1102|workers? exceeded resource limits)\b/i.test(errorText)) throw new SmokeError('cpu_limit', response.status);
    if (/\berror(?:\s+code\s*:?)?\s*1101\b/i.test(errorText)) throw new SmokeError('worker_exception', response.status);
    let data;
    if (type.includes('json')) { try { data = JSON.parse(text); } catch { throw new SmokeError('invalid_response', response.status); } }
    if (response.status !== expected) {
      if (response.status === 503 && data?.error === '서버 세션 비밀키 설정이 필요합니다.') throw new SmokeError('missing_session_secret', 503);
      if (response.status === 403 && data?.error === '허용되지 않은 출처입니다.') throw new SmokeError('origin_mismatch', 403);
      throw new SmokeError(response.status >= 500 ? 'server_error' : 'http_error', response.status);
    }
    return { response, data, text, type };
  };
  const check = async (name, operation) => {
    try {
      const result = await operation();
      report.assertions.push({ name, status: 'passed', ...(result?.response ? { httpStatus: result.response.status } : {}) });
      log(`PASS ${name}`);
      return result;
    } catch (error) {
      const safe = failure(error);
      report.assertions.push({ name, status: 'failed', ...(safe.httpStatus !== undefined ? { httpStatus: safe.httpStatus } : {}) });
      throw error;
    }
  };
  try {
    let url;
    try { url = new URL(options.baseUrl); } catch { throw new SmokeError('invalid_url'); }
    const local = options.allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    ensure((url.protocol === 'https:' || local) && !url.username && !url.password && !url.search && !url.hash, 'invalid_url');
    base = url.origin; report.url = base;
    await check('health', async () => {
      let last;
      const attempts = Math.max(1, Math.min(6, options.healthAttempts ?? 6));
      for (let attempt = 0; attempt < attempts; attempt++) {
        try { const value = await get('/api/health'); ensure(value.data?.ok === true); return value; }
        catch (error) {
          last = error;
          if (error instanceof SmokeError && !['network', 'server_error', 'http_error'].includes(error.kind)) break;
          if (attempt + 1 < attempts) await wait(options.pollDelayMs ?? 5_000);
        }
      }
      throw last;
    });
    await check('manifest', async () => {
      const value = await get('/manifest.webmanifest');
      ensure(value.type.includes('json') && value.data?.name === '월급수비대' && value.data.display === 'standalone' && value.data.scope === '/');
      ensure(new URL(value.data.start_url, base).origin === base && Array.isArray(value.data.icons));
      ensure(['192x192', '512x512'].every(size => value.data.icons.some(icon => icon.sizes === size && icon.type === 'image/png')));
      return value;
    });
    await check('service_worker', async () => {
      const value = await get('/sw.js');
      ensure(value.type.includes('javascript') && /addEventListener\(\s*['"]push['"]/.test(value.text) && /addEventListener\(\s*['"]notificationclick['"]/.test(value.text) && value.text.includes('showNotification'));
      return value;
    });
    for (const [path, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
      await check(`icon_${size}_${path.startsWith('maskable') ? 'maskable' : path.startsWith('apple') ? 'apple' : 'app'}`, async () => {
        const value = await get(`/icons/${path}`);
        ensure(value.response.headers.get('Content-Type')?.startsWith('image/png') && value.bytes.length >= 24);
        ensure(Buffer.from(value.bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
        const dimensions = new DataView(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength);
        ensure(dimensions.getUint32(16) === size && dimensions.getUint32(20) === size); return value;
      });
    }
    const registered = await check('register_and_secure_cookie', async () => {
      accountPossible = true;
      try {
        const value = await get('/api/auth/register', { email, password }, 'POST', 201);
        const setCookie = value.response.headers.getSetCookie?.().find(value => value.startsWith(`${COOKIE}=`)) ?? value.response.headers.get('Set-Cookie') ?? '';
        ensure(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`).test(setCookie) && /;\s*HttpOnly(?:;|$)/i.test(setCookie) && /;\s*Secure(?:;|$)/i.test(setCookie));
        ensure(typeof value.data?.user?.id === 'string' && value.data.user.email === email); return value;
      } catch (error) {
        if (error instanceof SmokeError && ((error.httpStatus >= 400 && error.httpStatus < 500) || error.kind === 'missing_session_secret')) accountPossible = false;
        throw error;
      }
    });
    const user = registered.data.user;
    await check('authenticated_identity', async () => { const value = await get('/api/auth/me'); ensure(value.data?.user?.id === user.id); return value; });
    const initial = await check('starter_state', async () => {
      const value = await get('/api/state'); const state = value.data?.state;
      const starter = JSON.parse(await readFile(new URL('../shared/starter-config.json', import.meta.url), 'utf8'));
      ensure(Number.isSafeInteger(value.data?.revision) && value.data.revision >= 0 && state);
      ensure(state.config.salary.monthlyAmount === starter.salary.monthlyAmount && state.config.allocation.variableBudget === starter.allocation.variableBudget);
      ensure(state.config.bossLoan.currentBalance === starter.bossLoan.currentBalance && state.config.goals.emergencyFund.balance === starter.goals.emergencyFund.balance && state.config.goals.bigPurchaseFund.balance === null);
      ensure(['expenses', 'repayments', 'fundEntries', 'missions'].every(key => Array.isArray(state[key]) && state[key].length === 0)); return value;
    });
    const state = initial.data.state;
    const expenseId = randomUUID();
    const categoryId = `custom_${randomUUID()}`;
    state.config.categories[0].name = '집밥·외식';
    state.config.categories.push({ id: categoryId, name: '교통비', budget: 0, icon: 'transport' });
    state.expenses.push({ id: expenseId, amount: 1000, date: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10), category: categoryId, note: '자동 검증용 임시 기록', emotion: '', createdAt: new Date().toISOString() });
    const missionNow = new Date(), missionDate = new Date(missionNow.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const plusDays = count => new Date(Date.parse(missionDate) + count * 86_400_000).toISOString().slice(0, 10);
    state.config.categories.push({ id: 'regular_smoke', name: '정기 교통', budget: 0, icon: 'transport', kind: 'regular' });
    state.expenses.push({ id: randomUUID(), category: 'regular_smoke', amount: 1234, date: missionDate, note: '자동 검증용 정기지출', emotion: '', createdAt: missionNow.toISOString() });
    state.bridgeBudget = { id: randomUUID(), amount: 550000, cashScope: 'shared', regularReserve: 57000, startDate: missionDate, endDate: plusDays(10), excludedExpenseIds: [] };
    state.spendingGoals = [{ id: randomUUID(), categoryId, categoryName: '교통비', startDate: missionDate, endDate: plusDays(2), limit: 5000, createdAt: missionNow.toISOString(), excludedExpenseIds: [] }];
    state.purchasePauses = [{ id: randomUUID(), name: '자동 검증용 구매 보류', amount: 50000, createdAt: missionNow.toISOString() }];
    state.fundEntries = [{ id: randomUUID(), fund: 'youth', kind: 'adjust', amount: 2000000, date: missionDate, note: '자동 검증용 잔액' }, { id: randomUUID(), fund: 'nonghyup', kind: 'adjust', amount: 2700000, date: missionDate, note: '자동 검증용 잔액' }, { id: randomUUID(), fund: 'travel', kind: 'adjust', amount: 0, date: missionDate, note: '자동 검증용 잔액' }, { id: randomUUID(), fund: 'youth', kind: 'deposit', amount: 500000, date: missionDate, note: '자동 검증용 적립' }];
    const saved = await check('state_cas_write', async () => {
      const value = await get('/api/state', { userId: user.id, state, revision: initial.data.revision }, 'PUT');
      ensure(value.data?.revision === initial.data.revision + 1 && value.data?.state?.expenses?.some(expense => expense.id === expenseId && expense.amount === 1000)); return value;
    });
    await check('custom_category_and_icon', async () => {
      const value = await get('/api/state');
      ensure(value.data?.state?.config?.categories?.some(category => category.id === categoryId && category.name === '교통비' && category.icon === 'transport'));
      ensure(value.data.state.config.categories[0].name === '집밥·외식' && value.data.state.expenses.some(expense => expense.id === expenseId && expense.category === categoryId));
      return value;
    });
    await check('bridge_budget_and_spending_missions', async () => {
      const value = await get('/api/state');
      ensure(value.data?.state?.bridgeBudget?.amount === 550000 && value.data.state.bridgeBudget.cashScope === 'shared' && value.data.state.bridgeBudget.regularReserve === 57000 && value.data.state.bridgeBudget.endDate === plusDays(10));
      ensure(value.data.state.spendingGoals?.[0]?.limit === 5000 && value.data.state.purchasePauses?.[0]?.amount === 50000 && value.data.state.purchasePauses[0].resolution === undefined);
      ensure(JSON.stringify(value.data.state.fundEntries) === JSON.stringify(state.fundEntries) && value.data.state.config.allocation.variableBudget === initial.data.state.config.allocation.variableBudget);
      return value;
    });
    await check('regular_expense_classification', async () => { const value = await get('/api/state'); ensure(value.data.state.config.categories.some(category => category.id === 'regular_smoke' && category.kind === 'regular')); ensure(value.data.state.expenses.some(expense => expense.category === 'regular_smoke' && expense.amount === 1234)); return value; });
    await check('persisted_state', async () => { const value = await get('/api/state'); ensure(value.data?.revision === saved.data.revision && JSON.stringify(value.data.state) === JSON.stringify(saved.data.state)); return value; });
    await check('authenticated_export', async () => { const value = await get('/api/export'); ensure(value.data?.user?.id === user.id && value.data.revision === saved.data.revision && JSON.stringify(value.data.state) === JSON.stringify(saved.data.state)); return value; });
    await check('push_configuration', async () => {
      const value = await get('/api/push/status'); ensure(value.data?.configured === true, 'missing_push', value.response.status);
      ensure(typeof value.data.publicKey === 'string' && Buffer.from(value.data.publicKey, 'base64url').length === 65 && Number.isInteger(value.data.deviceCount) && value.data.deviceCount >= 0 && typeof value.data.subscribed === 'boolean'); return value;
    });
    report.success = true;
  } catch (error) { report.error = failure(error); }
  finally {
    if (accountPossible && base) {
      try {
        if (!new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}$`).test(cookie)) await get('/api/auth/login', { email, password });
        const originalCookie = cookie;
        await check('account_delete', async () => { const value = await get('/api/account', { password }, 'DELETE'); ensure(value.data?.ok === true); return value; });
        await check('deleted_session_rejected', async () => get('/api/auth/me', undefined, 'GET', 401, originalCookie));
        report.testAccountCleanup = true;
      } catch {
        report.testAccountCleanup = false; report.cleanupEmail = email; report.success = false;
        report.error ??= failure(new SmokeError('cleanup_failed'));
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (report.error) log(`FAIL ${report.error.kind}${report.error.httpStatus !== undefined ? ` HTTP ${report.error.httpStatus}` : ''}: ${report.error.message}`);
    if (!report.testAccountCleanup) log(`${messages.cleanup_failed} 임시 이메일: ${email}`);
    else if (report.success) log('공개 앱 검증 통과. 임시 계정은 삭제했습니다. 실제 아이폰 알림 수신은 별도 확인이 필요합니다.');
    if (process.env.GITHUB_ACTIONS === 'true') {
      const failedStep = report.assertions.find(assertion => assertion.status === 'failed')?.name ?? 'cleanup';
      const summary = report.error ? `${failedStep}: ${report.error.kind}${report.error.httpStatus !== undefined ? ` HTTP ${report.error.httpStatus}` : ''}: ${report.error.message}` : '공개 앱 기능 검사 통과. 카테고리·임시 예산·절약 미션·저축 계좌·정기지출 저장 및 임시 계정 삭제 완료. 실제 아이폰 푸시 수신은 별도 확인이 필요합니다.';
      const escaped = summary.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      log(`::${report.success ? 'notice' : 'error'} title=Deployed app verification::${escaped}`);
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let baseUrl = process.env.SMOKE_BASE_URL, reportPath = '.smoke-public-results.json';
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--url' && args[index + 1]) baseUrl = args[index + 1];
    else if (args[index] === '--report' && args[index + 1]) reportPath = args[index + 1];
    else { console.error('Usage: node scripts/smoke-public-app.mjs --url https://worker.workers.dev [--report .smoke-public-results.json]'); process.exitCode = 1; break; }
  }
  if (!process.exitCode) runPublicSmoke({ baseUrl, reportPath }).then(report => { if (!report.success) process.exitCode = 1; }).catch(() => { console.error('검증 보고서를 저장하지 못했습니다. 비밀 값은 출력하지 않았습니다.'); process.exitCode = 1; });
}
