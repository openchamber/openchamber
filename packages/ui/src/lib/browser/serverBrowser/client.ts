/**
 * Client for the built-in server browser's HTTP service.
 *
 * Every call goes through the host's guest-service proxy
 * (`proxyGuestServiceRequest`, `POST /api/guests/<id>/service/request`), which
 * is the same transport the shared-surface viewer uses, so dock-access rules
 * (only the viewer holding control may act) apply exactly as they do for the
 * agent's own browser.* tool calls. See
 * `.omo/plans/native-server-browser-contract.md` for the route list.
 */
import { proxyGuestServiceRequest } from '@/lib/guests/service';
import type { GuestRequest, GuestRequestMethod } from '@openchamber/sdk';

import type {
  ServerBrowserInspectorBatch,
  ServerBrowserRequestDetail,
  ServerBrowserState,
} from './types';

export type ServerBrowserResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly status?: number; readonly code?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Object(value) === value && !Array.isArray(value)
);

/** `state` is sent back on every gated action; a response missing it is tolerated as a hole. */
const asServerBrowserState = (value: unknown): ServerBrowserState | null => {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.scopes)) return null;
  return value as unknown as ServerBrowserState;
};

export const parseServerBrowserState = asServerBrowserState;

const call = async <T = unknown>(
  guestId: string,
  viewerId: string | undefined,
  method: GuestRequestMethod,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<ServerBrowserResult<T>> => {
  const request: GuestRequest = {
    method,
    path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  };
  const proxied = await proxyGuestServiceRequest(guestId, request, viewerId);
  if (!proxied.ok) {
    return { ok: false, error: proxied.message, code: proxied.code };
  }
  const { status, body } = proxied.result;
  let parsed: unknown = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  if (status < 200 || status >= 300) {
    const message = isRecord(parsed) && typeof parsed.error === 'string' && parsed.error
      ? parsed.error
      : `Server browser request failed (${status})`;
    const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : undefined;
    return { ok: false, error: message, status, code };
  }
  return { ok: true, data: parsed as T };
};

/** Every gated dock command responds with the full state; callers apply it directly. */
const stateCall = async (
  guestId: string,
  viewerId: string | undefined,
  method: GuestRequestMethod,
  path: string,
  body?: unknown,
): Promise<ServerBrowserResult<ServerBrowserState>> => {
  const result = await call<unknown>(guestId, viewerId, method, path, { body });
  if (!result.ok) return result;
  const state = asServerBrowserState(result.data);
  if (!state) return { ok: false, error: 'The server browser returned no state.' };
  return { ok: true, data: state };
};

export const getServerBrowserState = async (
  guestId: string,
  viewerId: string | undefined,
  /** Hold the request until the state differs from this version (or `waitMs` passes). */
  waitFor?: { since: string; waitMs: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => {
  const result = await call<unknown>(guestId, viewerId, 'GET', '/browser/state', waitFor
    ? { query: { since: waitFor.since, wait: String(waitFor.waitMs) } }
    : {});
  if (!result.ok) return result;
  const state = asServerBrowserState(result.data);
  return state ? { ok: true, data: state } : { ok: false, error: 'The server browser returned no state.' };
};

export const openServerBrowserScope = (
  guestId: string,
  viewerId: string | undefined,
  body: { directory: string; sessionId: string; generation: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/scope', body);

export const selectServerBrowserScope = (
  guestId: string,
  viewerId: string | undefined,
  body: { scopeId: string; generation: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/select', body);

export const closeServerBrowserScope = (
  guestId: string,
  viewerId: string | undefined,
  body: { scopeId: string; generation: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/close-scope', body);

export const navigateServerBrowser = (
  guestId: string,
  viewerId: string | undefined,
  body: { url: string; generation: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/navigate', body);

const historyCommand = (path: '/browser/back' | '/browser/forward' | '/browser/reload' | '/browser/stop') => (
  guestId: string,
  viewerId: string | undefined,
  generation: number,
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', path, { generation });

export const goServerBrowserBack = historyCommand('/browser/back');
export const goServerBrowserForward = historyCommand('/browser/forward');
export const reloadServerBrowser = historyCommand('/browser/reload');
export const stopServerBrowser = historyCommand('/browser/stop');

const tabCommand = (operation: 'new' | 'select' | 'close') => (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; tabId?: string },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', `/browser/tabs/${operation}`, body);

export const newServerBrowserTab = tabCommand('new');
export const selectServerBrowserTab = tabCommand('select');
export const closeServerBrowserTab = tabCommand('close');

export const setServerBrowserColorScheme = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; scheme: 'system' | 'light' | 'dark' },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/page/color-scheme', body);

export const setServerBrowserViewport = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/viewport', body);

export const setServerBrowserViewer = (
  guestId: string,
  viewerId: string | undefined,
  body: { devicePixelRatio?: number; theme?: unknown },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/browser/viewer', body);

export const evaluateServerBrowserPage = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; expression: string; userGesture?: boolean },
): Promise<ServerBrowserResult<{ ok: true; value: unknown }>> => (
  call(guestId, viewerId, 'POST', '/page/evaluate', { body })
);

export type ServerBrowserCapture = {
  readonly mime: string;
  readonly base64: string;
  readonly width: number;
  readonly height: number;
};

export const captureServerBrowserPage = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number },
): Promise<ServerBrowserResult<ServerBrowserCapture>> => (
  call(guestId, viewerId, 'POST', '/page/capture', { body })
);

export const setServerBrowserZoom = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; level: number },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/page/zoom', body);

export const answerServerBrowserDialog = (
  guestId: string,
  viewerId: string | undefined,
  body: { tabId: string; dialogId: number; accept: boolean; promptText?: string },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/page/dialog', body);

/** The person's answer to an agent's request to keep the chat's logins in a saved profile. */
export const answerServerBrowserProfileRequest = (
  guestId: string,
  viewerId: string | undefined,
  approve: boolean,
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/help/profile', { approve });

/** `files` are names already uploaded to the chooser's directory; `cancel` gives the page none. */
export const answerServerBrowserFileChooser = (
  guestId: string,
  viewerId: string | undefined,
  body: { tabId: string; chooserId: number; files: readonly string[] } | { tabId: string; chooserId: number; cancel: true },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/page/file-chooser', body);

export const clearServerBrowserData = (
  guestId: string,
  viewerId: string | undefined,
  body: { generation: number; what: 'cookies' | 'cache' },
): Promise<ServerBrowserResult<ServerBrowserState>> => stateCall(guestId, viewerId, 'POST', '/page/clear', body);

export const closeServerBrowserProfile = (
  guestId: string,
  viewerId: string | undefined,
  body: { id: string },
): Promise<ServerBrowserResult<{ ok: true; profiles: unknown; state: ServerBrowserState }>> => (
  call(guestId, viewerId, 'POST', '/profiles/close', { body })
);

// --- Inspector (console/network), ported in spirit from the standalone
// extension's `panel/inspector.js`: a capture is started for the selected
// tab, then polled with a cursor for new rows. ---

export const startServerBrowserInspector = (
  guestId: string,
  viewerId: string | undefined,
): Promise<ServerBrowserResult<{ captureId: string }>> => call(guestId, viewerId, 'POST', '/inspector/start');

export const stopServerBrowserInspector = (
  guestId: string,
  viewerId: string | undefined,
  captureId: string,
): Promise<ServerBrowserResult<{ ok: true }>> => call(guestId, viewerId, 'POST', '/inspector/stop', { body: { captureId } });

export const clearServerBrowserInspector = (
  guestId: string,
  viewerId: string | undefined,
  body: { captureId: string; scope: 'console' | 'network' },
): Promise<ServerBrowserResult<{ ok: true }>> => call(guestId, viewerId, 'POST', '/inspector/clear', { body });

export const pollServerBrowserInspector = (
  guestId: string,
  viewerId: string | undefined,
  captureId: string,
  after: number,
): Promise<ServerBrowserResult<ServerBrowserInspectorBatch>> => (
  call(guestId, viewerId, 'GET', '/inspector/events', { query: { captureId, after: String(after) } })
);

export const getServerBrowserInspectorRequest = (
  guestId: string,
  viewerId: string | undefined,
  body: { captureId: string; entryId: string; includeBody: boolean },
): Promise<ServerBrowserResult<ServerBrowserRequestDetail>> => (
  call(guestId, viewerId, 'POST', '/inspector/request', { body })
);
