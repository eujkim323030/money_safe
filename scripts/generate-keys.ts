import { createECDH, randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
const allowed = new Set(['out', 'origin', 'subject', 'domain', 'email']);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]?.replace(/^--/, '');
  const value = args[index + 1];
  if (!args[index]?.startsWith('--') || !name || !allowed.has(name) || value === undefined || /[\r\n\0]/.test(value)) {
    throw new Error('Usage: npm run keys -- [--out .env] [--origin https://your-domain] [--subject mailto:your-email] [--domain your-domain] [--email your-email]');
  }
  options[name] = value;
}

const output = resolve(options.out ?? '.env');
let contents = '';
try {
  const metadata = await lstat(output);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Refusing to replace a nonregular environment file.');
  contents = await readFile(output, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

function readSetting(name: string): string | undefined {
  const matches = [...contents.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm'))];
  if (matches.length > 1) throw new Error(`Duplicate ${name} in environment file. Resolve it before generating keys.`);
  return parseEnv(contents)[name];
}

const origin = readSetting('PUBLIC_ORIGIN') || options.origin || 'http://localhost:3000';
const parsedOrigin = new URL(origin);
if (parsedOrigin.origin !== origin || !['http:', 'https:'].includes(parsedOrigin.protocol)) {
  throw new Error('PUBLIC_ORIGIN must be an absolute HTTP(S) origin without a trailing slash or path.');
}
if (parsedOrigin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)) {
  throw new Error('Use HTTPS for a public deployment; HTTP is allowed only for local development.');
}
const subject = readSetting('VAPID_SUBJECT') || options.subject || 'mailto:local-test@example.invalid';
if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: contact address.');
const domain = readSetting('APP_DOMAIN') || options.domain || '';
const email = readSetting('ACME_EMAIL') || options.email || '';
if (domain && !/^[a-zA-Z0-9.-]+$/.test(domain)) throw new Error('APP_DOMAIN must be a bare DNS name.');
if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('ACME_EMAIL must be an email address.');

const existingPublic = readSetting('VAPID_PUBLIC_KEY');
const existingPrivate = readSetting('VAPID_PRIVATE_KEY');
if (Boolean(existingPublic) !== Boolean(existingPrivate)) {
  throw new Error('A VAPID key pair is incomplete. Restore the matching key; existing subscriptions depend on the original pair.');
}
let publicKey = existingPublic;
let privateKey = existingPrivate;
if (!publicKey || !privateKey) {
  const vapid = createECDH('prime256v1');
  publicKey = vapid.generateKeys().toString('base64url');
  const scalar = vapid.getPrivateKey();
  privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
}

const generated: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3000',
  PUBLIC_ORIGIN: origin,
  DATA_DIR: './data',
  VAPID_SUBJECT: subject,
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKey,
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  APP_DOMAIN: domain,
  ACME_EMAIL: email,
};
let changed = 0;
for (const [name, value] of Object.entries(generated)) {
  if (readSetting(name)) continue;
  const line = `${name}=${value}`;
  const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
  if (assignment.test(contents)) {
    contents = contents.replace(assignment, () => line);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += `${line}\n`;
  }
  if (value) changed += 1;
}

const temporary = `${output}.tmp-${randomBytes(8).toString('hex')}`;
try {
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, output);
  await chmod(output, 0o600);
} finally {
  await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
console.log(`Saved environment file ${output}; populated ${changed} missing values. Existing nonempty settings were preserved. Secret values were not printed.`);
if (subject.endsWith('@example.invalid')) {
  console.log('Local test contact is configured. Before public deployment set VAPID_SUBJECT to your real mailto: contact.');
}
