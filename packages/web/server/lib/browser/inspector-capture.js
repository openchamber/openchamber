import { boundedString, formatConsoleEvent, formatHeaders, redactUrl } from './inspector-format.js';

const MAX_CONSOLE_ROWS = 300;
const MAX_NETWORK_ROWS = 200;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 48 * 1024;
const MAX_BATCH_ROWS = 32;
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const finiteOrNull = (value) => Number.isFinite(value) && value >= 0 ? value : null;

export function createInspectorCapture({ captureId, tabId, send, canSend, startedAt = Date.now() }) {
  const consoleRows = new Map();
  const networkRows = new Map();
  const activeRequests = new Map();
  const pendingNetwork = new Map();
  let retainedBytes = 0;
  let nextId = 0;
  let droppedConsole = 0;
  let droppedNetwork = 0;
  let countsChanged = false;
  let running = false;
  let disposed = false;
  let timer = null;
  let firstQueue = 0;

  const removeConsole = (id, dropped) => {
    const entry = consoleRows.get(id);
    if (!entry) return;
    retainedBytes -= entry.bytes;
    consoleRows.delete(id);
    if (dropped) { droppedConsole += 1; countsChanged = true; }
  };

  const removeNetwork = (id, dropped) => {
    const entry = networkRows.get(id);
    if (!entry) return;
    retainedBytes -= entry.bytes;
    networkRows.delete(id);
    pendingNetwork.delete(id);
    if (activeRequests.get(entry.requestId) === id) activeRequests.delete(entry.requestId);
    if (dropped) { droppedNetwork += 1; countsChanged = true; }
  };

  const trim = () => {
    while (consoleRows.size > MAX_CONSOLE_ROWS) removeConsole(consoleRows.keys().next().value, true);
    while (networkRows.size > MAX_NETWORK_ROWS) removeNetwork(networkRows.keys().next().value, true);
    while (retainedBytes > MAX_CAPTURE_BYTES) {
      if (consoleRows.size) removeConsole(consoleRows.keys().next().value, true);
      else if (networkRows.size) removeNetwork(networkRows.keys().next().value, true);
      else break;
    }
  };

  const schedule = () => {
    if (!running || disposed || timer !== null || (!consoleRows.size && !pendingNetwork.size && !countsChanged)) return;
    timer = setTimeout(flush, 100);
    timer.unref?.();
  };

  function flush() {
    timer = null;
    if (!running || disposed) return;
    if (!canSend()) { schedule(); return; }
    const message = { type: 'inspectorEvents', tabId, captureId, console: [], network: [], droppedConsole, droppedNetwork };
    const sentConsole = [];
    const sentNetwork = [];
    const queues = [consoleRows.values(), pendingNetwork.values()];
    let bytes = byteLength(message);
    let full = false;
    while (sentConsole.length + sentNetwork.length < MAX_BATCH_ROWS && !full) {
      let added = false;
      for (let offset = 0; offset < queues.length; offset += 1) {
        const index = (firstQueue + offset) % queues.length;
        if (sentConsole.length + sentNetwork.length === MAX_BATCH_ROWS) break;
        const entry = queues[index].next().value;
        if (!entry) continue;
        const rows = index === 0 ? message.console : message.network;
        const addition = entry.rowBytes + (rows.length ? 1 : 0);
        if (bytes + addition > MAX_BATCH_BYTES) { full = true; break; }
        rows.push(entry.row);
        (index === 0 ? sentConsole : sentNetwork).push(entry.row.id);
        bytes += addition;
        added = true;
      }
      if (!added) break;
    }
    if ((sentConsole.length || sentNetwork.length || countsChanged) && send(message)) {
      for (const id of sentConsole) removeConsole(id, false);
      for (const id of sentNetwork) pendingNetwork.delete(id);
      countsChanged = false;
    }
    firstQueue = 1 - firstQueue;
    schedule();
  }

  const publishNetwork = (entry) => {
    const previous = networkRows.get(entry.row.id);
    if (previous) retainedBytes -= previous.bytes;
    const rowBytes = byteLength(entry.row);
    const stored = { ...entry, rowBytes, bytes: byteLength(entry) };
    networkRows.set(entry.row.id, stored);
    pendingNetwork.delete(entry.row.id);
    pendingNetwork.set(entry.row.id, stored);
    retainedBytes += stored.bytes;
    trim();
    schedule();
  };

  const completeResponse = (entry, response, timestamp, state = 'pending') => {
    const headers = formatHeaders(response?.headers);
    return {
      ...entry,
      responseHeaders: headers.headers,
      truncated: entry.truncated || headers.truncated,
      row: { ...entry.row, status: Number.isInteger(response?.status) ? finiteOrNull(response.status) : null,
        statusText: boundedString(response?.statusText, 128),
        mimeType: boundedString(response?.mimeType, 128), encodedBytes: finiteOrNull(response?.encodedDataLength), state,
        durationMs: state === 'complete' && Number.isFinite(timestamp) ? finiteOrNull(Math.max(0, (timestamp - entry.started) * 1_000)) : null,
        fromCache: entry.row.fromCache || response?.fromDiskCache === true || response?.fromServiceWorker === true
          || response?.fromPrefetchCache === true },
    };
  };

  const event = (method, params) => {
    if (disposed) return;
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
      if (Number.isFinite(params?.timestamp) && params.timestamp < startedAt) return;
      const row = formatConsoleEvent(method, params, `${captureId}:c${++nextId}`);
      if (!row) return;
      const rowBytes = byteLength(row);
      consoleRows.set(row.id, { row, rowBytes, bytes: rowBytes });
      retainedBytes += rowBytes;
      trim();
      schedule();
      return;
    }
    const requestId = boundedString(params?.requestId, 129);
    if (!requestId || requestId.length > 128) return;
    const currentId = activeRequests.get(requestId);
    const current = networkRows.get(currentId);
    if (method === 'Network.requestWillBeSent') {
      if (!params.request || !Number.isFinite(params.timestamp)) return;
      if (current) {
        if (!params.redirectResponse) return;
        publishNetwork({ ...completeResponse(current, params.redirectResponse, params.timestamp, 'complete'), redirected: true });
      }
      const headers = formatHeaders(params.request.headers);
      const timestamp = params.wallTime * 1_000;
      const row = {
        id: `${captureId}:n${++nextId}`, timestamp: Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8.64e15 ? timestamp : Date.now(),
        method: boundedString(params.request.method, 128), url: redactUrl(params.request.url),
        resourceType: boundedString(params.type, 128), status: null, statusText: '', mimeType: '', durationMs: null,
        encodedBytes: null, state: 'pending', failureText: null, fromCache: false,
      };
      activeRequests.set(requestId, row.id);
      publishNetwork({ row, requestId, started: params.timestamp, requestHeaders: headers.headers,
        responseHeaders: [], hasPostData: params.request.hasPostData === true, redirected: false, truncated: headers.truncated });
      return;
    }
    if (!current) return;
    if (method === 'Network.responseReceived') {
      publishNetwork(completeResponse(current, params.response, params.timestamp));
    } else if (method === 'Network.requestServedFromCache') {
      publishNetwork({ ...current, row: { ...current.row, fromCache: true } });
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const failed = method === 'Network.loadingFailed';
      const networkError = boundedString(params.errorText, 1_024);
      publishNetwork({ ...current, row: { ...current.row, state: failed ? 'failed' : 'complete',
        encodedBytes: failed ? current.row.encodedBytes : finiteOrNull(params.encodedDataLength),
        durationMs: Number.isFinite(params.timestamp) ? finiteOrNull(Math.max(0, (params.timestamp - current.started) * 1_000)) : null,
        failureText: failed ? (params.canceled === true ? 'Request canceled' : /^net::ERR_[A-Z0-9_]+$/.test(networkError)
          ? networkError : params.blockedReason ? 'Request blocked' : 'Request failed') : null } });
    }
  };

  const clear = (scope) => {
    if (scope === 'console') {
      for (const id of consoleRows.keys()) removeConsole(id, false);
      droppedConsole = 0;
    } else {
      for (const id of networkRows.keys()) removeNetwork(id, false);
      droppedNetwork = 0;
    }
    countsChanged = droppedConsole > 0 || droppedNetwork > 0;
    if (!consoleRows.size && !pendingNetwork.size && !countsChanged && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    schedule();
  };

  return {
    start() { if (!disposed) { running = true; schedule(); } },
    event,
    clear,
    request(entryId) { return networkRows.get(entryId) ?? null; },
    dispose() {
      disposed = true;
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      consoleRows.clear();
      networkRows.clear();
      pendingNetwork.clear();
      activeRequests.clear();
      retainedBytes = 0;
    },
  };
}
