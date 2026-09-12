/**
 * Async router between the two browser backends: connected client windows
 * (via the broker) and the server-hosted Chrome backend.
 *
 * Exactly one backend answers each request — the broker and the server never
 * both drive one action (`browser.tabs` is the one exception: its listing is
 * a read-only merge of both). The rules:
 *
 * - `browser.open` without a tabId keeps the pre-router semantics: a client
 *   whose inventory's `openableDirectory` matches wins, even a web/iframe
 *   display-only client. The server backend answers only when no client
 *   matches.
 * - An action naming a tab routes by ownership: `sc:`-prefixed tabs belong to
 *   the server session registry, anything else to a connected client.
 * - A tab-less rich action goes to a client whose inventory shows a matching
 *   active target for the directory; with no client match the server backend
 *   answers.
 * - `target.preferBackend === 'server-chrome'` forces the server path.
 *
 * The enabled flag is INJECTED (`isServerBackendEnabled`) — this module never
 * reads settings — and the server backend is composed lazily behind
 * `getServerBackend`, so with the flag off every request takes exactly the
 * path it took before this router existed.
 */

import { BrowserControlError } from './broker.js';

const SERVER_TAB_ID_PREFIX = 'sc:';

// Chrome-launch failures surface from the backend's generic wrapper as 400s
// carrying the actionable chrome-process text; from the router's perspective
// they are availability failures, so they are escalated to 503 here.
const isChromeUnavailableMessage = (message) => (
  /Chrome or Chromium was not found|OPENCHAMBER_CHROME_PATH points to an unavailable/.test(message)
);

const CLIENT_TAB_BACKEND = 'electron-webview';
const SERVER_TAB_BACKEND = 'server-chrome';

const withSignal = async (signal, operation) => {
  signal?.throwIfAborted();
  if (!signal) return operation();
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([operation(), aborted.promise]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export const createBrowserBackendRouter = ({
  broker,
  isServerBackendEnabled,
  getServerBackend,
  hasServingClient,
} = {}) => {
  if (typeof broker?.request !== 'function') throw new TypeError('broker is required');
  if (typeof isServerBackendEnabled !== 'function') throw new TypeError('isServerBackendEnabled is required');
  if (typeof getServerBackend !== 'function') throw new TypeError('getServerBackend is required');
  if (typeof hasServingClient !== 'function') throw new TypeError('hasServingClient is required');

  const scopedError = (message, status, target) => {
    const error = new BrowserControlError(message, status);
    if (target) error.target = target;
    return error;
  };

  const disabledError = (target) => scopedError(
    'The server browser is disabled (the serverBrowserEnabled setting is off), so it did not serve '
      + `${target?.directory ?? 'this request'}. Nothing was changed.`,
    503,
    target,
  );

  const asServerPathError = (error, target) => {
    if (error instanceof BrowserControlError) {
      if (target && !error.target) error.target = target;
      if (isChromeUnavailableMessage(error.message)) error.status = 503;
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return scopedError(message, error?.name === 'AbortError' ? 499 : (isChromeUnavailableMessage(message) ? 503 : 500), target);
  };

  const executeOnServer = async (target, action, parameters, { signal } = {}) => {
    try {
      const backend = await withSignal(signal, getServerBackend);
      return await backend.execute(target, action, parameters, { signal });
    } catch (error) {
      if (signal?.aborted) throw scopedError('Browser action was cancelled', 499, target);
      throw asServerPathError(error, target);
    }
  };

  const listServerTabs = async (target, signal) => {
    const backend = await withSignal(signal, getServerBackend);
    signal?.throwIfAborted();
    const serverTarget = { directory: target.directory };
    if (target.openCodeSessionId) serverTarget.openCodeSessionId = target.openCodeSessionId;
    return backend.listTabs(serverTarget, { signal });
  };

  /**
   * `browser.tabs` merges both listings, each entry tagged with its backend.
   * A leg that cannot answer does not erase the other leg's complete listing;
   * only both legs failing settles as an error.
   */
  const mergeTabs = async (action, parameters, options, target) => {
    const signal = options.signal;
    const client = await broker.request(action, parameters, options)
      .then((result) => ({ ok: true, result }), (error) => ({ ok: false, error }));
    if (signal?.aborted) throw scopedError('Browser action was cancelled', 499, target);
    const server = await withSignal(signal, () => listServerTabs(target, signal))
      .then((tabs) => ({ ok: true, tabs }), (error) => ({ ok: false, error }));
    if (signal?.aborted) throw scopedError('Browser action was cancelled', 499, target);

    if (!client.ok && !server.ok) {
      const serverError = asServerPathError(server.error, target);
      // A no-client broker failure is the unserved gap the server exists to
      // close, not information; the server's reason is the actionable one.
      if (client.error?.code === 'no-client') throw serverError;
      const clientMessage = client.error instanceof Error ? client.error.message : String(client.error);
      throw scopedError(`${clientMessage} The server browser also failed: ${serverError.message}`, serverError.status, target);
    }

    const base = client.ok && client.result && typeof client.result === 'object' ? client.result : {};
    const tabs = [];
    if (client.ok) {
      const list = Array.isArray(base.tabs) ? base.tabs : [];
      for (const tab of list) tabs.push({ backend: CLIENT_TAB_BACKEND, ...tab });
    }
    if (server.ok) {
      for (const tab of server.tabs) tabs.push(tab && tab.backend ? tab : { backend: SERVER_TAB_BACKEND, ...tab });
    }
    const resultTarget = { directory: target.directory };
    if (target.openCodeSessionId) resultTarget.openCodeSessionId = target.openCodeSessionId;
    const result = {
      ...base,
      target: resultTarget,
      tabs,
    };
    if (!client.ok && client.error?.code !== 'no-client') {
      result.clientError = client.error instanceof Error ? client.error.message : String(client.error);
    }
    if (!server.ok) {
      result.serverError = server.error instanceof Error ? server.error.message : String(server.error);
    }
    return result;
  };

  const routeBrowserAction = async (target, action, parameters, options) => {
    if (options.signal?.aborted) throw scopedError('Browser action was cancelled', 499, target);
    // An explicit force goes to the server even when a client could serve.
    if (target?.preferBackend === 'server-chrome') {
      if (!isServerBackendEnabled()) throw disabledError(target);
      return executeOnServer(target, action, parameters, options);
    }

    // With the server backend off, every request takes the pre-router path.
    if (!isServerBackendEnabled()) {
      return broker.request(action, parameters, options);
    }

    if (action === 'browser.tabs') {
      return mergeTabs(action, parameters, options, target);
    }

    // A named tab belongs to exactly one backend.
    const tabId = typeof target?.tabId === 'string' && target.tabId ? target.tabId : null;
    if (tabId) {
      if (tabId.startsWith(SERVER_TAB_ID_PREFIX)) {
        return executeOnServer(target, action, parameters, options);
      }
      return broker.request(action, parameters, options);
    }

    // Tab-less open and tab-less rich actions: a matching connected client
    // keeps serving; the server backend closes the gap when none does.
    if (hasServingClient(action, target)) {
      return broker.request(action, parameters, options);
    }
    return executeOnServer(target, action, parameters, options);
  };

  return {
    /** Broker-shaped request surface: (action, parameters, { signal, timeoutMs, target }). */
    request: (action, parameters = {}, options = {}) => {
      const target = options.target ? Object.freeze({ ...options.target }) : undefined;
      return routeBrowserAction(target, action, Object.freeze({ ...parameters }), { ...options, target });
    },
  };
};
