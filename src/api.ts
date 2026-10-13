import { validateState } from '../shared/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, StateResponse, User } from '../shared/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, signal, credentials: 'same-origin', headers: { 'X-Requested-With': 'salary-guardians', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || '요청을 처리하지 못했어요.', response.status);
  return payload;
}
type Cached = StateResponse & { pending: boolean };
const storageKey = (id: string) => `salary-guardians:state:${id}`;
export function cachedIdentity(): User | null {
  try { return JSON.parse(localStorage.getItem('salary-guardians:user') || 'null'); } catch { return null; }
}
export function saveIdentity(user: User | null) {
  if (user) localStorage.setItem('salary-guardians:user', JSON.stringify(user));
  else localStorage.removeItem('salary-guardians:user');
}
export function clearCache(id: string) { localStorage.removeItem(storageKey(id)); saveIdentity(null); }
function readCache(id: string): Cached | null {
  try { return JSON.parse(localStorage.getItem(storageKey(id)) || 'null'); } catch { return null; }
}
export function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
export function useFinance(user: User) {
  const cached = useRef(readCache(user.id));
  const [state, setState] = useState<AppState | null>(cached.current?.state || null);
  const [status, setStatus] = useState<'loading' | 'saved' | 'pending' | 'conflict' | 'error'>(cached.current?.pending ? 'pending' : 'loading');
  const [error, setError] = useState('');
  const latest = useRef<Cached | null>(cached.current);
  const writing = useRef(false);
  const stopped = useRef(false);
  const epoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const persist = useCallback((value: Cached) => {
    latest.current = value;
    localStorage.setItem(storageKey(user.id), JSON.stringify(value));
    setState(value.state);
  }, [user.id]);
  const flush = useCallback(async () => {
    if (writing.current || stopped.current || !latest.current?.pending) return;
    writing.current = true;
    const generation = epoch.current;
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      while (generation === epoch.current && latest.current?.pending) {
        const attempt = latest.current;
        const result = await api<StateResponse>('/state', { state: attempt.state, revision: attempt.revision, userId: user.id }, 'PUT', controller.signal);
        if (generation !== epoch.current) return;
        const changed = latest.current.state !== attempt.state;
        const canonicalTimes = new Map(result.state.expenses.map(expense => [expense.id, expense.createdAt]));
        const nextState = changed ? { ...latest.current.state, expenses: latest.current.state.expenses.map(expense => canonicalTimes.has(expense.id) ? { ...expense, createdAt: canonicalTimes.get(expense.id)! } : expense) } : result.state;
        persist({ state: nextState, revision: result.revision, pending: changed });
      }
      if (generation === epoch.current) { setStatus('saved'); setError(''); }
    } catch (reason) {
      if (generation !== epoch.current || controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 409) {
        stopped.current = true; setStatus('conflict'); setError('다른 기기에서 기록이 바뀌었어요. 이 기기의 기록을 내보낸 뒤 서버 기록을 불러오세요. 자동으로 덮어쓰지 않아요.');
      } else if (reason instanceof ApiError) {
        stopped.current = true; setStatus('error'); setError(reason.message);
      } else { setStatus('pending'); setError('기기에 안전하게 저장했어요. 연결되면 서버에 동기화해요.'); }
    } finally { controllers.current.delete(controller); if (generation === epoch.current) writing.current = false; }
  }, [persist, user.id]);
  const reload = useCallback(async (discardPending = false) => {
    const generation = epoch.current;
    const before = latest.current;
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const result = await api<StateResponse>('/state', undefined, 'GET', controller.signal);
      if (generation !== epoch.current) return;
      if (!discardPending && (latest.current !== before || latest.current?.pending)) { void flush(); return; }
      stopped.current = false; persist({ ...result, pending: false }); setStatus('saved'); setError('');
    } catch (reason) {
      if (generation !== epoch.current || controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : '서버를 연결할 수 없어요.'); setStatus(latest.current ? 'pending' : 'error');
    } finally { controllers.current.delete(controller); }
  }, [persist, flush]);
  useEffect(() => {
    epoch.current += 1; writing.current = false;
    if (latest.current?.pending) void flush(); else void reload();
    const onOnline = () => { if (latest.current?.pending) void flush(); else if (!latest.current) void reload(); }; window.addEventListener('online', onOnline);
    return () => { epoch.current += 1; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); window.removeEventListener('online', onOnline); };
  }, [flush, reload]);
  const mutate = useCallback((next: AppState | ((state: AppState) => AppState)) => {
    if (!latest.current) return;
    const nextState = typeof next === 'function' ? next(latest.current.state) : next;
    const errors = validateState(nextState); if (errors.length) { setError(errors[0]); return; }
    persist({ ...latest.current, state: nextState, pending: true });
    if (!stopped.current) { setStatus('pending'); void flush(); }
  }, [flush, persist]);
  return { state, status, error, mutate, reload, flush, stop: () => { epoch.current += 1; stopped.current = true; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }, exportLocal: () => downloadJSON({ state: latest.current?.state, revision: latest.current?.revision, pending: latest.current?.pending, exportedAt: new Date().toISOString() }, '월급수비대-기기기록.json') };
}
