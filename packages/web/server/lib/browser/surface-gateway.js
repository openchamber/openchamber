import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { REMOTE_SELECTION_EXPRESSION } from './selection.js';
import { createBrowserInspector } from './inspector.js';
import { createBrowserDevTools } from './devtools.js';
import { createSurfaceViewport } from './surface-viewport.js';
import { createBrowserContextMenu } from './context-menu.js';

export const SURFACE_WS_PATH = '/api/browser-surface';

const SURFACE_WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_UNACKED_FRAMES = 3;
const FRAME_FORMAT_JPEG = 'jpeg';
const EDITING_KEY_CODES = new Map([
  ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['Escape', 27],
  ['PageUp', 33], ['PageDown', 34], ['End', 35], ['Home', 36],
  ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40],
  ['Insert', 45], ['Delete', 46],
]);
const SCREENCAST_OPTIONS = {
  format: FRAME_FORMAT_JPEG,
  quality: 80,
  maxWidth: 0,
  maxHeight: 0,
  everyNthFrame: 1,
};
const parseString = (value) => String.prototype.valueOf.call(value);

const parseCoordinate = (value) => {
  if (!Number.isFinite(value)) throw new Error('Expected a finite coordinate or delta');
  return value;
};

const parseModifiers = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((modifier) => ['Alt', 'Control', 'Meta', 'Shift'].includes(modifier))) {
    throw new Error('Invalid modifiers');
  }
  return value.slice();
};

const parseInput = (message) => {
  const tabId = parseString(message.tabId);
  if (message.type === 'text') return { type: 'text', tabId, text: parseString(message.text) };
  if (message.type === 'key') {
    if (!['keydown', 'keyup'].includes(message.eventType)) throw new Error('Invalid key event');
    return { type: 'key', tabId, eventType: message.eventType, key: parseString(message.key), modifiers: parseModifiers(message.modifiers) };
  }
  const coordinates = { x: parseCoordinate(message.x), y: parseCoordinate(message.y) };
  if (message.type === 'wheel') {
    return { type: 'wheel', tabId, ...coordinates, deltaX: parseCoordinate(message.deltaX),
      deltaY: parseCoordinate(message.deltaY), modifiers: parseModifiers(message.modifiers) };
  }
  if (message.type !== 'pointer' || !['move', 'down', 'up'].includes(message.eventType)
    || ![undefined, 0, 1, 2].includes(message.button)) throw new Error('Invalid pointer event');
  return { type: 'pointer', tabId, ...coordinates, eventType: message.eventType, button: message.button ?? 0 };
};

