import { isString } from '../shared/guards.js';

/**
 * Gerrit's REST API over fetch.
 *
 * - With a login and an HTTP password every request goes to
 *   `<origin>/a/...` with `Authorization: Basic`; without them (the version
 *   probe) to `<origin>/...` with no credentials. Gerrit serves only the
 *   `/a/` paths authenticated.
 * - Redirects are never followed (`redirect: 'manual'`); a redirect answer is
 *   an error, so the header cannot be replayed to another address.
 * - Every URL is built from the instance origin and checked against it.
 * - JSON bodies start with the `)]}'` line Gerrit adds against XSSI; it is
 *   stripped before parsing. Text bodies (patches, file contents) are base64.
 * - Errors are plain-text bodies, or JSON with an `error` field, and become
 *   `{ status, message }`.
 * - Reads retry after 429 and 502; writes are sent once: a write answered by
 *   a 502 may already be applied, so it surfaces to the durable executor.
 */

const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_MESSAGE = 500;
const XSSI_PREFIX = /^\)\]\}'[^\n]*\n?/;
const defaultDelay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A failure with Gerrit's HTTP status (when it answered) and a failure kind. */
export class GerritRequestError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'GerritRequestError';
    this.kind = kind;
    if (status !== null) this.status = status;
  }
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/** `unreachable`, `temporarily-unavailable`, `invalid-token`, `provider-error`. */
export function classifyGerritFailure(error) {
  if (error instanceof GerritRequestError) return error.kind;
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

/**
 * Gerrit words most refusals as plain text (`change is not work in progress`).
 * A few answer JSON with an `error` field (3.10 refuses an unknown reviewer
 * with a 400 `ReviewerResult`); that field is the message.
 */
function errorText(body) {
  const text = body.replace(XSSI_PREFIX, '').trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text);
    return isString(parsed?.error) && parsed.error.trim() ? parsed.error.trim() : text;
  } catch {
    return text;
  }
}

async function errorFromResponse(response) {
  const text = errorText(await response.text().catch(() => ''));
  const message = text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
  return new GerritRequestError(kindOfStatus(response.status), message || `Gerrit request failed with status ${response.status}`, response.status);
}

/** The body of a JSON answer, without the XSSI line. */
function parseGerritJson(text) {
  const stripped = String(text).replace(XSSI_PREFIX, '');
  return stripped.trim() ? JSON.parse(stripped) : null;
}

/** Each query value; an array repeats the key (`o=LABELS&o=MESSAGES`). */
const appendQuery = (url, query) => {
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry === undefined || entry === null || entry === '') continue;
      url.searchParams.append(key, String(entry));
    }
  }
};

export function createGerritClient({
  origin,
  login = null,
  password = null,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = defaultDelay,
}) {
  const base = new URL(origin);
  if (base.origin !== origin) throw new Error('Gerrit client needs a normalized instance origin');
  const authenticated = isString(login) && Boolean(login) && isString(password) && Boolean(password);
  const prefix = authenticated ? '/a/' : '/';
  const root = `${origin}${prefix}`;
  const authorization = authenticated ? `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}` : null;

  const urlOf = (path, query) => {
    const relative = String(path).replace(/^\/+/, '');
    const url = new URL(relative, root);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || (!authenticated && url.pathname.startsWith('/a/'))) {
      throw new GerritRequestError('provider-error', 'Gerrit request path leaves the instance API');
    }
    appendQuery(url, query);
    return url;
  };

  const send = async (method, path, { query, body, responseType = 'json' } = {}) => {
    const url = urlOf(path, query);
    const headers = { accept: responseType === 'json' ? 'application/json' : 'text/plain' };
    if (authorization) headers.authorization = authorization;
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
          throw new GerritRequestError('provider-error', 'Gerrit answered with a redirect; requests stay on the instance', response.status || 502);
        }
        if (response.ok) {
          if (response.status === 204) return null;
          const text = await response.text();
          if (responseType === 'text') return text;
          return parseGerritJson(text);
        }
        if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await errorFromResponse(response);
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (error instanceof GerritRequestError || error instanceof SyntaxError) throw error;
        if (attempt >= attempts) throw error;
      } finally {
        clearTimeout(timer);
      }
      await delay(2 ** attempt * 250);
    }
  };

  /**
   * One page of a list started at `start` (`S`). A change query marks its
   * last item `_more_changes: true` when more exist; other lists (branches)
   * say nothing, so a full page counts as "maybe more".
   */
  const page = async (path, query, { start = 0, limit = 25, changes = true } = {}) => {
    const items = await send('GET', path, { query: { ...query, n: limit, S: start || undefined } });
    if (!Array.isArray(items)) throw new GerritRequestError('provider-error', 'Gerrit returned an invalid list');
    const hasMore = changes ? items.at(-1)?._more_changes === true : items.length >= limit;
    return { items, hasMore };
  };

  return Object.freeze({
    get: (path, query) => send('GET', path, { query }),
    /** A base64 text answer, decoded. */
    base64: async (path, query) => {
      const text = await send('GET', path, { query, responseType: 'text' });
      if (!isString(text)) throw new GerritRequestError('provider-error', 'Gerrit returned an invalid text answer');
      return Buffer.from(text.replace(/\s+/g, ''), 'base64');
    },
    post: (path, body) => send('POST', path, { body: body ?? {} }),
    page,
  });
}
