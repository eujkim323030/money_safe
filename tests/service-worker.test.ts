import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  let notification: any, opened: string | undefined, navigation: string | undefined, focused = false;
  const windows: any[] = [
    { url: 'https://foreign.example/', navigate() { throw new Error('Foreign client must be skipped'); } },
    { url: 'https://salary.example/#home', async navigate(url: string) { navigation = url; }, async focus() { focused = true; } }
  ];
  const self = {
    location: { origin: 'https://salary.example' },
    addEventListener(type: string, fn: (event: any) => void) { handlers[type] = fn; },
    registration: { async showNotification(title: string, options: any) { notification = { title, options }; } },
    clients: { async matchAll() { return windows; }, async openWindow(url: string) { opened = url; } }
  };
  const context = vm.createContext({ self, URL, Request, Response, Set, Promise });
  vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  async function dispatch(type: string, data: Record<string, unknown>) {
    let pending: Promise<void> | undefined;
    handlers[type]({ ...data, waitUntil(p: Promise<void>) { pending = p; } });
    await pending;
  }
  return { handlers, context, dispatch, windows, get notification() { return notification; }, get opened() { return opened; }, get navigation() { return navigation; }, get focused() { return focused; } };
}
test('service worker never intercepts authenticated APIs and restricts deep links to its own app routes', () => {
  const w = worker();
  for (const path of ['/api/state', '/api/auth/me', '/api/push/status', '/api']) {
    w.handlers.fetch({ request: new Request('https://salary.example' + path), respondWith() { assert.fail('API must not be cached'); } });
  }
  for (const [input, expected] of [['/#missions', '/#missions'], ['/?secret=value#stats', '/#stats'], ['https://evil.example/#home', '/#home'], ['/api/export#home', '/#home'], ['javascript:alert(1)', '/#home'], ['/#unknown', '/#home']]) {
    assert.equal(vm.runInContext(`safeLink(${JSON.stringify(input)})`, w.context), expected);
  }
});
test('actual service-worker push handler displays payload/tag and safely handles malformed payload', async () => {
  const w = worker();
  await w.dispatch('push', { data: { json: () => ({ title: '월급수비대', body: '새 미션', url: 'https://evil.example/#settings', tag: 'stable-job-id' }) } });
  assert.equal(w.notification.options.data.url, '/#home');
  assert.equal(w.notification.options.tag, 'stable-job-id');
  assert.equal(w.notification.options.icon, '/icons/icon-192.png');
  await w.dispatch('push', { data: { json() { throw new Error('invalid'); } } });
  assert.equal(w.notification.title, '월급수비대');
  assert.equal(w.notification.options.data.url, '/#home');
});
test('notification clicks focus/navigate existing same-origin windows or open a new safe app window', async () => {
  const w = worker();
  await w.dispatch('notificationclick', { notification: { close() {}, data: { url: '/#missions' } } });
  assert.equal(w.navigation, 'https://salary.example/#missions');
  assert.equal(w.focused, true);
  assert.equal(w.opened, undefined);
  w.windows.length = 0;
  await w.dispatch('notificationclick', { notification: { close() {}, data: { url: 'javascript:alert(1)' } } });
  assert.equal(w.opened, 'https://salary.example/#home');
});
