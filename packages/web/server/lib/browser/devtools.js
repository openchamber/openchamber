import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createWebSocketStream } from 'ws';
import { createDevToolsAssetHandler } from './devtools-assets.js';
import { connectDevToolsWebSocket, getDevToolsPageSocketUrl } from './devtools-connection.js';
import { acknowledgeDevToolsMessage, clearDevToolsOutbound, createDevToolsOutbound } from './devtools-outbound.js';
import { createDevToolsPolicy } from './devtools-policy.js';
import {
  closeDevToolsSocket, handleClosingTraceMessage, releaseDevToolsTracing, trackDevToolsTraceResponse,
} from './devtools-tracing.js';
import {
  rejectDevToolsViewportCommands, runDevToolsViewportCommand, settleDevToolsViewportCommand,
} from './devtools-viewport.js';
import {
  createCommandAssembler,
  MAX_MESSAGE_BYTES,
  parseDevToolsAck,
  parseDevToolsStart,
  parseDevToolsStop,
} from './devtools-wire.js';
const COMMANDS = new Set(['devtoolsStart', 'devtoolsCommandChunk', 'devtoolsChunkAck', 'devtoolsStop']);
const ERRORS = {
  DEVTOOLS_INVALID_REQUEST: 'The DevTools request is invalid',
  DEVTOOLS_START_FAILED: 'Could not open DevTools for this page',
  DEVTOOLS_PROTOCOL_REJECTED: 'This DevTools command is not allowed',
  DEVTOOLS_CONTROL_LOST: 'DevTools lost control of this page',
  DEVTOOLS_CONNECTION_CLOSED: 'The DevTools connection closed',
  DEVTOOLS_MESSAGE_TOO_LARGE: 'A DevTools protocol message exceeded the size limit',
  DEVTOOLS_BACKPRESSURE: 'The DevTools connection could not keep up',
  DEVTOOLS_EXCLUSIVE_CONTEXT_REQUIRED: 'Performance recording requires an exclusive browser session',
};

