import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const moduleUrl = new URL('../scripts/cloudflare-dashboard-deploy.mjs', import.meta.url).href;
const { deployDashboard, SECRET_NAMES } = await import(moduleUrl);
const account = 'a'.repeat(32), dbId = '11111111-1111-4111-8111-111111111111';
const config = { name: 'salary-guardians', main: 'cloudflare/index.ts', assets: { directory: 'dist' }, d1_databases: [{ binding: 'DB', database_name: 'salary-guardians-db', migrations_dir: 'cloudflare/migrations' }] };
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'TOKEN-CANARY-NOT-FOR-LOGS', WRANGLER_CI_MATCH_TAG: 'linked-tag', WRANGLER_CI_OVERRIDE_NAME: 'money-safe' };
const appTables = ['users', 'sessions', 'states', 'rate_limits', 'push_subscriptions', 'push_events', 'push_deliveries', 'd1_migrations'];
interface RunOptions { cwd: string; environment: Record<string, string> }
interface Setup { names?: string[]; binding?: boolean; existingDb?: boolean; tag?: string; fail?: string; tables?: string[]; stale?: boolean; occupied?: number; plainKeys?: boolean; origin?: string }
async function fixture(context: TestContext, setup: Setup = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'salary-dashboard-test-')); context.after(() => rm(cwd, { recursive: true, force: true }));
  let names = setup.names ?? [...SECRET_NAMES];
  const calls: string[][] = [], messages: string[] = [], secrets: Record<string, string>[] = [];
  let secretFile = '';
  const run = async (args: string[], options: RunOptions) => {
    calls.push(args); assert.equal(options.environment.CI, 'true'); assert.equal(options.environment.WRANGLER_WRITE_LOGS, 'false');
    const file = args[args.indexOf('--config') + 1];
    const current = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(current.name, 'money-safe'); assert.equal(current.account_id, account);
    assert.ok(current.main.startsWith(cwd)); assert.ok(current.assets.directory.startsWith(cwd));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const kind = args.slice(0, 2).join(' ');
    if (setup.fail === kind) return { code: 1, stdout: '403 TOKEN-CANARY-NOT-FOR-LOGS PRIVATE-OUTPUT-CANARY', stderr: 'Authorization denied PRIVATE-OUTPUT-CANARY' };
    let value: unknown = [];
    if (kind === 'secret list') { assert.equal(args[args.indexOf('--name') + 1], 'money-safe'); value = names.map(name => ({ name, type: 'secret_text' })); }
    if (kind === 'd1 list') value = setup.binding || setup.existingDb ? [{ uuid: dbId, name: setup.binding ? 'existing-wallet-db' : 'money-safe-db' }] : [];
    if (kind === 'd1 execute') value = args[args.indexOf('--command') + 1].includes('COUNT') ? [{ results: [{ occupied: setup.occupied ?? 0 }] }] : [{ results: (setup.tables ?? appTables).map(name => ({ name })) }];
    if (kind === 'd1 create') {
      assert.equal(args[2], 'money-safe-db'); assert.ok(args.includes('--update-config'));
      current.d1_databases[0].database_id = dbId; await writeFile(file, JSON.stringify(current));
    }
    if (kind === 'secret bulk') {
      secretFile = args[2]; assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
      const uploaded = JSON.parse(await readFile(secretFile, 'utf8')); secrets.push(uploaded); names = [...SECRET_NAMES];
      assert.deepEqual(Object.keys(uploaded).sort(), [...SECRET_NAMES].sort());
      assert.equal(uploaded.VAPID_SUBJECT, 'https://money-safe.real-account.workers.dev/');
    }
    if (args[0] === 'deploy') { assert.equal(current.d1_databases[0].database_id, dbId); assert.ok(!args.includes('--yes')); }
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const request = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/`));
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    const bindings: Record<string, string>[] = setup.binding ? [{ type: 'd1', name: 'DB', id: dbId }] : [];
    if (setup.plainKeys) bindings.push({ type: 'plain_text', name: 'DATA_ENCRYPTION_KEY', text: 'PRIVATE-OUTPUT-CANARY' });
    if (setup.origin) bindings.push({ type: 'plain_text', name: 'PUBLIC_ORIGIN', text: setup.origin });
    const result = url.endsWith('/settings') ? { bindings }
      : url.endsWith('/subdomain') ? { subdomain: 'real-account' }
      : { default_environment: { script: { tag: setup.tag ?? 'linked-tag', created_on: '2026-10-13T00:00:00Z', modified_on: setup.stale ? '2026-10-14T00:00:00Z' : '2026-10-13T00:00:00Z' } } };
    return Response.json({ success: true, result });
  };
  const options = { cwd, environment: env, config, run, request, log: (message: string) => messages.push(message) };
  return { cwd, options, calls, messages, secrets, secretFile: () => secretFile };
}

test('dashboard deployment requires injected Build identity before any side effects', async context => {
  const f = await fixture(context);
  await assert.rejects(deployDashboard({ ...f.options, environment: {} }), /requires a Cloudflare Git Build/);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.cwd), []);
  await assert.rejects(deployDashboard({ ...f.options, request: async () => Response.json({ success: true, result: { default_environment: { script: { tag: 'wrong-worker' } } } }) }), /does not match/);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.cwd), []);
});

test('dashboard redeployment preserves all existing keys and the actual linked database', async context => {
  const f = await fixture(context, { binding: true });
  const result = await deployDashboard(f.options);
  assert.equal(result.secrets, 'reuse'); assert.equal(f.secrets.length, 0);
  assert.equal(result.origin, 'https://money-safe.real-account.workers.dev');
  assert.ok(f.messages.some(message => message.includes(result.origin)));
  assert.ok(!f.calls.some(args => args[0] === 'secret' && args[1] === 'bulk'));
  assert.ok(!f.calls.some(args => args[0] === 'd1' && args[1] === 'create'));
  const migrate = f.calls.findIndex(args => args[1] === 'migrations'); const deploy = f.calls.findIndex(args => args[0] === 'deploy');
  assert.ok(migrate >= 0 && migrate < deploy); assert.deepEqual(await readdir(f.cwd), []);
});

test('partial existing secrets stop before database or deployment writes', async context => {
  const f = await fixture(context, { names: ['DATA_ENCRYPTION_KEY'], binding: true });
  await assert.rejects(deployDashboard(f.options), /Only some application secrets exist/);
  assert.deepEqual(f.calls.map(args => args.slice(0, 2).join(' ')), ['secret list']);
  assert.deepEqual(await readdir(f.cwd), []);
});

test('new untouched Build Worker gets five secure secrets through a private temporary file', async context => {
  const f = await fixture(context, { names: [] });
  const result = await deployDashboard(f.options);
  assert.equal(result.secrets, 'create'); assert.equal(f.secrets.length, 1);
  assert.equal(Buffer.from(f.secrets[0].DATA_ENCRYPTION_KEY, 'base64').length, 32);
  assert.ok(f.secrets[0].SESSION_SECRET.length >= 32);
  for (const name of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DATA_ENCRYPTION_KEY', 'SESSION_SECRET']) assert.ok(!f.messages.join('\n').includes(f.secrets[0][name]));
  await assert.rejects(stat(f.secretFile()), { code: 'ENOENT' }); assert.deepEqual(await readdir(f.cwd), []);
});

test('missing keys on an existing application or legacy plain key bindings never trigger regeneration', async context => {
  const f = await fixture(context, { names: [], binding: true });
  await assert.rejects(deployDashboard(f.options), /Automatic key regeneration is disabled/);
  assert.ok(!f.calls.some(args => args[0] === 'd1')); assert.deepEqual(await readdir(f.cwd), []);
  const legacy = await fixture(context, { names: [], plainKeys: true });
  await assert.rejects(deployDashboard(legacy.options), /Automatic key regeneration is disabled/);
  assert.ok(!legacy.calls.some(args => args[0] === 'd1'));
});

test('existing account data blocks key generation while an empty migration ledger remains retryable', async context => {
  const occupied = await fixture(context, { names: [], existingDb: true, occupied: 1 });
  await assert.rejects(deployDashboard(occupied.options), /original keys are missing/);
  assert.ok(!occupied.calls.some(args => args[1] === 'migrations'));
  const empty = await fixture(context, { names: [], existingDb: true, tables: ['d1_migrations'] });
  await deployDashboard(empty.options);
  assert.equal(empty.secrets.length, 1);
  assert.ok(!empty.calls.some(args => args[1] === 'create'));
});

test('a conflicting preserved PUBLIC_ORIGIN stops before secret or database writes', async context => {
  const f = await fixture(context, { origin: 'http://localhost:8787', binding: true });
  await assert.rejects(deployDashboard(f.options), /PUBLIC_ORIGIN does not match/);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.cwd), []);
});

test('foreign database schema and CLI failures stop safely without exposing raw output', async context => {
  const foreign = await fixture(context, { binding: true, tables: ['customer_payments'] });
  await assert.rejects(deployDashboard(foreign.options), /different or incomplete application schema/);
  assert.ok(!foreign.calls.some(args => args[1] === 'migrations'));
  const denied = await fixture(context, { names: [], fail: 'secret bulk' });
  await assert.rejects(deployDashboard(denied.options), error => {
    assert.match((error as Error).message, /Secret bootstrap failed.*authorization denied/);
    assert.ok(!(error as Error).message.includes('CANARY')); return true;
  });
  assert.ok(!denied.calls.some(args => args[0] === 'deploy'));
  await assert.rejects(stat(denied.secretFile()), { code: 'ENOENT' }); assert.deepEqual(await readdir(denied.cwd), []);
});
