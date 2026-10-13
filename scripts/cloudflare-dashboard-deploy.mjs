import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

export const SECRET_NAMES = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'DATA_ENCRYPTION_KEY', 'SESSION_SECRET'];
const APP = 'salary-guardians/v1';
export class DashboardDeployError extends Error {}
const TABLES = ['users', 'sessions', 'states', 'rate_limits', 'push_subscriptions', 'push_events', 'push_deliveries', 'd1_migrations'];
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const dns = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);

/** Capture every subprocess stream. Neither credentials nor raw API/CLI responses reach Build logs. */
export function runWrangler(args, { cwd, environment }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(cwd, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', size = 0;
    const collect = target => chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill();
      else if (target === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', () => reject(new DashboardDeployError('Wrangler could not start. Install the locked project dependencies.')));
    child.on('exit', code => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}
function parseJSON(text, stage) {
  try { return JSON.parse(text); } catch { throw new DashboardDeployError(`${stage} did not return valid JSON. No raw output was printed.`); }
}
function secretState(result) {
  if (!Array.isArray(result) || result.some(item => !item || typeof item.name !== 'string')) throw new DashboardDeployError('Secret names could not be verified.');
  const names = new Set(result.map(item => item.name));
  const count = SECRET_NAMES.filter(name => names.has(name)).length;
  if (count !== 0 && count !== SECRET_NAMES.length) throw new DashboardDeployError('Only some application secrets exist. Restore the matching missing secrets in Cloudflare settings; existing keys were not replaced.');
  return count === SECRET_NAMES.length ? 'reuse' : 'create';
}

/** Check the public runtime without sending the Build token or creating an account. */
export async function verifySessionRuntime(origin, request = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let status;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await request(`${origin}/api/auth/me`, {
        method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store',
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      const body = await response.json();
      if (status === 401 && body?.error === '로그인이 필요합니다.') return;
    } catch { status = undefined; }
    if (attempt < 5) await wait(2_000);
  }
  throw new DashboardDeployError(status === 503
    ? 'Public runtime verification failed (HTTP 503): SESSION_SECRET may be missing or shorter than 32 bytes in the active Worker. Secret names alone do not prove valid values. Existing keys were preserved.'
    : `Public runtime verification failed (${status === undefined ? 'network or invalid response' : `HTTP ${status}`}). The Worker was uploaded but application readiness was not verified. Existing keys were preserved.`);
}

/** Dashboard Git Builds only: the injected CI tag ties all writes to the selected Worker. */
export async function deployDashboard(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const originalEnv = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const run = options.run ?? runWrangler;
  const request = options.request ?? fetch;
  const account = originalEnv.CLOUDFLARE_ACCOUNT_ID;
  const tag = originalEnv.WRANGLER_CI_MATCH_TAG;
  const token = originalEnv.CLOUDFLARE_API_TOKEN;
  if (!options.dryRun && (!/^[a-f0-9]{32}$/i.test(account ?? '') || !tag || !token)) {
    throw new DashboardDeployError('This command requires a Cloudflare Git Build with its injected account, API token and CI Worker tag. Use cf:deploy for local deployment.');
  }
  // Prevent Wrangler's module initialization from writing credential-capable debug logs.
  process.env.WRANGLER_WRITE_LOGS = 'false';
  process.env.WRANGLER_LOG = 'error';
  // Use Wrangler's JSONC parser, without changing the checked-in configuration.
  const source = options.config ?? (await (await import('wrangler')).experimental_readRawConfig({ config: resolve(cwd, 'wrangler.jsonc') }, { useRedirectIfAvailable: false })).rawConfig;
  const name = originalEnv.WRANGLER_CI_OVERRIDE_NAME ?? source.name;
  if (!dns(name)) throw new DashboardDeployError('The effective Worker name must be a valid workers.dev DNS label.');
  if (source.d1_databases?.length !== 1 || source.d1_databases[0].binding !== 'DB') throw new DashboardDeployError('Exactly one application D1 binding named DB is required.');
  const config = structuredClone(source);
  config.name = name;
  config.account_id = account;
  config.main = resolve(cwd, source.main);
  config.assets.directory = resolve(cwd, source.assets.directory);
  config.d1_databases[0].migrations_dir = resolve(cwd, source.d1_databases[0].migrations_dir);
  config.vars = { ...config.vars, SALARY_GUARDIANS_APP: APP };
  config.send_metrics = false;
  const directory = await mkdtemp(resolve(cwd, '.cloudflare-dashboard-'));
  const configFile = resolve(directory, 'wrangler.json');
  const environment = { ...originalEnv, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG: 'log' };
  if (!environment.XDG_CONFIG_HOME && cwd.startsWith('/workspace/')) environment.XDG_CONFIG_HOME = '/workspace/scratch/salary-guardians-cloudflare';
  const saveConfig = () => writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const cli = async (args, stage, json = false) => {
    const result = await run([...args, '--config', configFile], { cwd, environment });
    if (result.code !== 0) {
      const forbidden = /\b403\b|\[code:\s*10000\]|Authentication error/i.test(`${result.stdout}\n${result.stderr}`);
      throw new DashboardDeployError(`${stage} failed${forbidden ? ' (Cloudflare authorization denied)' : ` (exit ${result.code})`}. Check the Build API token's Workers Scripts and D1 permissions. Raw output was withheld.`);
    }
    return json ? parseJSON(result.stdout, stage) : result;
  };
  const api = async path => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new DashboardDeployError(`Cloudflare target verification failed (HTTP ${response.status}). Check the Git Build API token permissions.`);
    let value;
    try { value = await response.json(); } catch { throw new DashboardDeployError('Cloudflare target verification returned invalid JSON.'); }
    if (value.success !== true) throw new DashboardDeployError('Cloudflare target verification was rejected. No raw API output was printed.');
    return value.result;
  };
  try {
    await saveConfig();
    if (options.dryRun) {
      await cli(['deploy', '--dry-run', '--outdir', resolve(directory, 'bundle')], 'Worker dry-run');
      log('Dashboard deployment dry-run passed. No remote resources or secret values were changed.');
      return { dryRun: true };
    }
    const service = await api(`/workers/services/${encodeURIComponent(name)}`);
    const script = service?.default_environment?.script;
    if (script?.tag !== tag) throw new DashboardDeployError('The Worker does not match this Git Build. Deployment stopped before database or secret changes.');
    const settings = await api(`/workers/scripts/${encodeURIComponent(name)}/settings`);
    if (!Array.isArray(settings?.bindings)) throw new DashboardDeployError('Existing Worker bindings could not be verified.');
    const { subdomain } = await api('/workers/subdomain');
    if (!dns(subdomain)) throw new DashboardDeployError('A valid existing workers.dev account subdomain is required.');
    const origin = `https://${name}.${subdomain}.workers.dev`;
    const oldOrigin = settings.bindings.find(binding => binding.name === 'PUBLIC_ORIGIN');
    if ((oldOrigin && (oldOrigin.type !== 'plain_text' || oldOrigin.text !== origin)) || (source.vars?.PUBLIC_ORIGIN !== undefined && source.vars.PUBLIC_ORIGIN !== origin)) {
      throw new DashboardDeployError('PUBLIC_ORIGIN does not match this Worker HTTPS address or is hidden as a secret. Correct it in Cloudflare settings; existing variables were not changed.');
    }
    if (settings.bindings.some(binding => !['d1', 'plain_text', 'secret_text', 'assets'].includes(binding.type))) throw new DashboardDeployError('The Worker has resources outside this application. No remote resources were changed.');
    const bindings = settings.bindings.filter(binding => binding.type === 'd1');
    if (bindings.length > 1 || bindings.some(binding => binding.name !== 'DB' || !uuid(binding.id))) throw new DashboardDeployError('Existing D1 bindings do not match the application. No database was changed.');
    const assets = settings.bindings.filter(binding => binding.type === 'assets');
    if (assets.length > 1 || assets.some(binding => binding.name !== (source.assets.binding ?? 'ASSETS'))) throw new DashboardDeployError('Existing asset bindings do not match the application. No remote resources were changed.');
    const mode = secretState(await cli(['secret', 'list', '--name', name, '--format', 'json'], 'Secret name lookup', true));
    log(`Application secret setup: ${mode === 'reuse' ? 'preserving existing values' : 'initializing after empty-database verification'}.`);
    if (mode === 'create') {
      const marker = settings.bindings.find(binding => binding.name === 'SALARY_GUARDIANS_APP');
      const legacyKeys = settings.bindings.some(binding => SECRET_NAMES.includes(binding.name));
      // A first plain Wrangler deploy may already have attached an empty DB and ASSETS.
      // The live schema/occupancy checks below must prove that recovery cannot rotate keys for existing data.
      if (marker || legacyKeys || settings.bindings.some(binding => !['plain_text', 'd1', 'assets'].includes(binding.type))) {
        throw new DashboardDeployError('All application secrets are missing from an existing application. Automatic key regeneration is disabled; restore its original keys or import into a new untouched Worker.');
      }
    }
    const configuredId = source.d1_databases[0].database_id;
    const existingId = bindings[0]?.id;
    if (configuredId && configuredId !== existingId) throw new DashboardDeployError('The configured database does not match the linked Worker binding. No database was changed.');
    const databases = await cli(['d1', 'list', '--json'], 'D1 lookup', true);
    if (!Array.isArray(databases)) throw new DashboardDeployError('D1 lookup did not return a database list.');
    const databaseName = `${name}-db`;
    let database = existingId ? databases.find(item => item.uuid === existingId) : databases.find(item => item.name === databaseName);
    if (existingId && !database) throw new DashboardDeployError('The linked Worker database is not accessible. No replacement database was created.');
    if (database && !uuid(database.uuid)) throw new DashboardDeployError('The database identifier is invalid.');
    config.d1_databases[0].database_name = database?.name ?? databaseName;
    config.d1_databases[0].database_id = database?.uuid;
    await saveConfig();
    if (!database) {
      await cli(['d1', 'create', databaseName, '--binding', 'DB', '--update-config'], 'D1 creation');
      const created = JSON.parse(await readFile(configFile, 'utf8'));
      const id = created.d1_databases?.find(binding => binding.binding === 'DB')?.database_id;
      if (!uuid(id)) throw new DashboardDeployError('D1 creation did not write a valid database identifier to the temporary config.');
      database = { uuid: id, name: databaseName };
      config.d1_databases[0].database_id = id;
    } else {
      const rows = await cli(['d1', 'execute', 'DB', '--remote', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", '--json'], 'D1 ownership check', true);
      const tables = rows?.[0]?.results?.map(row => row.name);
      const applicationTables = Array.isArray(tables) ? tables.filter(table => table !== 'd1_migrations') : [];
      if (!Array.isArray(tables) || tables.some(table => !TABLES.includes(table)) || (applicationTables.length && !TABLES.slice(0, 7).every(table => tables.includes(table)))) {
        throw new DashboardDeployError('The database contains a different or incomplete application schema. No migrations were applied.');
      }
      if (mode === 'create' && applicationTables.length) {
        const occupancy = await cli(['d1', 'execute', 'DB', '--remote', '--command', 'SELECT (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM states)+(SELECT COUNT(*) FROM push_subscriptions) AS occupied', '--json'], 'Existing data safety check', true);
        if (occupancy?.[0]?.results?.[0]?.occupied !== 0) throw new DashboardDeployError('The existing database contains accounts or encrypted subscriptions but the original keys are missing. Restore those keys; new keys were not generated.');
      }
      if (!applicationTables.length && tables.includes('d1_migrations')) {
        const ledger = await cli(['d1', 'execute', 'DB', '--remote', '--command', 'SELECT COUNT(*) AS occupied FROM d1_migrations', '--json'], 'Migration ledger check', true);
        if (ledger?.[0]?.results?.[0]?.occupied !== 0) throw new DashboardDeployError('The migration ledger records changes but application tables are missing. No further migrations were applied.');
      }
    }
    await saveConfig();
    await cli(['d1', 'migrations', 'apply', 'DB', '--remote'], 'D1 migrations');
    if (mode === 'create') {
      // Recheck immediately before bootstrap; never overwrite keys from another completed build.
      const rechecked = secretState(await cli(['secret', 'list', '--name', name, '--format', 'json'], 'Secret bootstrap recheck', true));
      if (rechecked === 'create') {
        const keys = webpush.generateVAPIDKeys();
        const secrets = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: `${origin}/`, DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(32).toString('base64url') };
        const file = resolve(directory, 'secrets.json');
        await writeFile(file, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
        try { await cli(['secret', 'bulk', file, '--name', name], 'Secret bootstrap'); }
        finally { await rm(file, { force: true }); }
        if (secretState(await cli(['secret', 'list', '--name', name, '--format', 'json'], 'Secret bootstrap verification', true)) !== 'reuse') throw new DashboardDeployError('Secret bootstrap could not be verified. Existing remote keys were not regenerated.');
      }
    }
    if (secretState(await cli(['secret', 'list', '--name', name, '--format', 'json'], 'Final secret verification', true)) !== 'reuse') throw new DashboardDeployError('The application secrets changed during deployment. Restore the original keys; new keys were not generated.');
    await cli(['deploy', '--name', name, '--keep-vars'], 'Worker deployment');
    await verifySessionRuntime(origin, request, options.wait);
    log('Dashboard deployment completed: D1 migrations applied and all five application secrets preserved or securely initialized.');
    log('Public session configuration verified. Account creation and real iPhone push delivery still require functional testing.');
    log(`Open ${origin} in Safari, add it to the Home Screen, then enable notifications and test real iPhone delivery.`);
    return { workerName: name, secrets: mode, origin };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) { console.error('Usage: npm run cf:deploy:dashboard [-- --dry-run]'); process.exitCode = 1; }
  else deployDashboard({ dryRun: args.includes('--dry-run') }).catch(error => {
    // Error messages produced above contain stages/status only. Unexpected errors may contain sensitive input.
    console.error(error instanceof DashboardDeployError ? error.message : 'Dashboard deployment failed. Verify the linked Worker and Build API token permissions. No secret values were printed.');
    process.exitCode = 1;
  });
}
