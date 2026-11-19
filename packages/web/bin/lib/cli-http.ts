import { buildLocalUrl } from './cli-network.js';
import { readDesktopLocalClientTokenFromSettings, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import type { CliOptions } from './cli-args.js';

export interface JsonRequestOptions extends Pick<Partial<CliOptions>, 'explicitUiPassword' | 'uiPassword'> {
  timeoutMs?: number;
  method?: string;
  headers?: JsonRequestHeaders;
  body?: string;
}

export interface JsonRequestHeaders {
  [name: string]: string;
  Authorization?: string;
  authorization?: string;
}

export interface HealthWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (tick: { elapsedMs: number; timeoutMs: number; complete?: boolean; timedOut?: boolean }) => void;
}

interface CookieHeaders {
  get?: (name: string) => string | null;
  getSetCookie?: () => string[];
  raw?: () => { 'set-cookie'?: unknown };
}

interface ContentTypeHeader {
  'Content-Type'?: string;
}

function isHttpText(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteHttpNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function isHttpFailure(value: unknown): value is { name?: unknown; code?: unknown } {
  return Boolean(value);
}

const UI_SESSION_COOKIE_NAME = 'oc_ui_session';
const UI_SESSION_COOKIE_PATTERN = new RegExp(`(?:^|,\\s*)(${UI_SESSION_COOKIE_NAME}(?:_\\d+)?=[^;]+)`);

function extractUiSessionCookie(response: { headers: CookieHeaders }) {
  const values = [];
  const direct = response?.headers?.get?.('set-cookie');
  if (direct !== null && direct !== undefined && direct.length > 0) {
    values.push(direct);
  }
  const getSetCookie = response?.headers?.getSetCookie;
  if (getSetCookie !== undefined) {
    const setCookies = getSetCookie.call(response.headers);
    if (Array.isArray(setCookies)) {
      values.push(...setCookies.filter((value) => isHttpText(value) && value.length > 0));
    }
  }
  const raw = response?.headers?.raw?.();
  if (Array.isArray(raw?.['set-cookie'])) {
    values.push(...raw['set-cookie'].filter((value) => isHttpText(value) && value.length > 0));
  }

  for (const setCookie of values) {
    const match = setCookie.match(UI_SESSION_COOKIE_PATTERN);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function resolveUiPasswordForPort(port: number, options: JsonRequestOptions = {}) {
  if (options.explicitUiPassword && options.uiPassword !== undefined && options.uiPassword.trim().length > 0) {
    return options.uiPassword;
  }
  const instanceOptions = readInstanceOptions(await getInstanceFilePath(port));
  if (isHttpText(instanceOptions?.uiPassword) && instanceOptions.uiPassword.trim().length > 0) {
    return instanceOptions.uiPassword;
  }
  return options.uiPassword !== undefined && options.uiPassword.trim().length > 0
    ? options.uiPassword
    : null;
}

async function createUiSessionCookie(port: number, password: string | null, timeoutMs: number) {
  if (password === null || password.length === 0) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildLocalUrl(port, '/auth/session'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return extractUiSessionCookie(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getDesktopLocalAuthHeader(port: number, requestHeaders: JsonRequestHeaders) {
  if (requestHeaders.Authorization || requestHeaders.authorization) {
    return null;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  if (desktopPort !== port) {
    return null;
  }
  const token = readDesktopLocalClientTokenFromSettings();
  return token ? `Bearer ${token}` : null;
}

async function requestServerShutdown(port: number, hostOverride?: string) {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(buildLocalUrl(port, '/api/system/shutdown', hostOverride), {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(port: number, endpoint: string, options: JsonRequestOptions = {}) {
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 4000;
  const { method, headers, body: requestBody } = options;
  const fetchOptions: RequestInit = {};
  if (method !== undefined) fetchOptions.method = method;
  if (requestBody !== undefined) fetchOptions.body = requestBody;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestUrl = buildLocalUrl(port, endpoint);
    const contentTypeHeader: ContentTypeHeader = {};
    if (requestBody) contentTypeHeader['Content-Type'] = 'application/json';
    const requestHeaders: JsonRequestHeaders = {
      Accept: 'application/json',
      ...contentTypeHeader,
      ...(headers || {}),
    };
    const desktopAuth = getDesktopLocalAuthHeader(port, requestHeaders);
    if (desktopAuth) {
      requestHeaders.Authorization = desktopAuth;
    }
    const response = await fetch(requestUrl, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (response.status === 401 && body?.error === 'UI authentication required') {
      const uiPassword = await resolveUiPasswordForPort(port, options);
      const cookie = await createUiSessionCookie(port, uiPassword, timeoutMs);
      if (cookie) {
        const retryResponse = await fetch(requestUrl, {
          ...fetchOptions,
          headers: {
            ...requestHeaders,
            Cookie: cookie,
          },
          signal: controller.signal,
        });
        const retryBody = await retryResponse.json().catch(() => null);
        return { response: retryResponse, body: retryBody };
      }
    }
    return { response, body };
  } catch (error) {
    if (isHttpFailure(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function isServerHealthReady(port: number, timeoutMs = 1000) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(buildLocalUrl(port, '/health'), {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerHealth(port: number, {
  timeoutMs = 60000,
  intervalMs = 250,
  onTick,
}: HealthWaitOptions = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - start;
    if (onTick !== undefined) {
      onTick({ elapsedMs, timeoutMs });
    }
    if (await isServerHealthReady(port, Math.min(1000, intervalMs * 2))) {
      if (onTick !== undefined) {
        onTick({ elapsedMs: Math.min(Date.now() - start, timeoutMs), timeoutMs, complete: true });
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (onTick !== undefined) {
    onTick({ elapsedMs: timeoutMs, timeoutMs, timedOut: true });
  }
  return false;
}


async function fetchTunnelProvidersFromPort(port: number, fetchImpl = globalThis.fetch) {
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/openchamber/tunnel/providers'));
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body) return null;
    const providers: unknown = body.providers;
    if (!Array.isArray(providers)) return null;
    return providers;
  } catch {
    return null;
  }
}

async function fetchSystemInfoFromPort(port: number, fetchImpl = globalThis.fetch, hostOverride?: string) {
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/system/info', hostOverride), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body) return null;
    const runtime: unknown = body.runtime;
    if (!isHttpText(runtime)) return null;
    const pid: unknown = body.pid;

    return {
      runtime,
      pid: isFiniteHttpNumber(pid) ? pid : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


export {
  requestServerShutdown,
  requestJson,
  isServerHealthReady,
  waitForServerHealth,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
};
