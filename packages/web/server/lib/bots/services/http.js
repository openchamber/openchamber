import { assertBotWriteAllowed } from '../../enterprise-mode.js';
import { z } from 'zod';
import { BotServiceError, jiraOrigin, parse } from './contracts.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const providerUrl = (origin, path) => {
  const url = new URL(path, origin);
  if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || url.hash
    || url.username || url.password || url.protocol !== 'https:') {
    throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'The provider destination is invalid.', 'failed', 400);
  }
  return url;
};
const allowWrite = (destination, policyOptions) => {
  try { assertBotWriteAllowed(destination, policyOptions); }
  catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot destination.', 'needs-you', 403); }
};

/** Private bounded transport. Callers own fixed URLs and content-write admission. */
const createBoundedRequest = ({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) => {
  return async ({ url, service, authorization, method = 'GET', body, write = false, form = false }) => {
    let response;
    try {
      const options = {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json',
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'User-Agent': 'OpenChamber-Bots',
        },
      };
      if (service === 'github') options.headers['X-GitHub-Api-Version'] = '2026-03-10';
      if (body !== undefined) options.body = form ? body : JSON.stringify(body);
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
};

/** Fixed-origin, bounded requests. Provider bodies never enter errors or logs. */
export function createProviderHttp(options = {}) {
  const request = createBoundedRequest(options);
  return async ({ service, origin, resource, path, authorization, method = 'GET', body, beforeWrite, readOnly = false }) => {
    const url = providerUrl(origin, path);
    const write = method !== 'GET' && !readOnly;
    if (write) {
      await beforeWrite?.();
      allowWrite({ service, origin, resource }, options.policyOptions);
    }
    return request({ url, service, authorization, method, body, write });
  };
}

/** The shared gateway retains the verified Jira site's policy authority. */
export function createJiraOAuthHttp(options = {}) {
  const request = createBoundedRequest(options);
  return {
    readTenant: ({ site }) => request({ url: providerUrl(jiraOrigin(site), '/_edge/tenant_info') }),
    exchangeToken: ({ clientId, clientSecret }) => request({
      url: new URL('https://auth.atlassian.com/oauth/token'), method: 'POST', form: true,
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
    }),
    async request({ site, cloudId, resource, path, authorization, method = 'GET', body, beforeWrite }) {
      const origin = jiraOrigin(site);
      const tenant = parse(z.uuid(), cloudId).toLowerCase();
      const url = providerUrl('https://api.atlassian.com', `/ex/jira/${tenant}${path}`);
      if (!path.startsWith('/rest/api/3/') || path.includes('\\') || !url.pathname.startsWith(`/ex/jira/${tenant}/rest/api/3/`)) {
        throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'The Jira gateway destination is invalid.', 'failed', 400);
      }
      const write = method !== 'GET';
      if (write) {
        await beforeWrite?.();
        allowWrite({ service: 'jira', origin, resource }, options.policyOptions);
      }
      return request({ url, service: 'jira', authorization, method, body, write });
    },
  };
}
