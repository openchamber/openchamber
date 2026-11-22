import { Gitlab } from '@gitbeaker/rest';
import { readBoundedResponseBytes, readBoundedResponseText } from '../shared/response-body.js';
import { isPlainObject, isString } from './validation.js';

// GitBeaker's bundled requester follows redirects with the credential header
// attached and re-sends every request, mutations included, after 429 and 502.
// This requester keeps GitBeaker's request and response shapes but never
// follows a redirect, and retries only reads: a write answered by a 502 may
// already be applied, so it surfaces to the durable executor instead.
const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;
// Every request carries this per-attempt deadline, combined with the signal
// the caller supplied (the downloader disconnect signal, or the one
// GitBeaker builds from its queryTimeout). A self-managed instance that
// accepts a connection and then stalls otherwise hangs a request for
// GitBeaker's five-minute default, and the downloader without any bound.
// The module's other fetches use the same 10s bound (network.js).
const GITLAB_REQUEST_TIMEOUT_MS = 10_000;
// The error surface only ever shows a short excerpt, so the error body
// read is capped well above the excerpt instead of buffering the whole
// answer from a user-configured, possibly self-managed instance.
const ERROR_DETAIL_MAX_BYTES = 1_024;
const ERROR_DETAIL_EXCERPT_CHARS = 200;
// Success answers are read whole and parsed, so that read is capped
// while it streams in instead of buffering an unbounded answer from a
// user-configured, possibly self-managed instance. The callers are
// paginated (perPage <= 100) list and detail answers plus
// RepositoryFiles.showRaw raw files, which fit comfortably under
// 16 MiB, and the cap matches the 16 MiB bound the models.dev and npm
// success reads set under #1006.
const SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024;

const decamelize = (key) => key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

function decamelizeKeys(value) {
  if (Array.isArray(value)) return value.map(decamelizeKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [decamelize(key), decamelizeKeys(item)]));
}