const parseNavigation = (message) => {
  const tabId = parseString(message.tabId);
  if (['back', 'forward', 'reload', 'stop'].includes(message.type)) return { type: message.type, tabId };
  if (message.type !== 'navigate') throw new Error('Invalid navigation command');
  const url = parseString(message.url);
  if (url !== 'about:blank' && !['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error('Expected an HTTP or HTTPS address');
  }
  return { type: 'navigate', tabId, url };
};

const parseCopy = (message) => {
  const tabId = parseString(message.tabId);
  const requestId = parseString(message.requestId);
  if (!tabId || tabId.length > 128 || !requestId || requestId.length > 128) {
    throw new Error('Expected bounded copy identity');
  }
  return { tabId, requestId };
};

const sendCopyFailure = (socket, request, code) => sendJson(socket, {
  type: 'copyResult', ...request, ok: false, code,
  message: code === 'NO_SELECTION' ? 'No text is selected in the remote page'
    : code === 'COPY_TOO_LARGE' ? 'The selected text is too large to copy'
      : 'Could not read the selected text from the remote page',
});

const parseNavigationHistory = (history) => {
  if (!Number.isInteger(history.currentIndex) || !Array.isArray(history.entries)
    || history.currentIndex < 0 || history.currentIndex >= history.entries.length) {
    throw new Error('Chrome returned invalid navigation history');
  }
  const entries = history.entries.map((entry) => {
    if (!Number.isInteger(entry.id)) throw new Error('Chrome returned an invalid navigation entry');
    return { id: entry.id, url: parseString(entry.url), title: parseString(entry.title) };
  });
  return { currentIndex: history.currentIndex, entries };
};

const isBrowserSurfacePath = (url) => {
  try {
    return new URL(String(url || ''), 'http://localhost').pathname === SURFACE_WS_PATH;
  } catch {
    return false;
  }
};

/**
 * @typedef {object} SurfaceFrame
 * @property {number} frameSeq - monotonically increasing sequence per stream
 * @property {number} streamGen - stream generation; stale frames dropped after stop/restart
 * @property {string} tabId - sc:<cdp-target-id> target id
 * @property {number} width - frame width in CSS pixels
 * @property {number} height - frame height in CSS pixels
 * @property {number} scale - device pixel ratio the frame was captured at
 * @property {ArrayBuffer|Buffer|Uint8Array} data - raw JPEG bytes
 *
 * @typedef {object} SurfaceFrameAck
 * @property {string} type - 'frameAck'
 * @property {number} frameSeq - acknowledged sequence number
 *
 * @typedef {object} SurfaceState
 * @property {string|null} tabId - currently attached tab; null during attachment
 * @property {string} [attachmentRequestId] - present only on the matching attachment completion
 * @property {string} type - 'state'
 * @property {object} lease - session lease snapshot from session-manager
 * @property {boolean} controlling - whether the viewer holds the control lease
 *
 * @typedef {object} SurfaceInputPointer
 * @property {'pointer'} type
 * @property {string} tabId
 * @property {'move'|'down'|'up'} eventType
 * @property {number} x - CSS pixel X, client-side converted
 * @property {number} y - CSS pixel Y, client-side converted
 * @property {number} [button]
 *
 * @typedef {object} SurfaceInputKey
 * @property {'key'} type
 * @property {string} tabId
 * @property {'keydown'|'keyup'} eventType
 * @property {string} key
 * @property {string[]} [modifiers]
 *
 * @typedef {object} SurfaceInputText
 * @property {'text'} type
 * @property {string} tabId
 * @property {string} text
 *
 * @typedef {SurfaceInputPointer|SurfaceInputKey|SurfaceInputText} SurfaceInput
 */

const sendJson = (socket, payload) => {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

/**
 * Creates the authenticated browser surface WebSocket gateway.
 *
 * Dependencies are injected so the module is inert when the browser backend is
 * disabled: callers can still register the upgrade handler; if the gateway is
 * never invoked (because `browserSessionManager` is null or the feature is off)
 * it consumes no runtime beyond an empty handler.
 *
 * @param {{
 *   server: import('node:http').Server,
 *   uiAuthController: import('../ui-auth/ui-auth.js').UiAuthController | null,
 *   isRequestOriginAllowed: (req: import('node:http').IncomingMessage) => Promise<boolean>,
 *   rejectWebSocketUpgrade: (socket: import('node:net').Socket, code: number, reason: string) => void,
 *   browserSessionManager: import('./session-manager.js').BrowserSessionManager | null,
 *   logger?: Pick<Console, 'warn'|'info'>,
 * }} deps
 */
export function createBrowserSurfaceGateway({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  browserSessionManager,
  logger = console,
}) {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: SURFACE_WS_MAX_PAYLOAD_BYTES });
  const sessions = new Map(); // sessionId -> SurfaceSession
  const inspector = createBrowserInspector({ browserSessionManager, runViewerOperation, sendJson, parseString });
  const contextMenu = createBrowserContextMenu({ browserSessionManager, runViewerOperation, sendJson, parseString });
  const viewport = createSurfaceViewport({ browserSessionManager, sendJson, parseString,
    onApplied: (viewer, confirmed) => recoverScreencastForViewport(viewer, confirmed) });
  const devtools = createBrowserDevTools({ browserSessionManager, runViewerOperation, sendJson, logger,
    onViewportOverride: (viewer, change) => viewport.external(viewer, change) });
  let nextFrameSeq = 1;

  const getDirectory = (req) => {
    try {
      return new URL(String(req.url || ''), 'http://localhost').searchParams.get('directory') || '';
    } catch {
      return '';
    }
  };

  const getSessionId = (req) => {
    try {
      return new URL(String(req.url || ''), 'http://localhost').searchParams.get('sessionId') || '';
    } catch {
      return '';
    }
  };

  const getAuthContext = async (req) => {
    // Password-free UI cookies are not credentials for this input-bearing channel.
    const context = await uiAuthController?.resolveAuthContext?.({
      ...req, headers: { ...req.headers, cookie: '' },
    }, null, { allowSessionAuth: false, allowUrlToken: true });
    return context?.type === 'client' ? context : null;
  };

  const createSurfaceSession = (sessionId, directory) => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const surfaceSession = {
      sessionId,
      directory,
      viewers: new Set(),
      streams: new Map(), // targetId -> { streamGen, frameSeq, cdpSessionId }
      latestFrame: new Map(), // targetId -> { frameSeq, streamGen, width, height, scale, data }
      streamGenerations: new Map(),
      registryUnsub: null,
      registryReady: null,
      registryGeneration: 0,
      closed: false,
    };
    sessions.set(sessionId, surfaceSession);
    return surfaceSession;
  };

  const closeSurfaceSession = (surfaceSession, reason = 'Session ended', code = 1001) => {
    if (surfaceSession.closed) return;
    surfaceSession.closed = true;
    for (const viewer of surfaceSession.viewers) {
      detachViewer(viewer);
      sendJson(viewer.socket, { type: 'error', code: 'SESSION_ENDED', message: reason });
      try { viewer.socket.close(code, reason); } catch { /* already closed */ }
    }
    surfaceSession.viewers.clear();
    sessions.delete(surfaceSession.sessionId);
  };
  const lifecycleUnsubscribe = browserSessionManager?.onLifecycle?.((event) => {
    if (event?.type !== 'ended') return;
    const surfaceSession = sessions.get(event.sessionId);
    if (surfaceSession) closeSurfaceSession(surfaceSession, event.reason || 'Session ended', 1011);
  });

  const publishNavigation = (surfaceSession, stream) => {
    if (!stream.navigation) return;
    for (const viewer of surfaceSession.viewers) {
      if (viewer.attached && viewer.tabId === `sc:${stream.targetId}`) {
        sendJson(viewer.socket, stream.navigation);
      }
    }
  };

  const refreshNavigation = (surfaceSession, stream) => {
    stream.navigationRevision += 1;
    if (stream.navigationPending) return stream.navigationPending;
    stream.navigationPending = (async () => {
      let revision;
      do {
        revision = stream.navigationRevision;
        let result;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (surfaceSession.closed || surfaceSession.streams.get(stream.targetId) !== stream) return;
          try {
            result = await browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
              targetId: stream.targetId,
              requireTargetOwnership: true,
              operation: ({ cdp }) => cdp.sendSession(stream.cdpSessionId, 'Page.getNavigationHistory'),
            });
            break;
          } catch (error) {
            if (surfaceSession.closed || surfaceSession.streams.get(stream.targetId) !== stream) return;
            // Chrome can briefly swap out its active page while navigation commits.
            if (attempt === 2 || !(error instanceof Error)
              || !error.message.endsWith('CDP command Page.getNavigationHistory failed: Not attached to an active page')) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        if (surfaceSession.closed || surfaceSession.streams.get(stream.targetId) !== stream) return;
        if (revision !== stream.navigationRevision) continue;
        const history = parseNavigationHistory(result);
        const entry = history.entries[history.currentIndex];
        stream.navigation = {
          type: 'navigation', tabId: `sc:${stream.targetId}`,
          url: entry.url, title: entry.title,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
          isLoading: stream.isLoading,
        };
        publishNavigation(surfaceSession, stream);
      } while (revision !== stream.navigationRevision);
    })().catch((error) => {
      if (surfaceSession.closed || surfaceSession.streams.get(stream.targetId) !== stream) return;
      for (const viewer of surfaceSession.viewers) {
        if (viewer.attached && viewer.tabId === `sc:${stream.targetId}`) {
          sendJson(viewer.socket, { type: 'error', code: 'NAVIGATION_STATE_FAILED', message: String(error?.message ?? error) });
        }
      }
    }).finally(() => { stream.navigationPending = null; });
    return stream.navigationPending;
  };

  const handleTargetEvent = (surfaceSession, stream, { method, params, sessionId }) => {
    if (surfaceSession.closed || surfaceSession.streams.get(stream.targetId) !== stream) return;
    if (method === 'Target.targetInfoChanged' && params.targetInfo?.targetId === stream.targetId) {
      void refreshNavigation(surfaceSession, stream);
      return;
    }
    if (sessionId !== stream.cdpSessionId) return;
    if (method === 'Page.frameResized') {
      viewport.observe(surfaceSession.sessionId, stream.targetId);
      return;
    }
    if (method === 'Page.screencastFrame') {
      handleScreencastFrame(surfaceSession, stream.targetId, stream, params);
      return;
    }
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      stream.mainFrameId = params.frame.id;
    } else if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
      if (params.frameId !== stream.mainFrameId) return;
      stream.loadingRevision += 1;
      stream.isLoading = method === 'Page.frameStartedLoading';
    } else if (method === 'Page.navigatedWithinDocument') {
      if (params.frameId !== stream.mainFrameId) return;
    } else if (method !== 'Page.loadEventFired' && method !== 'Page.domContentEventFired') {
      return;
    }
    if (method !== 'Page.frameStartedLoading' && method !== 'Page.frameStoppedLoading') {
      viewport.observe(surfaceSession.sessionId, stream.targetId);
    }
    void refreshNavigation(surfaceSession, stream);
  };

  const startScreencastForTarget = (surfaceSession, targetId) => {
    const existing = surfaceSession.streams.get(targetId);
    if (existing) return existing.ready;
    const streamGen = (surfaceSession.streamGenerations.get(targetId) ?? 0) + 1;
    surfaceSession.streamGenerations.set(targetId, streamGen);
    const stream = {
      streamGen, targetId, cdpSessionId: null, eventUnsub: null,
      mainFrameId: null, isLoading: false, loadingRevision: 0,
      navigation: null, navigationRevision: 0, navigationPending: null, ready: null,
      viewportConfigKey: null, screencastCommandTail: Promise.resolve(),
    };
    surfaceSession.streams.set(targetId, stream);
    stream.ready = browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
      targetId,
      requireTargetOwnership: true,
      operation: async ({ cdp }) => {
        const attached = await cdp.attach(targetId);
        stream.cdpSessionId = attached;
        stream.eventUnsub = cdp.onEvent((event) => handleTargetEvent(surfaceSession, stream, event));
        await cdp.sendSession(attached, 'Page.enable');
        const frameTree = await cdp.sendSession(attached, 'Page.getFrameTree');
        stream.mainFrameId = frameTree.frameTree.frame.id;
        const loadingRevision = stream.loadingRevision;
        const loading = await cdp.sendSession(attached, 'Runtime.evaluate', {
          expression: 'document.readyState !== "complete"', returnByValue: true,
        });
        if (stream.loadingRevision === loadingRevision) {
          if (![true, false].includes(loading.result?.value)) throw new Error('Chrome returned invalid loading state');
          stream.isLoading = loading.result.value;
        }
        await cdp.sendSession(attached, 'Page.startScreencast', SCREENCAST_OPTIONS);
        return stream;
      },
    }).catch((error) => {
      stream.eventUnsub?.();
      if (surfaceSession.streams.get(targetId) === stream) surfaceSession.streams.delete(targetId);
      throw error;
    });
    return stream.ready;
  };

  const isCurrentStream = (surfaceSession, stream) => !surfaceSession.closed
    && surfaceSession.streams.get(stream.targetId) === stream;

  const queueScreencastCommand = (stream, operation) => {
    const command = stream.screencastCommandTail.then(operation, operation);
    stream.screencastCommandTail = command.then(() => undefined, () => undefined);
    return command;
  };

  const recoverScreencastForViewport = (viewer, confirmed) => {
    if (!browserSessionManager) return;
    const surfaceSession = viewer.surfaceSession;
    const targetId = viewer.tabId.startsWith('sc:') ? viewer.tabId.slice(3) : '';
    const stream = surfaceSession?.streams.get(targetId);
    if (!surfaceSession || !stream) return;
    const configKey = `${confirmed.width}:${confirmed.height}:${confirmed.mobile ? 1 : 0}`;
    if (stream.viewportConfigKey === configKey) return;
    stream.viewportConfigKey = configKey;
    const expectedStreamGen = stream.streamGen;
    void stream.ready.then(() => queueScreencastCommand(stream, () => browserSessionManager.runReadOnlyOperation(
      surfaceSession.sessionId,
      {
        targetId,
        requireTargetOwnership: true,
        operation: async ({ cdp }) => {
          if (!isCurrentStream(surfaceSession, stream) || stream.streamGen !== expectedStreamGen
            || stream.viewportConfigKey !== configKey) return;
          await cdp.sendSession(stream.cdpSessionId, 'Page.stopScreencast');
          if (!isCurrentStream(surfaceSession, stream) || stream.streamGen !== expectedStreamGen
            || stream.viewportConfigKey !== configKey) return;
          await cdp.sendSession(stream.cdpSessionId, 'Page.startScreencast', SCREENCAST_OPTIONS);
        },
      },
    ))).catch((error) => {
      if (isCurrentStream(surfaceSession, stream) && stream.viewportConfigKey === configKey) {
        logger.warn?.('[browser-surface] could not refresh screencast after viewport change:', error);
      }
    });
  };

  const stopScreencastForTarget = async (surfaceSession, targetId, expectedStreamGen) => {
    const stream = surfaceSession.streams.get(targetId);
    if (!stream || stream.streamGen !== expectedStreamGen) return;
    surfaceSession.streams.delete(targetId);
    stream.eventUnsub?.();
    if (!browserSessionManager) return;
    try {
      await stream.ready;
      stream.eventUnsub?.();
      await queueScreencastCommand(stream, () => browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
        targetId,
        requireTargetOwnership: true,
        operation: async ({ cdp }) => {
          const replacement = surfaceSession.streams.get(targetId);
          if (replacement && replacement.streamGen !== expectedStreamGen) return;
          await cdp.sendSession(stream.cdpSessionId, 'Page.stopScreencast').catch(() => {});
        },
      }));
    } catch {
      // best-effort cleanup
    }
  };

  const handleScreencastFrame = (surfaceSession, targetId, stream, event) => {
    if (surfaceSession.closed || !surfaceSession.streams.has(targetId)) return;
    const current = surfaceSession.streams.get(targetId);
    if (!current || current.streamGen !== stream.streamGen) return;

    const frameSeq = nextFrameSeq++;
    let data;
    try { data = Buffer.from(parseString(event.data), 'base64'); } catch { return; }
    const frame = {
      frameSeq,
      streamGen: stream.streamGen,
      tabId: `sc:${targetId}`,
      width: Number(event.metadata?.deviceWidth) || 0,
      height: Number(event.metadata?.deviceHeight) || 0,
      scale: Number(event.metadata?.deviceScaleFactor) || 1,
      data,
    };
    surfaceSession.latestFrame.set(targetId, frame);

    for (const viewer of surfaceSession.viewers) {
      if (!viewer.attached || viewer.tabId !== `sc:${targetId}`) continue;
      enqueueFrame(viewer, frame);
    }

    // Ack CDP after the frame is admitted to bounded queues.
    acknowledgeCdpFrame(surfaceSession, stream, event.sessionId);
  };

  const acknowledgeCdpFrame = async (surfaceSession, stream, frameSessionId) => {
    if (!browserSessionManager || surfaceSession.closed) return;
    try {
      await browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
        targetId: stream.targetId,
        requireTargetOwnership: true,
        operation: async ({ cdp }) => {
          await cdp.sendSession(stream.cdpSessionId, 'Page.screencastFrameAck', { sessionId: frameSessionId });
        },
      });
    } catch {
      // CDP may have closed; streamGen guard drops stale frames.
    }
  };

  const enqueueFrame = (viewer, frame) => {
    if (viewer.unacked.length >= MAX_UNACKED_FRAMES) {
      // Keep only the latest frame that has not crossed the socket boundary.
      viewer.pendingFrame = frame;
      return;
    }
    viewer.unacked.push(frame);
    sendFrame(viewer, frame);
  };

  const sendFrame = (viewer, frame) => {
    if (!viewer.attached || viewer.socket.readyState !== 1) return;
    try {
      viewer.socket.send(JSON.stringify({
        type: 'frame',
        frameSeq: frame.frameSeq,
        streamGen: frame.streamGen,
        tabId: frame.tabId,
        width: frame.width,
        height: frame.height,
        scale: frame.scale,
      }));
      viewer.socket.send(frame.data, { binary: true });
    } catch {
      // socket will close and clean up the viewer
    }
  };

  const onFrameAck = (viewer, frameSeq) => {
    const idx = viewer.unacked.findIndex((f) => f.frameSeq === frameSeq);
    if (idx < 0) return;
    viewer.unacked.splice(0, idx + 1);
    if (!viewer.pendingFrame || viewer.unacked.length >= MAX_UNACKED_FRAMES) return;
    const pending = viewer.pendingFrame;
    viewer.pendingFrame = null;
    viewer.unacked.push(pending);
    sendFrame(viewer, pending);
  };

  const sendState = (viewer, attachmentRequestId) => {
    const lease = browserSessionManager?.getLease(viewer.surfaceSession.sessionId) ?? null;
    const state = {
      type: 'state',
      tabId: viewer.attached ? viewer.tabId : null,
      lease,
      controlling: lease?.actor === 'user' && lease.viewerId === viewer.id,
    };
    if (attachmentRequestId) state.attachmentRequestId = attachmentRequestId;
    sendJson(viewer.socket, state);
  };

  const detachViewer = (viewer) => {
    contextMenu.detach(viewer);
    inspector.detach(viewer);
    devtools.detach(viewer);
    viewport.detach(viewer);
    const surfaceSession = viewer.surfaceSession;
    const previousTabId = viewer.tabId;
    viewer.surfaceSession = null;
    viewer.attached = false;
    viewer.tabId = '';
    viewer.attachmentRequestId = null;
    viewer.unacked = [];
    viewer.pendingFrame = null;
    if (!surfaceSession) return;
    surfaceSession.viewers.delete(viewer);
    if (browserSessionManager?.viewerDisconnect(surfaceSession.sessionId, viewer.id) && !surfaceSession.closed) {
      for (const remaining of surfaceSession.viewers) sendState(remaining);
    }
    if (previousTabId && ![...surfaceSession.viewers].some((current) => current.tabId === previousTabId)) {
      const targetId = previousTabId.slice(3);
      const stream = surfaceSession.streams.get(targetId);
      if (stream) void stopScreencastForTarget(surfaceSession, targetId, stream.streamGen);
    }
    if (surfaceSession.viewers.size > 0) return;
    surfaceSession.registryUnsub?.();
    surfaceSession.registryUnsub = null;
    surfaceSession.registryReady = null;
    surfaceSession.registryGeneration += 1;
    for (const [targetId, stream] of surfaceSession.streams) {
      void stopScreencastForTarget(surfaceSession, targetId, stream.streamGen);
    }
  };

  const watchSessionTabs = (surfaceSession) => {
    if (surfaceSession.registryReady) return surfaceSession.registryReady;
    const generation = ++surfaceSession.registryGeneration;
    surfaceSession.registryReady = browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
      targetId: 'tab list',
      operation: ({ cdp, browserContextId }) => {
        if (surfaceSession.closed || surfaceSession.viewers.size === 0 || surfaceSession.registryGeneration !== generation) return;
        let targetIds = new Set(cdp.getTabs(browserContextId).map((tab) => tab.targetId));
        surfaceSession.registryUnsub = cdp.onRegistry((event) => {
          const relevant = event.type === 'destroy' ? targetIds.has(event.targetId)
            : event.type === 'upsert' && event.target.type === 'page' && event.target.browserContextId === browserContextId;
          if (!relevant || surfaceSession.closed) return;
          const tabs = cdp.getTabs(browserContextId).map((tab) => ({
            id: `sc:${tab.targetId}`, targetId: tab.targetId, title: tab.title ?? '', url: tab.url ?? '',
          }));
          targetIds = new Set(tabs.map((tab) => tab.targetId));
          if (event.type === 'destroy') {
            viewport.dropTarget(surfaceSession.sessionId, event.targetId);
            const stream = surfaceSession.streams.get(event.targetId);
            if (stream) void stopScreencastForTarget(surfaceSession, event.targetId, stream.streamGen);
            surfaceSession.latestFrame.delete(event.targetId);
            surfaceSession.streamGenerations.delete(event.targetId);
            for (const current of surfaceSession.viewers) {
              if (current.tabId !== `sc:${event.targetId}`) continue;
              contextMenu.detach(current);
              inspector.detach(current);
              devtools.detach(current);
              viewport.detach(current);
              current.attachmentGeneration += 1;
              current.attached = false;
              current.tabId = '';
              current.attachmentRequestId = null;
              current.unacked = [];
              current.pendingFrame = null;
            }
          }
          for (const current of surfaceSession.viewers) sendJson(current.socket, { type: 'tabs', tabs });
        });
      },
    }).catch((error) => {
      if (surfaceSession.registryGeneration === generation) surfaceSession.registryReady = null;
      throw error;
    });
    return surfaceSession.registryReady;
  };

  const attachViewerToSession = async (viewer, session, directory) => {
    if (viewer.surfaceSession?.sessionId === session.id) return;
    detachViewer(viewer);
    viewer.surfaceSession = createSurfaceSession(session.id, directory);
    viewer.surfaceSession.viewers.add(viewer);
    browserSessionManager.viewerConnect(session.id, viewer.id);
    await watchSessionTabs(viewer.surfaceSession);
  };

  const attachViewerToTab = async (viewer, tabId, requestId) => {
    if (!browserSessionManager) return false;
    contextMenu.detach(viewer);
    inspector.detach(viewer);
    devtools.detach(viewer);
    viewport.detach(viewer);
    const surfaceSession = viewer.surfaceSession;
    const attachmentGeneration = ++viewer.attachmentGeneration;
    const isCurrent = () => viewer.socket.readyState === 1 && viewer.surfaceSession === surfaceSession
      && viewer.attachmentGeneration === attachmentGeneration && !surfaceSession.closed;
    if (!surfaceSession || !isCurrent()) return false;
    const targetId = tabId.startsWith('sc:') ? tabId.slice(3) : '';
    if (!targetId) return false;

    // Ensure the target exists in this session.
    const tabs = await browserSessionManager.listTabs(surfaceSession.sessionId);
    if (!isCurrent() || !tabs.some((tab) => tab.id === tabId)) return false;

    const previousTargetId = viewer.tabId.slice(3);
    viewer.tabId = tabId;
    viewer.attached = false;
    viewer.unacked = [];
    viewer.pendingFrame = null;
    if (previousTargetId && previousTargetId !== targetId
      && ![...surfaceSession.viewers].some((current) => current.tabId === `sc:${previousTargetId}`)) {
      const previousStream = surfaceSession.streams.get(previousTargetId);
      if (previousStream) void stopScreencastForTarget(surfaceSession, previousTargetId, previousStream.streamGen);
    }
    const stream = await startScreencastForTarget(surfaceSession, targetId);
    if (!isCurrent()) {
      if (![...surfaceSession.viewers].some((current) => current.tabId === tabId)) {
        await stopScreencastForTarget(surfaceSession, targetId, stream.streamGen);
      }
      return false;
    }
    viewer.attached = true;
    viewer.attachmentRequestId = requestId ?? null;

    // Late joiner: send cached latest frame first.
    const cached = surfaceSession.latestFrame.get(targetId);
    if (cached) enqueueFrame(viewer, cached);
    await refreshNavigation(surfaceSession, stream);
    if (!isCurrent()) return false;
    return true;
  };

  async function runViewerOperation(viewer, targetId, operation) {
    if (!browserSessionManager) return;
    const surfaceSession = viewer.surfaceSession;
    const attachmentGeneration = viewer.attachmentGeneration;
    if (!surfaceSession || surfaceSession.closed) return;

    // Takeover bumps the lease generation.
    const lease = browserSessionManager.viewerTakeover(surfaceSession.sessionId, viewer.id);
    for (const currentViewer of surfaceSession.viewers) sendState(currentViewer);

    const isCurrent = () => {
      const currentLease = browserSessionManager.getLease(surfaceSession.sessionId);
      return viewer.socket.readyState === 1 && viewer.surfaceSession === surfaceSession && !surfaceSession.closed
        && viewer.attachmentGeneration === attachmentGeneration
        && (!targetId || (viewer.attached && viewer.tabId === `sc:${targetId}`))
        && currentLease?.viewerId === viewer.id && currentLease.generation === lease.generation;
    };
    return browserSessionManager.runReadOnlyOperation(surfaceSession.sessionId, {
      targetId: targetId || 'new tab',
      requireTargetOwnership: Boolean(targetId),
      operation: async (context) => {
        if (!isCurrent()) return null;
        if (targetId) {
          await context.cdp.sendSession(context.cdp.getSessionId(targetId), 'Page.bringToFront');
          if (!isCurrent()) return null;
        }
        return operation({ ...context, isCurrent, surfaceSession });
      },
    });
  }

  const dispatchInput = (viewer, input) => runViewerOperation(viewer, viewer.tabId.slice(3),
      async ({ cdp }) => {
        const cdpSessionId = cdp.getSessionId(input.tabId.slice(3));
        if (input.type === 'pointer') {
          const params = {
            type: input.eventType === 'down' ? 'mousePressed' : input.eventType === 'up' ? 'mouseReleased' : 'mouseMoved',
            x: input.x,
            y: input.y,
            button: input.button === 2 ? 'right' : input.button === 1 ? 'middle' : 'left',
            clickCount: 1,
          };
          await cdp.sendSession(cdpSessionId, 'Input.dispatchMouseEvent', params);
        } else if (input.type === 'wheel') {
          await cdp.sendSession(cdpSessionId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY,
            modifiers: modifierBitmap(input.modifiers ?? []),
          });
        } else if (input.type === 'key') {
          const params = {
            type: input.eventType === 'keydown' ? 'keyDown' : 'keyUp',
            key: input.key,
            modifiers: input.modifiers?.length ? modifierBitmap(input.modifiers) : 0,
          };
          const windowsVirtualKeyCode = EDITING_KEY_CODES.get(input.key);
          if (windowsVirtualKeyCode !== undefined) {
            params.code = input.key;
            params.windowsVirtualKeyCode = windowsVirtualKeyCode;
          }
          if (input.eventType === 'keydown' && input.key === 'Enter'
            && !input.modifiers.some((modifier) => modifier !== 'Shift')) {
            params.text = '\r';
          }
          if (input.eventType === 'keydown' && input.key.toLowerCase() === 'a'
            && input.modifiers.some((modifier) => modifier === 'Control' || modifier === 'Meta')
            && !input.modifiers.includes('Alt') && !input.modifiers.includes('Shift')) {
            params.commands = ['selectAll'];
          }
          await cdp.sendSession(cdpSessionId, 'Input.dispatchKeyEvent', params);
        } else if (input.type === 'text') {
          await cdp.sendSession(cdpSessionId, 'Input.insertText', { text: input.text });
        }
      });

  const dispatchNavigation = (viewer, command) => runViewerOperation(viewer, command.tabId.slice(3),
    async ({ cdp, isCurrent, surfaceSession }) => {
      const targetId = command.tabId.slice(3);
      const cdpSessionId = cdp.getSessionId(targetId);
      if (command.type === 'navigate') {
        const result = await cdp.sendSession(cdpSessionId, 'Page.navigate', { url: command.url });
        if (result.errorText) throw new Error(result.errorText);
      } else if (command.type === 'back' || command.type === 'forward') {
        const history = parseNavigationHistory(await cdp.sendSession(cdpSessionId, 'Page.getNavigationHistory'));
        if (!isCurrent()) return;
        const entry = history.entries[history.currentIndex + (command.type === 'back' ? -1 : 1)];
        if (entry) await cdp.sendSession(cdpSessionId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      } else {
        await cdp.sendSession(cdpSessionId, command.type === 'reload' ? 'Page.reload' : 'Page.stopLoading');
      }
      if (!isCurrent()) return;
      const stream = surfaceSession.streams.get(targetId);
      if (stream) await refreshNavigation(surfaceSession, stream);
    });

  const dispatchCopy = (viewer, request) => {
    const surfaceSession = viewer.surfaceSession;
    const attachmentGeneration = viewer.attachmentGeneration;
    const pending = runViewerOperation(viewer, request.tabId.slice(3), async ({ cdp, isCurrent }) => {
      if (!isCurrent()) return;
      const result = await cdp.sendSession(cdp.getSessionId(request.tabId.slice(3)), 'Runtime.evaluate', {
        expression: REMOTE_SELECTION_EXPRESSION, returnByValue: true, timeout: 1_000,
      });
      if (!isCurrent()) return;
      if (result.exceptionDetails || result.result?.value?.code === 'COPY_FAILED') {
        sendCopyFailure(viewer.socket, request, 'COPY_FAILED');
        return;
      }
      if (result.result?.value?.code === 'COPY_TOO_LARGE') {
        sendCopyFailure(viewer.socket, request, 'COPY_TOO_LARGE');
        return;
      }
      const text = parseString(result.result?.value?.text);
      if (!text) {
        sendCopyFailure(viewer.socket, request, 'NO_SELECTION');
        return;
      }
      const response = { type: 'copyResult', ...request, ok: true, text };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > SURFACE_WS_MAX_PAYLOAD_BYTES) {
        sendCopyFailure(viewer.socket, request, 'COPY_TOO_LARGE');
        return;
      }
      sendJson(viewer.socket, response);
    });
    const lease = browserSessionManager.getLease(surfaceSession.sessionId);
    return pending.catch(() => {
      const currentLease = browserSessionManager.getLease(surfaceSession.sessionId);
      if (viewer.socket.readyState !== 1 || viewer.surfaceSession !== surfaceSession || surfaceSession.closed
        || viewer.attachmentGeneration !== attachmentGeneration || !viewer.attached || viewer.tabId !== request.tabId
        || currentLease?.viewerId !== viewer.id || currentLease?.generation !== lease?.generation) return;
      sendCopyFailure(viewer.socket, request, 'COPY_FAILED');
    });
  };

  const createViewerTab = (viewer) => runViewerOperation(viewer, null,
    async ({ cdp, browserContextId, isCurrent, surfaceSession }) => {
      const result = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const targetId = parseString(result.targetId);
      if (!targetId) throw new Error('Chrome returned no target id');
      if (!isCurrent()) return;
      const tabs = await browserSessionManager.listTabs(surfaceSession.sessionId);
      if (!isCurrent()) return;
      const tabId = `sc:${targetId}`;
      if (!tabs.some((tab) => tab.id === tabId)) {
        tabs.push({ id: tabId, targetId, url: 'about:blank', title: '' });
      }
      for (const current of surfaceSession.viewers) {
        const message = { type: 'tabs', tabs };
        if (current === viewer) message.activeTabId = tabId;
        sendJson(current.socket, message);
      }
    });

  const modifierBitmap = (modifiers) => {
    let mask = 0;
    for (const m of modifiers) {
      if (m === 'Alt') mask |= 1;
      if (m === 'Control') mask |= 2;
      if (m === 'Meta') mask |= 4;
      if (m === 'Shift') mask |= 8;
    }
    return mask;
  };

  const handleHandshake = async (viewer, message) => {
    const directory = getDirectory(viewer.req);
    if (!directory) {
      sendJson(viewer.socket, { type: 'error', code: 'DIRECTORY_REQUIRED', message: 'directory query param required' });
      viewer.socket.close(1008, 'directory required');
      return;
    }

    const action = message.action ?? message.type;
    if (action === 'list') {
      if (!browserSessionManager) {
        sendJson(viewer.socket, { type: 'list', sessions: [] });
        return;
      }
      const all = await browserSessionManager.listSessions?.() ?? [];
      const seen = new Set();
      const merged = [];
      for (const s of all) {
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        if (s.directory === directory) merged.push({ id: s.id, directory: s.directory, persistence: s.persistence });
      }
      sendJson(viewer.socket, { type: 'list', sessions: merged });
      return;
    }

    if (action === 'create') {
      if (!browserSessionManager) {
        sendJson(viewer.socket, { type: 'error', code: 'BACKEND_UNAVAILABLE', message: 'Browser backend unavailable' });
        return;
      }
      const attachmentGeneration = ++viewer.attachmentGeneration;
      const session = await browserSessionManager.createSession({ directory });
      const tabs = await browserSessionManager.listTabs(session.id);
      if (viewer.socket.readyState !== 1 || viewer.attachmentGeneration !== attachmentGeneration) return;
      await attachViewerToSession(viewer, session, directory);
      if (viewer.socket.readyState !== 1 || viewer.attachmentGeneration !== attachmentGeneration) return;
      sendJson(viewer.socket, {
        type: 'created',
        session: { id: session.id, directory: session.directory, persistence: session.persistence },
        tabs: tabs.map((t) => ({ id: t.id, targetId: t.targetId, title: t.title, url: t.url })),
      });
      return;
    }

    if (action === 'attach') {
      if (!browserSessionManager) {
        sendJson(viewer.socket, { type: 'error', code: 'BACKEND_UNAVAILABLE', message: 'Browser backend unavailable' });
        return;
      }
      const sessionId = message.sessionId || getSessionId(viewer.req);
      if (!sessionId) {
        sendJson(viewer.socket, { type: 'error', code: 'SESSION_ID_REQUIRED', message: 'sessionId required for attach' });
        return;
      }
      const session = browserSessionManager.getSession?.(sessionId);
      if (!session || session.directory !== directory) {
        sendJson(viewer.socket, { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Session not found' });
        return;
      }
      const attachmentGeneration = ++viewer.attachmentGeneration;
      const tabs = await browserSessionManager.listTabs(session.id);
      if (viewer.socket.readyState !== 1 || viewer.attachmentGeneration !== attachmentGeneration) return;
      await attachViewerToSession(viewer, session, directory);
      if (viewer.socket.readyState !== 1 || viewer.attachmentGeneration !== attachmentGeneration) return;
      sendJson(viewer.socket, {
        type: 'attached',
        session: { id: session.id, directory: session.directory, persistence: session.persistence },
        tabs: tabs.map((t) => ({ id: t.id, targetId: t.targetId, title: t.title, url: t.url })),
      });
      return;
    }

    sendJson(viewer.socket, { type: 'error', code: 'BAD_ACTION', message: 'Expected list, attach, or create' });
  };

  wsServer.on('connection', (socket, req) => {
    const viewer = {
      id: randomUUID(),
      socket,
      req,
      attached: false,
      tabId: '',
      surfaceSession: null,
      attachmentGeneration: 0,
      attachmentRequestId: null,
      unacked: [],
      pendingFrame: null,
    };

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return; // binary payloads are JPEG frames from server
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        logger.warn?.('[browser-surface] ignored malformed JSON message');
        return;
      }
      let type;
      try { type = parseString(message?.type); } catch { return; }
      if (inspector.handle(viewer, message, type)) return;
      if (devtools.handle(viewer, message, type)) return;
      if (viewport.handle(viewer, message, type)) return;
      if (contextMenu.handle(viewer, message, type)) return;
      if (type === 'frameAck') {
        if (Number.isInteger(message.frameSeq) && message.frameSeq >= 0) onFrameAck(viewer, message.frameSeq);
        return;
      }
      if (type === 'attachTab') {
        let tabId;
        try {
          tabId = parseString(message.tabId);
          if (!tabId) throw new Error('tabId required');
        } catch {
          sendJson(socket, { type: 'error', code: 'BAD_TAB_ID', message: 'tabId required' });
          return;
        }
        let requestId;
        try {
          if (message.requestId !== undefined) {
            requestId = parseString(message.requestId);
            if (!requestId || requestId.length > 128) throw new Error('Invalid attachment request identity');
          }
        } catch {
          sendJson(socket, { type: 'error', code: 'BAD_REQUEST_ID', message: 'Expected a nonempty requestId of at most 128 characters' });
          return;
        }
        void (async () => {
          const attachment = attachViewerToTab(viewer, tabId, requestId);
          const generation = viewer.attachmentGeneration;
          const isCurrent = () => socket.readyState === 1 && viewer.attachmentGeneration === generation;
          try {
            const ok = await attachment;
            if (!isCurrent()) return;
            if (ok) {
              sendState(viewer, requestId);
              viewport.attach(viewer);
            } else {
              sendJson(socket, { type: 'error', code: 'TAB_NOT_FOUND', message: 'Tab not found' });
            }
          } catch (err) {
            if (!isCurrent()) return;
            logger.warn?.('[browser-surface] attachViewerToTab error:', err);
            sendJson(socket, { type: 'error', code: 'ATTACH_FAILED', message: String(err?.message ?? err) });
          }
        })();
        return;
      }
      if (['pointer', 'key', 'text', 'wheel'].includes(type)) {
        if (!viewer.attached) {
          sendJson(socket, { type: 'error', code: 'NOT_ATTACHED', message: 'Input requires attached tab' });
          return;
        }
        let input;
        try {
          input = parseInput(message);
          if (input.tabId !== viewer.tabId) throw new Error('Expected the attached tab');
        } catch {
          logger.warn?.('[browser-surface] ignored malformed input message');
          return;
        }
        if (input.type === 'wheel' || (input.type === 'pointer' && input.eventType === 'down')
          || (input.type === 'key' && input.key === 'Escape')) contextMenu.detach(viewer);
        void dispatchInput(viewer, input).catch((error) => {
          logger.warn?.(`[browser-surface] input dispatch failed: ${error?.message ?? error}`);
        });
        return;
      }
      if (type === 'copy') {
        let request;
        try { request = parseCopy(message); } catch { return; }
        if (!viewer.attached || request.tabId !== viewer.tabId) {
          sendCopyFailure(socket, request, 'COPY_FAILED');
          return;
        }
        void dispatchCopy(viewer, request);
        return;
      }
      if (['navigate', 'back', 'forward', 'reload', 'stop'].includes(type)) {
        let command;
        try { command = parseNavigation(message); } catch {
          sendJson(socket, { type: 'error', code: 'INVALID_NAVIGATION', message: 'Expected a browser tab and an HTTP or HTTPS address' });
          return;
        }
        if (!viewer.attached || command.tabId !== viewer.tabId) {
          sendJson(socket, { type: 'error', code: 'NOT_ATTACHED', message: 'Navigation requires the attached tab' });
          return;
        }
        contextMenu.detach(viewer);
        void dispatchNavigation(viewer, command).catch((error) => {
          sendJson(socket, { type: 'error', code: 'NAVIGATION_FAILED', message: String(error?.message ?? error) });
        });
        return;
      }
      if (type === 'createTab') {
        if (!viewer.surfaceSession) {
          sendJson(socket, { type: 'error', code: 'NOT_ATTACHED', message: 'Creating a tab requires an attached session' });
          return;
        }
        void createViewerTab(viewer).catch((error) => {
          sendJson(socket, { type: 'error', code: 'CREATE_TAB_FAILED', message: String(error?.message ?? error) });
        });
        return;
      }
      if (type === 'list' || type === 'create' || type === 'attach') {
        // Backwards-compatible handshake using type as action.
        const handshake = { action: type };
        try {
          if (message.sessionId !== undefined) handshake.sessionId = parseString(message.sessionId);
        } catch {
          sendJson(socket, { type: 'error', code: 'BAD_HANDSHAKE', message: 'Expected a browser session identity' });
          return;
        }
        void handleHandshake(viewer, handshake).catch((error) => {
          sendJson(socket, { type: 'error', code: 'HANDSHAKE_FAILED', message: String(error?.message ?? error) });
        });
        return;
      }
      logger.warn?.(`[browser-surface] ignored unknown message type: ${type}`);
    });

    socket.on('close', () => {
      detachViewer(viewer);
    });

    // Initial handshake message is expected from client.
    sendJson(socket, { type: 'hello' });
  });

  const upgradeHandler = (req, socket, head) => {
    if (!isBrowserSurfacePath(req.url)) return;

    void (async () => {
      try {
        // OC-01: origin validation is unconditional.
        const originAllowed = await isRequestOriginAllowed(req);
        if (!originAllowed) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }

        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }
        } else if (!await getAuthContext(req)) {
          // Metis B3: input-bearing channel never runs unauthenticated when uiAuth is disabled.
          rejectWebSocketUpgrade(socket, 401, 'Client authentication required');
          return;
        }

        if (!browserSessionManager) {
          rejectWebSocketUpgrade(socket, 503, 'Browser backend unavailable');
          return;
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    })();
  };

  server.on('upgrade', upgradeHandler);

  return {
    path: SURFACE_WS_PATH,
    handleUpgrade: upgradeHandler,
    handleDevToolsAssetRequest(req, res) { return devtools.handleAssetRequest(req, res); },
    dispose() {
      contextMenu.dispose();
      inspector.dispose();
      devtools.dispose();
      viewport.dispose();
      lifecycleUnsubscribe?.();
      server.off('upgrade', upgradeHandler);
      for (const surfaceSession of sessions.values()) closeSurfaceSession(surfaceSession);
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
    },
  };
}
