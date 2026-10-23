import { assertBotWriteAllowed } from '../../enterprise-mode.js';
import { BotServiceError } from './contracts.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Fixed-origin, bounded requests. Provider bodies never enter errors or logs. */
export function createProviderHttp({ fetchImpl = fetch, policyOptions, timeoutMs = 15_000 } = {}) {
  return async ({ service, origin, resource, path, authorization, method = 'GET', body, beforeWrite, readOnly = false }) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || url.hash
      || url.username || url.password || url.protocol !== 'https:') {
      throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'The provider destination is invalid.', 'failed', 400);
    }
    const write = method !== 'GET' && !readOnly;
    if (write) {
      await beforeWrite?.();
      try { assertBotWriteAllowed({ service, origin, resource }, policyOptions); }
      catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot destination.', 'needs-you', 403); }
    }
    let response;
    try {
      const options = {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: authorization, Accept: 'application/json',
          'Content-Type': 'application/json', 'User-Agent': 'OpenChamber-Bots',
        },
      };
      if (service === 'github') options.headers['X-GitHub-Api-Version'] = '2026-03-10';
      if (body !== undefined) options.body = JSON.stringify(body);
      response = await fetchImpl(url.href, options);
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new BotServiceError('BOT_SERVICE_REDIRECT', 'The provider refused the fixed destination.', write ? 'outcome-unknown' : 'needs-you');
      }
      if (!response.ok) {
        await response.body?.cancel();
        const auth = response.status === 401 || response.status === 403;
        throw new BotServiceError(auth ? 'BOT_SERVICE_AUTH_REQUIRED' : 'BOT_SERVICE_REJECTED',
          auth ? 'Reconnect or authorize the selected bot identity.' : 'The provider refused the bot operation.',
          auth ? 'needs-you' : response.status >= 500 && write ? 'outcome-unknown' : 'failed', response.status);
      }
      if (response.status === 204) return null;
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof BotServiceError) throw error;
      throw new BotServiceError('BOT_SERVICE_UNAVAILABLE', 'The provider response is unavailable.', write ? 'outcome-unknown' : 'needs-you', 502);
    }
  };
}