export function createBrowserDevTools({
  browserSessionManager,
  runViewerOperation,
  sendJson,
  logger = console,
  onViewportOverride = () => {},
  connectWebSocket = connectDevToolsWebSocket,
  fetchDevToolsAsset,
  randomBytes = nodeRandomBytes,
}) {
  const states = new Map();
  const assets = createDevToolsAssetHandler({ fetchAsset: fetchDevToolsAsset, randomBytes });

  const sendStartError = (viewer, request, code) => sendJson(viewer.socket, {
    type: 'devtoolsError', ...request, code, message: ERRORS[code],
  });

  const isCurrent = (state) => {
    const viewer = state.viewer;
    const lease = browserSessionManager.getLease(state.sessionId);
    return states.get(viewer) === state && !state.closed && viewer.socket.readyState === 1 && viewer.attached
      && viewer.surfaceSession === state.surfaceSession && !state.surfaceSession.closed && viewer.tabId === state.tabId
      && viewer.attachmentGeneration === state.attachmentGeneration
      && viewer.attachmentRequestId === state.attachmentRequestId
      && lease?.actor === 'user' && lease.viewerId === viewer.id && lease.generation === state.leaseGeneration;
  };

  const cleanup = (state) => {
    if (state.closed) return;
    state.closed = true;
    if (states.get(state.viewer) === state) states.delete(state.viewer);
    state.assembler.clear();
    assets.revoke(state.assetGrant);
    rejectDevToolsViewportCommands(state);
    clearDevToolsOutbound(state);
    if (state.opened) {
      state.opened = false;
      onViewportOverride(state.viewer, {
        type: 'close', tabId: state.tabId, sessionId: state.sessionId, devtoolsId: state.devtoolsId,
      });
    }
    closeDevToolsSocket(state);
    if (state.traceRelease) {
      while (state.inbound?.readableLength) state.inbound.read();
    }
    state.inbound?.resume();
  };

  const closeWith = (state, code, cause = code) => {
    if (state.closed) return;
    if (!isCurrent(state) && code !== 'DEVTOOLS_CONTROL_LOST') { cleanup(state); return; }
    logger.warn('[Browser DevTools] Connection closed', { code, cause, ...outbound.diagnostics(state) });
    sendJson(state.viewer.socket, { type: 'devtoolsClosed', devtoolsId: state.devtoolsId, code, message: ERRORS[code] });
    cleanup(state);
  };

  const outbound = createDevToolsOutbound({ isCurrent, closeWith, sendJson });

  const handleSocketMessage = (state, data) => {
    if (!isCurrent(state)) { closeWith(state, 'DEVTOOLS_CONTROL_LOST'); return; }
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const result = state.policy.event(raw);
    if (!result.ok) { closeWith(state, 'DEVTOOLS_PROTOCOL_REJECTED'); return; }
    settleDevToolsViewportCommand(state, result.message);
    trackDevToolsTraceResponse(state, result.message);
    if (result.trace === 'complete') {
      releaseDevToolsTracing(state);
    }
    outbound.queue(state, JSON.stringify(result.message));
  };

  const start = async (viewer, request) => {
    const state = {
      viewer, tabId: request.tabId, targetId: request.tabId.slice(3), attachmentRequestId: request.attachmentRequestId,
      attachmentGeneration: viewer.attachmentGeneration, surfaceSession: viewer.surfaceSession,
      sessionId: viewer.surfaceSession.sessionId, leaseGeneration: null, devtoolsId: randomBytes(18).toString('base64url'),
      assetGrant: null, socket: null, inbound: null, policy: null, assembler: createCommandAssembler(), outbound: new Map(),
      outboundBytes: 0, inboundBytes: 0, nextMessageId: 0, commandChain: Promise.resolve(), viewportCommands: new Map(),
      traceRelease: null, traceStartId: null, traceCleanupTimer: null, opened: false, closed: false,
    };
    states.set(viewer, state);
    try {
      let connection;
      await runViewerOperation(viewer, state.targetId, async ({ isCurrent: controlIsCurrent }) => {
        if (!controlIsCurrent()) throw new Error('stale');
        connection = await browserSessionManager.getPageConnection(state.sessionId, state.targetId);
        if (!controlIsCurrent()) throw new Error('stale');
      });
      const lease = browserSessionManager.getLease(state.sessionId);
      state.leaseGeneration = lease?.generation;
      state.policy = createDevToolsPolicy(connection);
      state.assetGrant = assets.grant(connection.webSocketDebuggerUrl);
      state.socket = await connectWebSocket(getDevToolsPageSocketUrl(connection.webSocketDebuggerUrl, state.targetId));
      if (!isCurrent(state)) throw new Error('stale');
      state.socket.on('error', () => { if (!state.closed) closeWith(state, 'DEVTOOLS_CONNECTION_CLOSED'); });
      state.socket.on('message', (data) => {
        state.inboundBytes += Buffer.byteLength(data);
        if (!state.closed && state.inboundBytes + state.outboundBytes > MAX_MESSAGE_BYTES) {
          closeWith(state, 'DEVTOOLS_BACKPRESSURE', 'ingress-bytes');
        }
      });
      state.inbound = createWebSocketStream(state.socket, { readableObjectMode: true, readableHighWaterMark: 1 });
      state.inbound.on('data', (data) => {
        state.inboundBytes -= Buffer.byteLength(data);
        if (state.closed) handleClosingTraceMessage(state, data); else handleSocketMessage(state, data);
      });
      state.inbound.on('end', () => state.inbound.destroy());
      state.inbound.on('error', () => { if (!state.closed) closeWith(state, 'DEVTOOLS_CONNECTION_CLOSED'); });
      state.socket.on('close', () => {
        if (!state.closed) closeWith(state, 'DEVTOOLS_CONNECTION_CLOSED');
      });
      state.opened = true;
      onViewportOverride(viewer, {
        type: 'open', tabId: state.tabId, sessionId: state.sessionId, devtoolsId: state.devtoolsId,
      });
      sendJson(viewer.socket, {
        type: 'devtoolsStarted', ...request, devtoolsId: state.devtoolsId,
        frontendPath: `/api/browser-devtools/${state.assetGrant}/inspector.html`,
      });
    } catch {
      const report = states.get(viewer) === state && !state.closed;
      cleanup(state);
      if (report) sendStartError(viewer, request, 'DEVTOOLS_START_FAILED');
    }
  };

  const forwardCommand = async (state, allowed) => {
    if (!isCurrent(state)) { closeWith(state, 'DEVTOOLS_CONTROL_LOST'); return; }
    const viewer = state.viewer;
    if (allowed.trace === 'start') {
      if (state.traceRelease || !browserSessionManager.acquireExclusiveBrowserContext) {
        closeWith(state, 'DEVTOOLS_EXCLUSIVE_CONTEXT_REQUIRED'); return;
      }
      try { state.traceRelease = await browserSessionManager.acquireExclusiveBrowserContext(state.sessionId); } catch {
        closeWith(state, 'DEVTOOLS_EXCLUSIVE_CONTEXT_REQUIRED'); return;
      }
      state.traceStartId = allowed.message.id;
      if (!isCurrent(state)) { closeWith(state, 'DEVTOOLS_CONTROL_LOST'); return; }
    }
    if (allowed.viewportChanged) {
      await runDevToolsViewportCommand({ state, message: allowed.message, isCurrent, onViewportOverride, closeWith });
      return;
    }
    try { state.socket.send(JSON.stringify(allowed.message)); } catch {
      closeWith(state, 'DEVTOOLS_CONNECTION_CLOSED'); return;
    }
    if (allowed.closedHandle) state.policy.closeHandle(allowed.closedHandle);
  };

  const commandChunk = (viewer, message) => {
    const state = states.get(viewer);
    if (!state || message.devtoolsId !== state.devtoolsId || !isCurrent(state)) {
      if (state) closeWith(state, 'DEVTOOLS_CONTROL_LOST');
      return;
    }
    let assembled;
    try { assembled = state.assembler.accept(message); } catch { closeWith(state, 'DEVTOOLS_INVALID_REQUEST'); return; }
    if (assembled.ack !== null) sendJson(viewer.socket, {
      type: 'devtoolsChunkAck', devtoolsId: state.devtoolsId, direction: 'command',
      messageId: assembled.messageId, index: assembled.ack,
    });
    if (!assembled.raw) return;
    const allowed = state.policy.command(assembled.raw);
    if (!allowed.ok) {
      if (allowed.response) outbound.queue(state, JSON.stringify(allowed.response));
      else closeWith(state, 'DEVTOOLS_PROTOCOL_REJECTED');
      return;
    }
    state.commandChain = state.commandChain.then(() => forwardCommand(state, allowed));
  };

  const acknowledge = (viewer, message) => {
    const state = states.get(viewer);
    if (!state || message.devtoolsId !== state.devtoolsId || !isCurrent(state)) return;
    let ack;
    try { ack = parseDevToolsAck(message); } catch { closeWith(state, 'DEVTOOLS_INVALID_REQUEST'); return; }
    if (ack.direction !== 'message') { closeWith(state, 'DEVTOOLS_INVALID_REQUEST'); return; }
    if (!acknowledgeDevToolsMessage(state, ack)) { closeWith(state, 'DEVTOOLS_INVALID_REQUEST'); return; }
    outbound.pump(state);
  };

  const detach = (viewer) => { const state = states.get(viewer); if (state) cleanup(state); };

  const handle = (viewer, message, type) => {
    if (!COMMANDS.has(type)) return false;
    if (type === 'devtoolsStart') {
      let request;
      try { request = parseDevToolsStart(message); } catch {
        sendStartError(viewer, { tabId: '', requestId: '', attachmentRequestId: '' }, 'DEVTOOLS_INVALID_REQUEST');
        return true;
      }
      if (!viewer.attached || request.tabId !== viewer.tabId || request.attachmentRequestId !== viewer.attachmentRequestId) {
        sendStartError(viewer, request, 'DEVTOOLS_INVALID_REQUEST'); return true;
      }
      detach(viewer);
      void start(viewer, request);
    } else if (type === 'devtoolsCommandChunk') {
      commandChunk(viewer, message);
    } else if (type === 'devtoolsChunkAck') {
      acknowledge(viewer, message);
    } else {
      let request;
      try { request = parseDevToolsStop(message); } catch { return true; }
      const state = states.get(viewer);
      if (state && (!request.devtoolsId || request.devtoolsId === state.devtoolsId)) {
        const devtoolsId = state.devtoolsId;
        cleanup(state);
        sendJson(viewer.socket, { type: 'devtoolsStopped', devtoolsId });
      }
    }
    return true;
  };

  return {
    handle,
    detach,
    handleAssetRequest: assets.handle,
    dispose() { for (const state of states.values()) cleanup(state); assets.dispose(); },
  };
}
