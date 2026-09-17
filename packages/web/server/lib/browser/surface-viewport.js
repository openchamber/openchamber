import { getBrowserViewportManager, BrowserViewportError } from './viewport.js';
import { MAX_VIEWPORT_DIMENSION, MIN_VIEWPORT_DIMENSION } from './viewport-metrics.js';

const ERROR_MESSAGES = {
  UNAVAILABLE: 'Viewport control requires an attached browser tab',
  INVALID_REQUEST: 'The viewport request is invalid',
  STALE_ATTACHMENT: 'The viewport request belongs to an earlier tab attachment',
  SUPERSEDED: 'A newer viewport request replaced this request',
  RESIZE_FAILED: 'Could not change or read the browser viewport',
  RESIZE_TIMEOUT: 'The browser viewport request exceeded the time limit',
};

export function createSurfaceViewport({ browserSessionManager, sendJson, parseString, onApplied = () => {} }) {
  const core = browserSessionManager ? getBrowserViewportManager(browserSessionManager) : null;
  const viewers = new Map();

  const identity = (value) => {
    const text = parseString(value);
    if (!text || text.length > 128) throw new Error('Invalid viewport identity');
    return text;
  };
  const envelope = (message) => ({
    requestId: identity(message.requestId),
    tabId: identity(message.tabId),
    attachmentRequestId: identity(message.attachmentRequestId),
  });
  const parseRequest = (message) => {
    const request = envelope(message);
    if (![message.width, message.height].every((value) => Number.isInteger(value)
      && value >= MIN_VIEWPORT_DIMENSION && value <= MAX_VIEWPORT_DIMENSION)
      || !['auto', 'fixed'].includes(message.mode)
      || ![true, false].includes(message.mobile) || ![true, false].includes(message.takeover)) {
      throw new Error('Invalid viewport settings');
    }
    return { ...request, width: message.width, height: message.height,
      mode: message.mode, mobile: message.mobile, takeover: message.takeover };
  };
  const sendError = (viewer, request, code) => sendJson(viewer.socket, {
    type: 'viewportError', ...envelope(request), code, message: ERROR_MESSAGES[code],
  });
  const isAttached = (viewer) => viewer.socket.readyState === 1 && viewer.attached
    && viewer.surfaceSession && !viewer.surfaceSession.closed && viewer.tabId.startsWith('sc:');
  const isCurrent = (state) => viewers.get(state.viewer) === state && !state.controller.signal.aborted
    && isAttached(state.viewer) && state.viewer.surfaceSession === state.surfaceSession
    && state.viewer.tabId === state.tabId && state.viewer.attachmentGeneration === state.attachmentGeneration
    && state.viewer.attachmentRequestId === state.attachmentRequestId;

  const publish = (state) => {
    if (!core || !isCurrent(state)) return;
    const viewport = core.snapshot(state.surfaceSession.sessionId, state.targetId, state.viewer.id);
    if (!viewport) return;
    const serialized = JSON.stringify(viewport);
    if (state.lastSnapshot === serialized) return;
    state.lastSnapshot = serialized;
    sendJson(state.viewer.socket, { type: 'viewportState', tabId: state.tabId,
      attachmentRequestId: state.attachmentRequestId, viewport });
  };
  const unsubscribe = core?.onChange(({ sessionId, targetId }) => {
    for (const state of viewers.values()) {
      if (state.surfaceSession.sessionId === sessionId && state.targetId === targetId) publish(state);
    }
  });

  const detach = (viewer) => {
    const state = viewers.get(viewer);
    if (!state) return;
    viewers.delete(viewer);
    state.controller.abort();
    core?.detachViewer(state.surfaceSession.sessionId, viewer.id, state.targetId);
  };

  return {
    attach(viewer) {
      detach(viewer);
      if (!core || !isAttached(viewer) || !viewer.attachmentRequestId) return;
      const state = { viewer, surfaceSession: viewer.surfaceSession, tabId: viewer.tabId,
        targetId: viewer.tabId.slice(3), attachmentGeneration: viewer.attachmentGeneration,
        attachmentRequestId: viewer.attachmentRequestId, controller: new AbortController(), lastSnapshot: null };
      viewers.set(viewer, state);
      void core.read(state.surfaceSession.sessionId, state.targetId, viewer.id).then(() => publish(state), () => {
        // A later viewport command reports its read failure through its request ID.
      });
    },
    handle(viewer, message, type) {
      if (type !== 'viewportSet') return false;
      let request;
      try { request = parseRequest(message); } catch {
        try { sendError(viewer, envelope(message), 'INVALID_REQUEST'); } catch {}
        return true;
      }
      if (!core || !isAttached(viewer)) {
        sendError(viewer, request, 'UNAVAILABLE');
        return true;
      }
      const state = viewers.get(viewer);
      if (!state || !isCurrent(state) || state.tabId !== request.tabId
        || state.attachmentRequestId !== request.attachmentRequestId) {
        sendError(viewer, request, 'STALE_ATTACHMENT');
        return true;
      }
      void core.setViewer({ sessionId: state.surfaceSession.sessionId, targetId: state.targetId,
        viewerId: viewer.id, width: request.width, height: request.height, mode: request.mode,
        mobile: request.mobile, takeover: request.takeover, signal: state.controller.signal,
        isCurrent: () => isCurrent(state) }).then((result) => {
        if (!isCurrent(state)) return;
        sendJson(viewer.socket, { type: 'viewportResult', ...envelope(request), ...result });
        if (result.status === 'applied') onApplied(viewer, result.viewport);
      }, (error) => {
        if (!isCurrent(state)) return;
        const code = error instanceof BrowserViewportError ? error.code : 'RESIZE_FAILED';
        sendError(viewer, request, code);
      });
      return true;
    },
    observe(sessionId, targetId) {
      if (core) void core.observe(sessionId, targetId).catch(() => {});
    },
    external(viewer, change) {
      if (!core) return Promise.reject(new BrowserViewportError('UNAVAILABLE', ERROR_MESSAGES.UNAVAILABLE));
      const operation = core.external({ sessionId: change.sessionId, targetId: change.tabId.slice(3),
        viewerId: viewer.id, devtoolsId: change.devtoolsId, type: change.type, apply: change.apply });
      return change.apply ? operation : operation.catch(() => {});
    },
    dropTarget(sessionId, targetId) { core?.dropTarget(sessionId, targetId); },
    detach,
    dispose() {
      unsubscribe?.();
      for (const viewer of viewers.keys()) detach(viewer);
    },
  };
}
