import { handleApiRequest } from './api';
import { withSecurityHeaders } from './security';
import { runPushCron } from './cron';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await handleApiRequest(request, env);
      if (response) return response;
      const asset = await env.ASSETS.fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
      });
      return withSecurityHeaders(asset as unknown as Response, new URL(request.url));
    } catch {
      // Do not expose database statements, keys or subscription endpoints.
      console.error(JSON.stringify({ event: 'api_error', message: 'Request failed.' }));
      return withSecurityHeaders(Response.json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 500 }), new URL(request.url), true);
    }
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try { await runPushCron(env); }
    catch {
      console.error(JSON.stringify({ event: 'push_cron_error', message: 'Scheduled delivery failed; inspect configuration and D1 availability.' }));
      // A rejected scheduled event must remain observable as failed.
      throw new Error('Scheduled delivery failed.');
    }
  },
};
