import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
const built = await build({
  entryPoints: ['cloudflare/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', write: false, external: ['node:*'],
});
const bindingNames = ['SESSION_SECRET', 'DATA_ENCRYPTION_KEY', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'PUBLIC_ORIGIN'];
const bindings = Object.fromEntries(bindingNames.filter(name => process.env[name]).map(name => [name, process.env[name]!]));
const mf = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: Number(process.env.PORT ?? 4173),
  d1Persist: process.env.DATA_DIR,
  workers: [{
    name: 'salary-guardians', modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], bindings,
    d1Databases: { DB: 'e2e-database' },
    assets: { directory: resolve('dist'), binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
  }],
}));
const db = await mf.getD1Database('DB', 'salary-guardians');
for (const filename of (await readdir('cloudflare/migrations')).filter(name => name.endsWith('.sql')).sort()) {
  const migration = await readFile(resolve('cloudflare/migrations', filename), 'utf8');
  await db.batch(migration.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}
await mf.ready;
console.info('Cloudflare workerd + D1 E2E server is ready.');
let closed = false;
async function close() { if (!closed) { closed = true; await mf.dispose(); } }
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
