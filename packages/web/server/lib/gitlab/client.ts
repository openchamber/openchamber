import { Gitlab } from '@gitbeaker/rest';
import { isPlainObject, isString } from './validation.js';
import type { SourceControlJson } from '@openchamber/sdk';
import type { JsonValue } from '../shared/json-values.js';

type RequestValue = JsonValue | Date | undefined | RequestValue[] | RequestFields;
interface RequestFields { [key: string]: RequestValue }

export interface GitLabClientOptions {
  origin: string;
  token: string | undefined;
  tokenType?: 'token' | 'oauth';
  fetch?: (request: Request) => Promise<Response>;
}

export interface GitLabRequesterService {
  headers: Record<string, string>;
  authHeaders?: Record<string, () => Promise<string>>;
  url: string;
}

export interface GitLabRequesterOptions {
  body?: FormData | RequestFields;
  searchParams?: RequestFields;
  sudo?: string | number;
  signal?: AbortSignal;
  asStream?: boolean;
}

export type GitLabRequester = ReturnType<ReturnType<typeof createRequesterFn>>;

interface RequestErrorBody {
  error?: SourceControlJson;
  message?: SourceControlJson;
}

const hasErrorFields = (value: unknown): value is RequestErrorBody => value != null;

const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;

const decamelize = (key: string) => key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

function decamelizeKeys(value: RequestFields): RequestFields;
function decamelizeKeys(value: RequestValue): RequestValue;
function decamelizeKeys(value: RequestValue): RequestValue {
  if (Array.isArray(value)) return value.map(decamelizeKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [decamelize(key), decamelizeKeys(item)]));
}

function appendQuery(params: string[], key: string, value: RequestValue) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, `${key}[]`, item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item);
    return;
  }
  params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value instanceof Date ? value.toISOString() : `${value ?? ''}`)}`);
}

function formatQuery(searchParams?: RequestFields) {
  const params: string[] = [];
  for (const [key, value] of Object.entries(decamelizeKeys(searchParams ?? {}))) appendQuery(params, key, value);
  return params.join('&');
}

async function parseBody(response: Response, asStream: boolean): Promise<JsonValue | Blob | ReadableStream<Uint8Array> | null> {
  if (asStream) return response.body;
  if (response.status === 204) return null;
  const contentType = ((response.headers.get('content-type') || '').split(';')[0] ?? '').trim();
  if (contentType === 'application/json') {
    const payload: SourceControlJson = await response.json();
    return payload || {};
  }
  if (contentType.startsWith('text/')) return (await response.text()) || '';
  return response.blob();
}

async function requestError(request: Request, response: Response) {
  const content = await response.text().catch(() => '');
  let description: string | undefined = content;
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    try {
      const payload: SourceControlJson = JSON.parse(content);
      const detail = (hasErrorFields(payload) && (payload.error || payload.message)) || '';
      description = isString(detail) ? detail : JSON.stringify(detail);
    } catch {
      description = content;
    }
  }
  return new Error(description || `GitLab request failed with status ${response.status}`, {
    cause: { description, request, response },
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function createRequesterFn(fetchImpl: NonNullable<GitLabClientOptions['fetch']>) {
  return (serviceOptions: GitLabRequesterService) => {
    const send = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, { body, searchParams, sudo, signal, asStream = false }: GitLabRequesterOptions = {}) => {
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
        const request = new Request(url, { method, headers, body: payload ?? null, signal: signal ?? null, redirect: 'error' });
        const response = await fetchImpl(request);
        if (response.ok) {
          return { body: await parseBody(response, asStream), headers: Object.fromEntries(response.headers.entries()), status: response.status };
        }
        if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await requestError(request, response);
        await response.body?.cancel().catch(() => {});
        await delay(2 ** attempt * 250);
      }
    };
    const requester = (method: Parameters<typeof send>[0]) => (endpoint: string, options?: GitLabRequesterOptions) => send(method, endpoint, options);
    return { get: requester('GET'), post: requester('POST'), put: requester('PUT'), patch: requester('PATCH'), delete: requester('DELETE') };
  };
}

export interface GitLabDownloadOptions {
  range?: string | undefined;
  signal?: AbortSignal | undefined;
}

export function createGitLabDownloader({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }: GitLabClientOptions) {
  const credential: Record<string, string> = tokenType === 'oauth' ? { authorization: `Bearer ${token}` } : { 'private-token': token === undefined ? 'undefined' : token };
  return async (apiPath: string, { range, signal }: GitLabDownloadOptions = {}) => {
    const headers: Record<string, string> = range ? { range } : {};
    const url = new URL(`api/v4/${apiPath}`, `${origin}/`);
    const response = await fetchImpl(new Request(url, { headers: { ...headers, ...credential }, redirect: 'manual', signal: signal ?? null }));
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    const next = location ? new URL(location, url) : null;
    if (!next || (next.protocol !== 'https:' && next.origin !== url.origin)) {
      throw new Error('GitLab redirected the file to an address it may not be read from');
    }
    return fetchImpl(new Request(next, { headers, redirect: 'error', signal: signal ?? null }));
  };
}

export function createGitLabClient({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }: GitLabClientOptions): Gitlab {
  const requesterFn = createRequesterFn(fetchImpl);
  return tokenType === 'oauth'
    ? new Gitlab({ host: origin, oauthToken: token, requesterFn })
    : new Gitlab({ host: origin, token, requesterFn });
}