function appendQuery(params, key, value) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, `${key}[]`, item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item);
    return;
  }
  params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value instanceof Date ? value.toISOString() : value ?? '')}`);
}

function formatQuery(searchParams) {
  const params = [];
  for (const [key, value] of Object.entries(decamelizeKeys(searchParams ?? {}))) appendQuery(params, key, value);
  return params.join('&');
}

const successBodyTooLarge = () => Object.assign(
  new Error(`GitLab response exceeded ${SUCCESS_BODY_MAX_BYTES} bytes`),
  { code: 'response_too_large' },
);

async function parseBody(response, asStream) {
  if (asStream) return response.body;
  if (response.status === 204) return null;
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (contentType === 'application/json' || contentType.startsWith('text/')) {
    const read = await readBoundedResponseText(response, SUCCESS_BODY_MAX_BYTES);
    if (read.tooLarge) throw successBodyTooLarge();
    // Response.json()/text() strip a leading UTF-8 BOM; the bounded
    // reader does not, so strip it here to keep the values callers
    // see unchanged.
    const text = read.text.replace(/^\uFEFF/, '');
    if (contentType === 'application/json') return JSON.parse(text) || {};
    return text || '';
  }
  const read = await readBoundedResponseBytes(response, SUCCESS_BODY_MAX_BYTES);
  if (read.tooLarge) throw successBodyTooLarge();
  return new Blob([read.bytes], { type: response.headers.get('content-type') || '' });
}

async function requestError(request, response) {
  const read = await readBoundedResponseText(response, ERROR_DETAIL_MAX_BYTES)
    .catch(() => ({ tooLarge: true }));
  const content = read.tooLarge ? '' : read.text;
  let description = content;
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    try {
      const payload = JSON.parse(content);
      const detail = payload?.error || payload?.message || '';
      description = isString(detail) ? detail : JSON.stringify(detail);
    } catch {
      description = content;
    }
  }
  description = (description || '').slice(0, ERROR_DETAIL_EXCERPT_CHARS);
  return new Error(description || `GitLab request failed with status ${response.status}`, {
    cause: { description, request, response },
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The deadline aborts through its own controller, so a stall rejects with
// an AbortError, which classifyGitLabFailure (network.js) maps to
// unreachable. A caller abort arrives through the combined signal with
// timedOut() false, so the two stay distinguishable for the retry policy.
function deadlineSignal(callerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, GITLAB_REQUEST_TIMEOUT_MS);
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => { clearTimeout(timer); },
  };
}

// One fetch bounded by the deadline. The bound covers the call itself,
// which for the downloader means the wait for response headers: the body
// it returns streams to the route caller without the deadline running.
async function fetchOnceWithDeadline(fetchImpl, url, init, callerSignal) {
  const deadline = deadlineSignal(callerSignal);
  try {
    return await fetchImpl(new Request(url, { ...init, signal: deadline.signal }));
  } finally {
    deadline.clear();
  }
}

function createRequesterFn(fetchImpl) {
  return (serviceOptions) => {
    const send = async (method, endpoint, { body, searchParams, sudo, signal, asStream = false } = {}) => {
      const headers = { ...serviceOptions.headers };
      if (sudo) headers.sudo = `${sudo}`;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body) {
        payload = JSON.stringify(decamelizeKeys(body));
        headers['content-type'] = 'application/json';
      }
      const [authHeader] = Object.entries(serviceOptions.authHeaders ?? {});
      if (authHeader) headers[authHeader[0]] = await authHeader[1]();
      const url = new URL(endpoint, serviceOptions.url.endsWith('/') ? serviceOptions.url : `${serviceOptions.url}/`);
      url.search = formatQuery(searchParams);
      const attempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
      for (let attempt = 1; ; attempt += 1) {
        const deadline = deadlineSignal(signal);
        try {
          const request = new Request(url, { method, headers, body: payload, signal: deadline.signal, redirect: 'error' });
          const response = await fetchImpl(request);
          if (response.ok) {
            return { body: await parseBody(response, asStream), headers: Object.fromEntries(response.headers.entries()), status: response.status };
          }
          if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await requestError(request, response);
          await response.body?.cancel().catch(() => {});
        } catch (error) {
          // A deadline abort retries like a 429/502 for reads and surfaces
          // for mutations, which are sent once. A caller abort has
          // timedOut() false and surfaces at once for every method.
          if (!deadline.timedOut() || attempt >= attempts) throw error;
        } finally {
          deadline.clear();
        }
        await delay(2 ** attempt * 250);
      }
    };
    return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete']
      .map((method) => [method, (endpoint, options) => send(method.toUpperCase(), endpoint, options)]));
  };
}

/**
 * A file read from the instance's API, for the bytes GitBeaker would buffer.
 * The credential goes to the instance only: a redirect (object storage hands
 * out signed URLs) is followed once, without it, and only over HTTPS or on
 * the instance itself. A `Range` header passes through for video seeking.
 */
export function createGitLabDownloader({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }) {
  const credential = tokenType === 'oauth' ? { authorization: `Bearer ${token}` } : { 'private-token': token };
  return async (apiPath, { range, signal } = {}) => {
    const headers = range ? { range } : {};
    const url = new URL(`api/v4/${apiPath}`, `${origin}/`);
    const response = await fetchOnceWithDeadline(fetchImpl, url, { headers: { ...headers, ...credential }, redirect: 'manual' }, signal);
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    const next = location ? new URL(location, url) : null;
    if (!next || (next.protocol !== 'https:' && next.origin !== url.origin)) {
      throw new Error('GitLab redirected the file to an address it may not be read from');
    }
    return fetchOnceWithDeadline(fetchImpl, next, { headers, redirect: 'error' }, signal);
  };
}

export function createGitLabClient({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }) {
  const requesterFn = createRequesterFn(fetchImpl);
  return tokenType === 'oauth'
    ? new Gitlab({ host: origin, oauthToken: token, requesterFn })
    : new Gitlab({ host: origin, token, requesterFn });
}
