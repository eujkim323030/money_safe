import { defineConfig } from '@playwright/test';
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
const vapid = createECDH('prime256v1');
const publicKey = vapid.generateKeys().toString('base64url');
export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, expect: { timeout: 7000 }, workers: 1,
  reporter: [['list']], use: {
    baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 },
    browserName: 'chromium', launchOptions: { executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure'
  },
  webServer: {
    command: process.env.E2E_BACKEND === 'cloudflare' ? 'node --import tsx scripts/cloudflare-e2e-server.ts' : 'npm start', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: false, timeout: 30_000,
    env: {
      NODE_ENV: 'development', PORT: '4173', PUBLIC_ORIGIN: 'http://127.0.0.1:4173', DATA_DIR: `/tmp/money-safe-e2e-${process.pid}`,
      SESSION_SECRET: randomBytes(32).toString('base64url'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      VAPID_SUBJECT: 'mailto:automated-test@example.invalid', VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url')
    }
  }
});
