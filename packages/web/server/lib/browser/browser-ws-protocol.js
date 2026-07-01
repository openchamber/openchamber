/**
 * Browser-control WebSocket protocol (server <-> renderer executor).
 *
 * Unlike the terminal (high-frequency binary), browser commands are
 * request/response and infrequent, so frames are plain JSON text. The server
 * issues commands INTO the renderer (reverse-RPC) and correlates replies by `cid`.
 *
 * Renderer -> server:
 *   { t:'hello', controllerId, backend, url, title }   register/refresh a controller
 *   { t:'res', cid, ok:true, value }                   command result
 *   { t:'res', cid, ok:false, code, message }          command failure
 *   { t:'event', controllerId, kind, payload }         console|network|pageError|navigated|dialog
 *   { t:'bye', controllerId }                          detach
 *   { t:'pong' }
 *
 * Server -> renderer:
 *   { t:'hello-ok', controllerId, capabilities }
 *   { t:'cmd', cid, primitive, args }                  run a primitive in the page
 *   { t:'cancel', cid }                                abandon a pending command
 *   { t:'ping' }
 */

const BROWSER_WS_PATH = '/api/browser/ws';
// Snapshots and base64 screenshots can be large; allow generous payloads.
export const BROWSER_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export const parseRequestPathname = (requestUrl) => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) return '';
  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

export const isBrowserWsPathname = (pathname) => pathname === BROWSER_WS_PATH;

export const encodeBrowserWsMessage = (payload) => JSON.stringify(payload);

export const decodeBrowserWsMessage = (rawData) => {
  let text;
  if (typeof rawData === 'string') text = rawData;
  else if (Buffer.isBuffer(rawData)) text = rawData.toString('utf8');
  else if (Array.isArray(rawData)) text = Buffer.concat(rawData.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
  else text = String(rawData);

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};
