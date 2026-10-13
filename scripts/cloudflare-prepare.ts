import { createECDH, randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const secretNames = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'DATA_ENCRYPTION_KEY', 'SESSION_SECRET'] as const;
type SecretName = typeof secretNames[number];
type Secrets = Record<SecretName, string>;
const argumentsList = process.argv.slice(2);
const options: Record<string, string> = {};
const supported = new Set(['env', 'dev-out', 'secrets-out', 'subject']);
for (let index = 0; index < argumentsList.length; index += 2) {
  const name = argumentsList[index]?.replace(/^--/, '');
  const value = argumentsList[index + 1];
  if (!argumentsList[index]?.startsWith('--') || !name || !supported.has(name) || value === undefined || /[\r\n\0]/.test(value)) {
    throw new Error('Usage: cloudflare-prepare.ts [--env .env] [--dev-out .dev.vars] OR [--secrets-out .cloudflare-secrets.json --subject https://your-real-worker.workers.dev/]');
  }
  options[name] = value;
}
if (options['dev-out'] && options['secrets-out']) throw new Error('Choose either development variables or production secrets.');
if (options.subject && !options['secrets-out']) throw new Error('--subject is available with --secrets-out.');

const sourcePath = resolve(options.env ?? '.env');
const outputPath = resolve(options['secrets-out'] ?? options['dev-out'] ?? '.dev.vars');
if (sourcePath === outputPath) throw new Error('The source environment file must not be the output file.');

async function readRegularFile(path: string, optional = false): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Only regular environment and secret files are supported.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function readVariables(contents: string): Record<string, string> {
  let variables: Record<string, string>;
  try {
    variables = Object.fromEntries(Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
  catch { throw new Error('The environment file could not be parsed; its original contents were not changed.'); }
  for (const name of [...secretNames, 'PUBLIC_ORIGIN']) {
    const assignments = [...contents.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm'))];
    if (assignments.length > 1) throw new Error(`Resolve duplicate ${name} assignments before preparing Cloudflare variables.`);
  }
  return variables;
}

function decode(name: SecretName, value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error(`${name} has invalid encoding.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length) throw new Error(`${name} has an invalid byte length.`);
  return bytes;
}

function validateSecrets(secrets: Secrets): void {
  for (const name of secretNames) {
    if (!secrets[name] || /[\r\n\0]/.test(secrets[name])) throw new Error(`${name} is missing or invalid. Run npm run keys first; secret values must not be posted in chat.`);
  }
  const curve = createECDH('prime256v1');
  curve.setPrivateKey(decode('VAPID_PRIVATE_KEY', secrets.VAPID_PRIVATE_KEY, 32));
  if (!curve.getPublicKey().equals(decode('VAPID_PUBLIC_KEY', secrets.VAPID_PUBLIC_KEY, 65))) {
    throw new Error('VAPID public/private keys do not match. Existing key pairs were not changed.');
  }
  decode('DATA_ENCRYPTION_KEY', secrets.DATA_ENCRYPTION_KEY, 32);
  if (Buffer.byteLength(secrets.SESSION_SECRET) < 32) throw new Error('SESSION_SECRET must contain at least 32 bytes.');
  const contact = new URL(secrets.VAPID_SUBJECT);
  if (!['mailto:', 'https:'].includes(contact.protocol) || !contact.pathname || (contact.protocol === 'https:' && !contact.hostname)) {
    throw new Error('VAPID_SUBJECT must be a mailto: contact or a real HTTPS contact URL.');
  }
}

const source = readVariables(await readRegularFile(sourcePath));
const sourceSecrets = Object.fromEntries(secretNames.map(name => [name, source[name] ?? ''])) as Secrets;
validateSecrets(sourceSecrets);
let outputContents = await readRegularFile(outputPath, true);
let existing: Record<string, string> = {};
if (options['secrets-out']) {
  if (outputContents.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(outputContents); }
    catch { throw new Error('The existing production secret file is not valid JSON; its original contents were not changed.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The existing secret file must be a JSON object.');
    for (const [name, value] of Object.entries(parsed)) {
      if (!secretNames.includes(name as SecretName) || typeof value !== 'string') {
        throw new Error('The production secret file may contain only the five supported secret names and string values.');
      }
      existing[name] = value;
    }
  }
} else {
  existing = readVariables(outputContents);
}

const existingPublic = existing.VAPID_PUBLIC_KEY;
const existingPrivate = existing.VAPID_PRIVATE_KEY;
if (Boolean(existingPublic) !== Boolean(existingPrivate)) {
  const presentName: SecretName = existingPublic ? 'VAPID_PUBLIC_KEY' : 'VAPID_PRIVATE_KEY';
  if (existing[presentName] !== sourceSecrets[presentName]) {
    throw new Error('An existing VAPID pair is incomplete and differs from the source pair. Restore the matching key instead of replacing subscriptions.');
  }
}
const secrets = Object.fromEntries(secretNames.map(name => [name, existing[name] || sourceSecrets[name]])) as Secrets;
if (options.subject) secrets.VAPID_SUBJECT = options.subject;
validateSecrets(secrets);

if (options['secrets-out']) {
  outputContents = `${JSON.stringify(secrets, null, 2)}\n`;
} else {
  const origin = existing.PUBLIC_ORIGIN || 'http://127.0.0.1:8787';
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must be an absolute HTTP(S) origin without a trailing slash.');
  }
  const variables = { ...secrets, PUBLIC_ORIGIN: origin };
  for (const [name, value] of Object.entries(variables)) {
    if (existing[name]) continue;
    const line = `${name}=${JSON.stringify(value)}`;
    const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
    if (assignment.test(outputContents)) outputContents = outputContents.replace(assignment, () => line);
    else {
      if (outputContents && !outputContents.endsWith('\n')) outputContents += '\n';
      outputContents += `${line}\n`;
    }
  }
}

const temporary = `${outputPath}.tmp-${randomBytes(8).toString('hex')}`;
try {
  await writeFile(temporary, outputContents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, outputPath);
  await chmod(outputPath, 0o600);
} finally {
  await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
console.log(`Prepared ${options['secrets-out'] ? 'production secrets' : 'local Worker variables'} at ${outputPath} with mode 600. Existing keys were preserved; secret values were not printed.`);
if (secrets.VAPID_SUBJECT.includes('example.invalid')) {
  console.log('The contact is still a local placeholder. Prepare production secrets with --subject using the actual deployed HTTPS address or your real mailto: contact.');
}
