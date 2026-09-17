const PAGE_DOMAINS = new Set([
  'Accessibility', 'Animation', 'Audits', 'Autofill', 'BackgroundService', 'BluetoothEmulation',
  'CSS', 'CacheStorage', 'Console', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Debugger',
  'DeviceOrientation', 'Emulation', 'EventBreakpoints', 'FedCm', 'Fetch', 'FileSystem',
  'HeadlessExperimental', 'HeapProfiler', 'IndexedDB', 'Input', 'Inspector', 'LayerTree',
  'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance', 'PerformanceTimeline',
  'Preload', 'Profiler', 'Runtime', 'Schema', 'Security', 'ServiceWorker', 'Storage', 'WebAudio', 'WebAuthn',
]);

const BLOCKED_PAGE_METHODS = new Set([
  'Page.setDownloadBehavior',
  'Page.screencastFrameAck',
  'Page.startScreencast',
  'Page.stopScreencast',
]);

const TARGET_METHODS = new Set([
  'Target.setAutoAttach', 'Target.autoAttachRelated', 'Target.getTargetInfo',
  'Target.attachToTarget', 'Target.detachFromTarget',
]);

const CONTEXT_BOUND_METHODS = new Set([
  'Storage.clearCookies', 'Storage.getCookies', 'Storage.setCookies',
]);
const MAX_PENDING_STREAM_REQUESTS = 1_024;

const reject = () => ({ ok: false, code: 'DEVTOOLS_PROTOCOL_REJECTED' });
const deny = (message) => {
  const response = { id: message.id, error: { code: -32_000, message: 'Command is not available for this page' } };
  if (message.sessionId) response.sessionId = message.sessionId;
  return { ok: false, response };
};
const isObject = (value) => value?.constructor === Object;
const isIdentity = (value) => value?.constructor === String && value.length > 0 && value.length <= 256;

