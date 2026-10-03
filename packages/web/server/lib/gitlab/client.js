import { Gitlab } from '@gitbeaker/rest';
import { isPlainObject, isString } from './validation.js';

// GitBeaker's bundled requester follows redirects with the credential header
// attached and re-sends every request, mutations included, after 429 and 502.
// This requester keeps GitBeaker's request and response shapes but never
// follows a redirect, and retries only reads: a write answered by a 502 may
// already be applied, so it surfaces to the durable executor instead.
const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;

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

async function parseBody(response, asStream) {
  if (asStream) return response.body;
  if (response.status === 204) return null;
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (contentType === 'application/json') return (await response.json()) || {};
  if (contentType.startsWith('text/')) return (await response.text()) || '';
  return response.blob();
}

async function requestError(request, response) {
  const content = await response.text().catch(() => '');
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
  return new Error(description || `GitLab request failed with status ${response.status}`, {
    cause: { description, request, response },
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
        const request = new Request(url, { method, headers, body: payload, signal, redirect: 'error' });
        const response = await fetchImpl(request);
        if (response.ok) {
          return { body: await parseBody(response, asStream), headers: Object.fromEntries(response.headers.entries()), status: response.status };
        }
        if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await requestError(request, response);
        await response.body?.cancel().catch(() => {});
        await delay(2 ** attempt * 250);
      }
    };
    return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete']
      .map((method) => [method, (endpoint, options) => send(method.toUpperCase(), endpoint, options)]));
  };
}

export function createGitLabClient({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }) {
  const requesterFn = createRequesterFn(fetchImpl);
  return tokenType === 'oauth'
    ? new Gitlab({ host: origin, oauthToken: token, requesterFn })
    : new Gitlab({ host: origin, token, requesterFn });
}
