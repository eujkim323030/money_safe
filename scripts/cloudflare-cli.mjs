import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const environment = { ...process.env };
// The cloud sandbox's home is read-only; Wrangler supports XDG_CONFIG_HOME.
// Existing explicit configuration and local computers retain their settings.
if (!environment.XDG_CONFIG_HOME && process.cwd().startsWith('/workspace/')) {
  environment.XDG_CONFIG_HOME = '/workspace/scratch/salary-guardians-cloudflare';
}
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: environment,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
