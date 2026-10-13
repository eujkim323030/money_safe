import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('key setup writes valid private keys with 0600 permissions, preserves them on rerun and never logs secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'salary-keys-'));
  const out = join(directory, '.env');
  try {
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate-keys.ts', '--out', out, '--origin', 'http://localhost:5173'], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(out, 'utf8');
    const settings = Object.fromEntries(before.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    assert.equal(Buffer.from(settings.DATA_ENCRYPTION_KEY, 'base64').length, 32);
    const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from(settings.VAPID_PRIVATE_KEY, 'base64url'));
    assert.equal(curve.getPublicKey().toString('base64url'), settings.VAPID_PUBLIC_KEY);
    for (const key of ['VAPID_PRIVATE_KEY', 'DATA_ENCRYPTION_KEY', 'SESSION_SECRET']) assert.ok(!first.stdout.includes(settings[key]));
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(out, 'utf8'), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
