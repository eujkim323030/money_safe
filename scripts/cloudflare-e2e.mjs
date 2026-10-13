import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test'], {
  stdio: 'inherit', env: { ...process.env, E2E_BACKEND: 'cloudflare' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
