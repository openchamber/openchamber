import { isPlainObject, isString } from '../shared/guards.js';

/**
 * Gitea's REST API v1 over fetch. The token goes in an `Authorization:
 * token <pat>` header, only ever to `<origin>/api/v1/...`:
 * - redirects are never followed (`redirect: 'manual'`); a redirect answer
 *   is an error, so the header cannot be replayed to another address;
 * - every URL is built from the instance origin and checked against it;
 * - reads retry after 429 and 502, writes are sent once: a write answered by
 *   a 502 may already be applied, so it surfaces to the durable executor.
 */

const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const defaultDelay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A failure with Gitea's HTTP status (when it answered) and a failure kind. */
export class GiteaRequestError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'GiteaRequestError';
    this.kind = kind;
    if (status !== null) this.status = status;
  }
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/** `unreachable`, `temporarily-unavailable`, `invalid-token`, `provider-error`. */
export function classifyGiteaFailure(error) {
  if (isString(error?.kind) && error instanceof GiteaRequestError) return error.kind;
  const code = isString(error?.code) ? error.code : isString(error?.cause?.code) ? error.cause.code : '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || NETWORK_CODES.has(code) || code.startsWith('ERR_TLS')) {
    return 'unreachable';
  }
  return 'provider-error';
}

const kindOfStatus = (status) => {
  if (status === 401) return 'invalid-token';
  if (status === 429 || status >= 500) return 'temporarily-unavailable';
  return 'provider-error';
};

async function errorFromResponse(response, label) {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    const payload = JSON.parse(text);
    if (isPlainObject(payload) && isString(payload.message)) message = payload.message;
  } catch {
    message = '';
  }
  return new GiteaRequestError(kindOfStatus(response.status), message || `${label} request failed with status ${response.status}`, response.status);
}

/** `rel="next"` in a Link header. */
const hasNextLink = (link) => isString(link) && /<[^>]+>\s*;\s*rel="?next"?/i.test(link);

/**
 * Reads answer the parsed JSON body (text for `text`, null for 204). `page`
 * reads one page with `hasMore` from Gitea's `Link` header, or from
 * `x-total-count` when there is none. `label` names the server in the errors
 * a person reads (Gitea, Forgejo).
 */
export function createGiteaClient({
  origin,
  token,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = defaultDelay,
  label = 'Gitea',
}) {
  const base = new URL(origin);
  if (base.origin !== origin) throw new Error(`${label} client needs a normalized instance origin`);
  const apiRoot = `${origin}/api/v1/`;

  const urlOf = (path, query) => {
    const relative = String(path).replace(/^\/+/, '');
    const url = new URL(relative, apiRoot);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/v1/')) {
      throw new GiteaRequestError('provider-error', `${label} request path leaves the instance API`);
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  };

  const send = async (method, path, { query, body, responseType = 'json' } = {}) => {
    const url = urlOf(path, query);
    const headers = { accept: responseType === 'json' ? 'application/json' : '*/*' };
    if (token) headers.authorization = `token ${token}`;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const attempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(url.toString(), { method, headers, body: payload, redirect: 'manual', signal: controller.signal });
        // Node answers a manual redirect with its 3xx; a browser-like fetch with an opaque one.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel().catch(() => {});
          throw new GiteaRequestError('provider-error', `${label} answered with a redirect; requests stay on the instance`, response.status || 502);
        }
        if (response.ok) {
          const result = { status: response.status, headers: response.headers };
          if (response.status === 204) return { ...result, body: null };
          if (responseType === 'text') return { ...result, body: await response.text() };
          const text = await response.text();
          return { ...result, body: text ? JSON.parse(text) : null };
        }
        if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await errorFromResponse(response, label);
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (error instanceof GiteaRequestError || error instanceof SyntaxError) throw error;
        if (attempt >= attempts) throw error;
      } finally {
        clearTimeout(timer);
      }
      await delay(2 ** attempt * 250);
    }
  };

  const page = async (path, query, { page: number = 1, limit = 50 } = {}) => {
    const response = await send('GET', path, { query: { ...query, page: number, limit } });
    if (!Array.isArray(response.body)) throw new GiteaRequestError('provider-error', `${label} returned an invalid list`);
    const total = Number.parseInt(response.headers.get('x-total-count') ?? '', 10);
    const link = response.headers.get('link');
    const hasMore = link !== null
      ? hasNextLink(link)
      : Number.isInteger(total) ? number * limit < total : response.body.length >= limit;
    return { items: response.body, hasMore, total: Number.isInteger(total) ? total : null };
  };

  return Object.freeze({
    get: async (path, query) => (await send('GET', path, { query })).body,
    text: async (path, query) => (await send('GET', path, { query, responseType: 'text' })).body,
    post: async (path, body) => (await send('POST', path, { body })).body,
    patch: async (path, body) => (await send('PATCH', path, { body })).body,
    put: async (path, body) => (await send('PUT', path, { body })).body,
    delete: async (path, body) => (await send('DELETE', path, { body })).body,
    page,
    /**
     * Every page of a collection up to `maxItems`; past it the read fails
     * instead of passing a capped list off as complete.
     */
    collection: async (path, query, { limit = 50, maxItems = 2000, message = `${label} list is longer than OpenChamber reads` } = {}) => {
      const items = [];
      for (let number = 1; ; number += 1) {
        const result = await page(path, query, { page: number, limit });
        items.push(...result.items);
        if (!result.hasMore || result.items.length === 0) return items;
        if (items.length >= maxItems) throw new GiteaRequestError('provider-error', message);
      }
    },
  });
}
