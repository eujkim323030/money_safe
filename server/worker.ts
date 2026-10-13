import { existsSync } from 'node:fs';
import { AppDatabase } from './db.ts';
import { loadPushConfiguration, PushScheduler } from './push.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const configuration = loadPushConfiguration();
const database = new AppDatabase();
const scheduler = new PushScheduler(database, { configuration });
if (!configuration) console.info(JSON.stringify({ event: 'push_worker_unconfigured', message: 'VAPID keys, VAPID_SUBJECT and DATA_ENCRYPTION_KEY are required for real delivery.' }));
else console.info(JSON.stringify({ event: 'push_worker_started', intervalSeconds: 30, timezone: 'Asia/Seoul' }));

let shuttingDown = false;
let pending: Promise<void> | undefined;
function tick(): void {
  if (shuttingDown || pending) return;
  pending = scheduler.tick().catch(() => {
    console.error(JSON.stringify({ event: 'push_worker_error', message: 'Scheduler failed; inspect database availability and configuration.' }));
  }).finally(() => { pending = undefined; });
}
const timer = setInterval(tick, 30_000);
tick();
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  scheduler.stop();
  await pending;
  database.db.close();
  process.exitCode = 0;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
