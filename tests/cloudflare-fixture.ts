import { readFile, readdir } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type { D1Database, Fetcher } from '@cloudflare/workers-types';
import type { Env } from '../cloudflare/types';

let bundled: Promise<string> | undefined;
function workerScript(): Promise<string> {
  return bundled ??= build({
    stdin: {
      contents: `import { handleApiRequest } from './cloudflare/api.ts';
        export default { async fetch(request,env) {
          return await handleApiRequest(request,env) ?? new Response('Not found',{status:404});
        } };`,
      resolveDir: process.cwd(),
      sourcefile: 'test-worker.ts',
      loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, external: ['node:*'],
  }).then(result => result.outputFiles[0].text);
}

export async function cloudflareFixture(context: TestContext, bindings: Record<string, string> = {}) {
  const secrets = { SESSION_SECRET: 'test-secret-with-more-than-32-bytes-for-worker', ...bindings };
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'api',
      modules: true,
      script: await workerScript(),
      compatibilityDate: '2026-10-13',
      compatibilityFlags: ['nodejs_compat'],
      bindings: secrets,
      d1Databases: { DB: crypto.randomUUID() },
    }],
  }));
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'api') as unknown as D1Database;
  const directory = new URL('../cloudflare/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const migration = await readFile(new URL(name, directory), 'utf8');
    await db.batch(migration.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  }
  const env: Env = { DB: db, ASSETS: {} as Fetcher, ...secrets };
  return { mf, db, env };
}

export class CloudClient {
  cookie = '';
  constructor(readonly mf: Miniflare, readonly ip = '192.0.2.1') {}
  async fetch(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
    const response = await this.mf.dispatchFetch(`https://app.example${path}`, {
      method,
      headers: {
        'X-Requested-With': 'salary-guardians',
        'CF-Connecting-IP': this.ip,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await response.json() as Record<string, unknown>;
    return { response, data };
  }
}