const parseMessage = (raw) => {
  if (raw?.constructor !== String) return null;
  try {
    const value = JSON.parse(raw);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

const safeNavigation = (params) => {
  if (!isObject(params) || params.url?.constructor !== String) return false;
  if (params.url === 'about:blank') return true;
  try {
    const url = new URL(params.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export function createDevToolsPolicy({ browserContextId, targetId }) {
  const sessions = new Map();
  const targets = new Set([targetId]);
  const ioHandles = new Map();
  const pendingNetworkStreams = new Map();
  let pendingNetworkStreamCount = 0;

  const rememberNetworkStream = (message) => {
    const sessionId = message.sessionId ?? null;
    const requests = pendingNetworkStreams.get(sessionId) ?? new Set();
    if (requests.has(message.id)) return true;
    if (pendingNetworkStreamCount >= MAX_PENDING_STREAM_REQUESTS) return false;
    requests.add(message.id);
    pendingNetworkStreams.set(sessionId, requests);
    pendingNetworkStreamCount += 1;
    return true;
  };

  const registerNetworkStream = (message) => {
    const sessionId = message.sessionId ?? null;
    const requests = pendingNetworkStreams.get(sessionId);
    if (!requests?.delete(message.id)) return;
    pendingNetworkStreamCount -= 1;
    if (requests.size === 0) pendingNetworkStreams.delete(sessionId);
    const resource = message.result?.resource;
    if (isObject(resource) && resource.success === true && isIdentity(resource.stream)) {
      ioHandles.set(resource.stream, sessionId);
    }
  };

  const clearSessionResources = (sessionId) => {
    pendingNetworkStreamCount -= pendingNetworkStreams.get(sessionId)?.size ?? 0;
    pendingNetworkStreams.delete(sessionId);
    for (const [handle, ownerSessionId] of ioHandles) {
      if (ownerSessionId === sessionId) ioHandles.delete(handle);
    }
  };

  const contextAllowed = (params) => !isObject(params) || params.browserContextId === undefined
    || params.browserContextId === browserContextId;

  const targetCommandAllowed = (message) => {
    if (!TARGET_METHODS.has(message.method)) return false;
    const params = isObject(message.params) ? message.params : {};
    if (message.method === 'Target.setAutoAttach') {
      return (params.autoAttach === true || params.autoAttach === false)
        && (params.autoAttach === false || params.flatten === true)
        && (params.waitForDebuggerOnStart === undefined
          || params.waitForDebuggerOnStart === true || params.waitForDebuggerOnStart === false);
    }
    if (message.method === 'Target.autoAttachRelated') {
      return targets.has(params.targetId)
        && (params.waitForDebuggerOnStart === true || params.waitForDebuggerOnStart === false);
    }
    if (message.method === 'Target.getTargetInfo') {
      return params.targetId === undefined || targets.has(params.targetId);
    }
    if (message.method === 'Target.attachToTarget') {
      return isIdentity(params.targetId) && targets.has(params.targetId) && params.flatten === true;
    }
    return isIdentity(params.sessionId) && sessions.has(params.sessionId);
  };

  const ioCommandAllowed = (message) => {
    const params = isObject(message.params) ? message.params : {};
    return (message.method === 'IO.read' || message.method === 'IO.close')
      && isIdentity(params.handle) && ioHandles.has(params.handle);
  };

  const command = (raw) => {
    const message = parseMessage(raw);
    if (!message || !Number.isSafeInteger(message.id) || message.id < 0
      || message.method?.constructor !== String || message.method.length > 160
      || (message.params !== undefined && !isObject(message.params))) return reject();
    if (message.sessionId !== undefined && (!isIdentity(message.sessionId) || !sessions.has(message.sessionId))) return reject();
    if (!contextAllowed(message.params)) return reject();
    if (CONTEXT_BOUND_METHODS.has(message.method)) {
      message.params = { ...(message.params ?? {}), browserContextId };
    }

    const domain = message.method.split('.', 1)[0];
    if (domain === 'Browser') {
      return message.method === 'Browser.getVersion' ? { ok: true, message } : deny(message);
    }
    if (domain === 'Target') return targetCommandAllowed(message) ? { ok: true, message } : deny(message);
    if (domain === 'Tracing') {
      if (message.method === 'Tracing.start') return { ok: true, message, trace: 'start' };
      if (message.method === 'Tracing.end') return { ok: true, message, trace: 'end' };
      return deny(message);
    }
    if (domain === 'IO') {
      if (!ioCommandAllowed(message)) return reject();
      const handle = message.params.handle;
      return message.method === 'IO.close' ? { ok: true, message, closedHandle: handle } : { ok: true, message };
    }
    if (!PAGE_DOMAINS.has(domain) || BLOCKED_PAGE_METHODS.has(message.method)) return deny(message);
    if (message.method === 'Page.navigate' && !safeNavigation(message.params)) return reject();
    if (message.method === 'Network.loadNetworkResource' && !rememberNetworkStream(message)) return deny(message);
    const viewportChanged = message.method === 'Emulation.setDeviceMetricsOverride'
      || message.method === 'Emulation.clearDeviceMetricsOverride';
    return { ok: true, message, viewportChanged };
  };

  const event = (raw) => {
    const message = parseMessage(raw);
    if (!message) return reject();
    if (message.sessionId !== undefined && !sessions.has(message.sessionId)) return reject();
    if (message.method === undefined) {
      if (!Number.isSafeInteger(message.id) || message.id < 0) return reject();
      registerNetworkStream(message);
      return { ok: true, message };
    }
    if (message.method?.constructor !== String) return reject();
    if (message.method === 'Target.attachedToTarget') {
      const params = message.params;
      const info = params?.targetInfo;
      if (!isIdentity(params?.sessionId) || !isIdentity(info?.targetId)) return reject();
      const related = info.browserContextId === browserContextId || targets.has(info.openerId);
      if (!related) return reject();
      sessions.set(params.sessionId, info.targetId);
      targets.add(info.targetId);
    } else if (message.method === 'Target.detachedFromTarget') {
      const detachedSessionId = message.params?.sessionId;
      const childTarget = sessions.get(detachedSessionId);
      sessions.delete(detachedSessionId);
      clearSessionResources(detachedSessionId);
      if (childTarget) targets.delete(childTarget);
    } else if (message.method === 'Tracing.tracingComplete') {
      const handle = message.params?.stream;
      if (isIdentity(handle)) ioHandles.set(handle, null);
      return { ok: true, message, trace: 'complete' };
    }
    return { ok: true, message };
  };

  return {
    command,
    event,
    closeHandle(handle) { ioHandles.delete(handle); },
    childSessionIds() { return [...sessions.keys()]; },
  };
}
