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
  const ioHandles = new Set();

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
    const viewportChanged = message.method === 'Emulation.setDeviceMetricsOverride'
      || message.method === 'Emulation.clearDeviceMetricsOverride';
    return { ok: true, message, viewportChanged };
  };

  const event = (raw) => {
    const message = parseMessage(raw);
    if (!message) return reject();
    if (message.sessionId !== undefined && !sessions.has(message.sessionId)) return reject();
    if (message.method === undefined) {
      return Number.isSafeInteger(message.id) && message.id >= 0 ? { ok: true, message } : reject();
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
      const childTarget = sessions.get(message.params?.sessionId);
      sessions.delete(message.params?.sessionId);
      if (childTarget) targets.delete(childTarget);
    } else if (message.method === 'Tracing.tracingComplete') {
      const handle = message.params?.stream;
      if (isIdentity(handle)) ioHandles.add(handle);
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
