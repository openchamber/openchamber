import { randomUUID } from 'node:crypto';
import { createInspectorCapture } from './inspector-capture.js';
import { boundedString, formatRemoteObject, normalizeBody } from './inspector-format.js';

const COMMANDS = new Set(['inspectorStart', 'inspectorStop', 'inspectorClear', 'inspectorEvaluate', 'inspectorRequest']);
const MESSAGES = {
  UNAVAILABLE: 'The inspector requires an attached browser tab',
  INVALID_REQUEST: 'The inspector request is invalid or another request is still running',
  CAPTURE_GONE: 'This inspector capture is no longer available',
  EVALUATION_FAILED: 'Could not run JavaScript in this page',
  EVALUATION_TIMEOUT: 'JavaScript evaluation exceeded the time limit',
  REQUEST_GONE: 'This captured request is no longer available',
  REQUEST_FAILED: 'Could not read the captured request',
  CAPTURE_FAILED: 'Could not start the browser inspector',
};
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_SOCKET_BYTES = 128 * 1024;
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function fitReply(message) {
  while (byteLength(message) >= MAX_REPLY_BYTES) {
    message.truncated = true;
    if (message.requestHeaders?.length || message.responseHeaders?.length) {
      const headers = message.requestHeaders.length >= message.responseHeaders.length ? message.requestHeaders : message.responseHeaders;
      headers.pop();
    } else if (message.requestBody?.length || message.responseBody?.length) {
      const key = (message.requestBody?.length ?? 0) >= (message.responseBody?.length ?? 0) ? 'requestBody' : 'responseBody';
      message[key] = message[key].slice(0, Math.floor(message[key].length / 2));
    } else {
      message.text = message.text.slice(0, Math.floor(message.text.length / 2));
    }
  }
  return message;
}

function createJob() {
  const controller = new AbortController();
  const job = { controller, timedOut: false, timer: null };
  job.timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, 5_000);
  job.timer.unref?.();
  return job;
}

async function waitForJob(operation, job) {
  const signal = job.controller.signal;
  let onAbort;
  const canceled = new Promise((resolve) => {
    onAbort = () => resolve({ canceled: true });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation.then((value) => ({ value }), (error) => ({ error })), canceled]);
  } finally {
    clearTimeout(job.timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export function createBrowserInspector({ browserSessionManager, runViewerOperation, sendJson, parseString }) {
  const captures = new Map();
  const channels = new Map();

  const identity = (value) => {
    const text = parseString(value);
    if (!text || text.length > 128) throw new Error('Invalid inspector identity');
    return text;
  };

  const parseRequest = (message, type) => {
    const request = { tabId: identity(message.tabId), requestId: identity(message.requestId) };
    if (type !== 'inspectorStart' && (type !== 'inspectorStop' || message.captureId !== undefined)) {
      request.captureId = identity(message.captureId);
    }
    if (type === 'inspectorClear') {
      if (!['console', 'network'].includes(message.scope)) throw new Error('Invalid inspector scope');
      request.scope = message.scope;
    } else if (type === 'inspectorEvaluate') {
      request.expression = parseString(message.expression);
      if (request.expression.length > 16_000) throw new Error('Inspector expression too long');
    } else if (type === 'inspectorRequest') {
      request.entryId = identity(message.entryId);
      if (message.includeBody !== true && message.includeBody !== false) throw new Error('Invalid inspector body request');
      request.includeBody = message.includeBody;
    }
    return request;
  };

  const envelope = (request) => {
    const result = { tabId: request.tabId, requestId: request.requestId };
    if (request.captureId) result.captureId = request.captureId;
    return result;
  };
  const sendError = (viewer, request, code) => sendJson(viewer.socket, {
    type: 'inspectorError', ...envelope(request), code, message: MESSAGES[code],
  });
  const isAttached = (viewer, tabId) => viewer.socket.readyState === 1 && viewer.attached && viewer.tabId === tabId
    && viewer.surfaceSession && !viewer.surfaceSession.closed;
  const isCurrent = (state) => captures.get(state.viewer) === state && !state.closed
    && isAttached(state.viewer, state.tabId) && state.viewer.surfaceSession === state.surfaceSession
    && state.viewer.attachmentGeneration === state.attachmentGeneration;

  const releaseChannel = (state) => {
    const channel = state.channel;
    if (!channel) return;
    state.channel = null;
    channel.members.delete(state);
    if (channel.members.size) return;
    channel.unsubscribe?.();
    channel.unsubscribe = null;
    channel.transition = channel.transition.then(async () => {
      if (channel.members.size) return;
      if (channel.enabled) {
        try { await channel.cdp.sendSession(channel.sessionId, 'Runtime.disable'); } catch {}
        channel.enabled = false;
      }
      if (!channel.members.size && channels.get(channel.key) === channel) channels.delete(channel.key);
    });
  };

  const detach = (viewer) => {
    const state = captures.get(viewer);
    if (!state) return;
    captures.delete(viewer);
    state.closed = true;
    state.controller.abort();
    state.evaluation?.controller.abort();
    state.details?.controller.abort();
    state.buffer.dispose();
    releaseChannel(state);
  };

  const acquireChannel = (state, cdp) => {
    const sessionId = cdp.getSessionId(state.targetId);
    const key = `${state.surfaceSession.sessionId}\0${sessionId}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = { key, cdp, sessionId, members: new Set(), enabled: false, unsubscribe: null, transition: Promise.resolve(),
        mainFrameId: '', frameRevision: 0 };
      channels.set(key, channel);
    }
    channel.members.add(state);
    state.channel = channel;
    if (!channel.unsubscribe) channel.unsubscribe = cdp.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const mainNavigation = event.method === 'Page.frameNavigated' && event.params?.frame && !event.params.frame.parentId;
      if (mainNavigation) {
        channel.mainFrameId = boundedString(event.params.frame.id, 128);
        channel.frameRevision += 1;
      }
      const changedContext = mainNavigation || event.method === 'Runtime.executionContextsCleared'
        || (event.method === 'Page.navigatedWithinDocument' && event.params?.frameId === channel.mainFrameId);
      for (const member of channel.members) {
        if (!isCurrent(member)) continue;
        if (changedContext) {
          member.navigationRevision += 1;
          member.evaluation?.controller.abort();
          member.details?.controller.abort();
        }
        member.buffer.event(event.method, event.params);
      }
    });
    const ready = channel.transition.then(async () => {
      if (!channel.members.size || channel.enabled) return;
      const frameRevision = channel.frameRevision;
      const frameTree = await cdp.sendSession(sessionId, 'Page.getFrameTree');
      if (channel.frameRevision === frameRevision) channel.mainFrameId = boundedString(frameTree?.frameTree?.frame?.id, 128);
      if (!channel.mainFrameId) throw new Error('Inspector main frame unavailable');
      if (!channel.members.size) return;
      await cdp.sendSession(sessionId, 'Runtime.enable');
      channel.enabled = true;
    });
    channel.transition = ready.catch(() => {});
    return ready;
  };

  const start = async (viewer, request) => {
    detach(viewer);
    const state = { viewer, tabId: request.tabId, targetId: request.tabId.slice(3), captureId: randomUUID(),
      surfaceSession: viewer.surfaceSession, attachmentGeneration: viewer.attachmentGeneration,
      controller: new AbortController(), closed: false, channel: null, navigationRevision: 0,
      buffer: null, evaluation: null, details: null };
    state.buffer = createInspectorCapture({ tabId: state.tabId, captureId: state.captureId,
      send: (message) => isCurrent(state) && sendJson(viewer.socket, message),
      canSend: () => isCurrent(state) && viewer.socket.bufferedAmount < MAX_SOCKET_BYTES });
    captures.set(viewer, state);
    try {
      await browserSessionManager.runReadOnlyOperation(state.surfaceSession.sessionId, {
        targetId: state.targetId, requireTargetOwnership: true, abortSignal: state.controller.signal,
        operation: async ({ cdp }) => {
          if (!isCurrent(state)) return;
          await acquireChannel(state, cdp);
          if (!isCurrent(state)) return;
          sendJson(viewer.socket, { type: 'inspectorStarted', ...envelope(request), captureId: state.captureId });
          state.buffer.start();
        },
      });
    } catch {
      if (!isCurrent(state)) return;
      sendError(viewer, request, 'CAPTURE_FAILED');
      detach(viewer);
    }
  };

  const evaluate = async (state, request) => {
    if (state.evaluation) { sendError(state.viewer, request, 'INVALID_REQUEST'); return; }
    const job = createJob();
    state.evaluation = job;
    const navigationRevision = state.navigationRevision;
    let releaseObjects = () => {};
    let ownsControl = () => true;
    const valid = () => isCurrent(state) && state.evaluation === job && state.navigationRevision === navigationRevision
      && !job.controller.signal.aborted && ownsControl();
    const operation = runViewerOperation(state.viewer, state.targetId, async ({ cdp, isCurrent: controlIsCurrent }) => {
      ownsControl = controlIsCurrent;
      if (!valid()) return null;
      const sessionId = cdp.getSessionId(state.targetId);
      const objectGroup = `openchamber-inspector-${randomUUID()}`;
      releaseObjects = () => { void cdp.sendSession(sessionId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}); };
      const pending = cdp.sendSession(sessionId, 'Runtime.evaluate', {
        expression: request.expression, objectGroup, awaitPromise: true, returnByValue: false,
        generatePreview: true, timeout: 1_000, silent: true, replMode: true, includeCommandLineAPI: true,
      });
      try {
        let result = await pending;
        if (!valid()) return null;
        if (result?.result?.subtype === 'promise' && !result.exceptionDetails) {
          result = await cdp.sendSession(sessionId, 'Runtime.awaitPromise', {
            promiseObjectId: result.result.objectId, returnByValue: false, generatePreview: true,
          });
          if (!valid()) return null;
        }
        if (!result?.result && !result?.exceptionDetails) throw new Error('Invalid evaluation response');
        const exception = result.exceptionDetails;
        const formatted = formatRemoteObject(exception?.exception ?? (exception ? { type: 'string', value: exception.text } : result.result), 8_000);
        return { type: 'inspectorEvaluated', ...envelope(request), ...formatted, isError: Boolean(exception) };
      } finally {
        releaseObjects();
      }
    });
    const outcome = await waitForJob(operation, job);
    if (outcome.canceled) releaseObjects();
    if (state.evaluation !== job) return;
    state.evaluation = null;
    if (!isCurrent(state) || !ownsControl()) return;
    if (job.timedOut) { sendError(state.viewer, request, 'EVALUATION_TIMEOUT'); return; }
    if (outcome.error || outcome.canceled || state.navigationRevision !== navigationRevision) {
      const errorText = boundedString(outcome.error?.message, 512);
      sendError(state.viewer, request, /timed out|timeout|execution was terminated/i.test(errorText) ? 'EVALUATION_TIMEOUT' : 'EVALUATION_FAILED');
      return;
    }
    if (outcome.value) sendJson(state.viewer.socket, fitReply(outcome.value));
  };

  const requestDetails = async (state, request) => {
    if (state.details) { sendError(state.viewer, request, 'INVALID_REQUEST'); return; }
    const entry = state.buffer.request(request.entryId);
    if (!entry) { sendError(state.viewer, request, 'REQUEST_GONE'); return; }
    const job = createJob();
    state.details = job;
    const valid = () => isCurrent(state) && state.details === job && !job.controller.signal.aborted
      && state.buffer.request(request.entryId) !== null;
    const operation = browserSessionManager.runReadOnlyOperation(state.surfaceSession.sessionId, {
      targetId: state.targetId, requireTargetOwnership: true, abortSignal: job.controller.signal,
      operation: async ({ cdp }) => {
        const response = { type: 'inspectorRequestResult', ...envelope(request), entryId: request.entryId,
          requestHeaders: entry.requestHeaders.slice(), responseHeaders: entry.responseHeaders.slice(),
          requestBody: null, responseBody: null, bodyState: 'not-requested', truncated: entry.truncated };
        if (!valid() || !request.includeBody) return response;
        if (entry.redirected) { response.bodyState = 'unsupported'; return response; }
        const sessionId = cdp.getSessionId(state.targetId);
        let unavailable = false;
        let unsupported = false;
        const requestMime = entry.requestHeaders.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? '';
        if (entry.hasPostData && !normalizeBody('', false, requestMime).supported) unsupported = true;
        else if (entry.hasPostData) {
          try {
            const result = await cdp.sendSession(sessionId, 'Network.getRequestPostData', { requestId: entry.requestId });
            if (!valid()) return null;
            const body = normalizeBody(result.postData, false, requestMime);
            response.requestBody = body.text;
            response.truncated ||= body.truncated;
            unsupported ||= !body.supported;
          } catch { unavailable = true; }
        }
        if (!valid()) return null;
        const current = state.buffer.request(request.entryId);
        if (current.redirected) { response.requestBody = null; response.bodyState = 'unsupported'; return response; }
        if (current.row.state !== 'complete') unavailable = true;
        else if (!normalizeBody('', false, current.row.mimeType).supported) unsupported = true;
        else {
          try {
            const result = await cdp.sendSession(sessionId, 'Network.getResponseBody', { requestId: entry.requestId });
            if (!valid()) return null;
            if (state.buffer.request(request.entryId).redirected) {
              response.requestBody = null;
              response.bodyState = 'unsupported';
              return response;
            }
            const body = normalizeBody(result.body, result.base64Encoded, current.row.mimeType);
            response.responseBody = body.text;
            response.truncated ||= body.truncated;
            unsupported ||= !body.supported;
          } catch { unavailable = true; }
        }
        response.bodyState = unavailable ? 'unavailable' : unsupported ? 'unsupported' : 'available';
        return response;
      },
    });
    const outcome = await waitForJob(operation, job);
    if (state.details !== job) return;
    state.details = null;
    if (!isCurrent(state) || state.buffer.request(request.entryId) === null) return;
    if (outcome.error || outcome.canceled || !outcome.value) { sendError(state.viewer, request, 'REQUEST_FAILED'); return; }
    sendJson(state.viewer.socket, fitReply(outcome.value));
  };

  return {
    handle(viewer, message, type) {
      if (!COMMANDS.has(type)) return false;
      let request;
      try { request = parseRequest(message, type); } catch {
        try {
          const invalid = { tabId: identity(message.tabId), requestId: identity(message.requestId) };
          if (message.captureId !== undefined) invalid.captureId = identity(message.captureId);
          sendError(viewer, invalid, 'INVALID_REQUEST');
        } catch {}
        return true;
      }
      if (!browserSessionManager || !isAttached(viewer, request.tabId)) {
        sendError(viewer, request, 'UNAVAILABLE');
        return true;
      }
      if (type === 'inspectorStart') { void start(viewer, request); return true; }
      const state = captures.get(viewer);
      if (!state || !isCurrent(state) || (request.captureId && request.captureId !== state.captureId)) {
        if (type !== 'inspectorStop' || request.captureId) sendError(viewer, request, 'CAPTURE_GONE');
        return true;
      }
      if (type === 'inspectorStop') detach(viewer);
      else if (type === 'inspectorClear') {
        if (request.scope === 'network') { state.details?.controller.abort(); state.details = null; }
        state.buffer.clear(request.scope);
        sendJson(viewer.socket, { type: 'inspectorCleared', ...envelope(request), scope: request.scope });
      } else if (type === 'inspectorEvaluate') void evaluate(state, request);
      else if (type === 'inspectorRequest') void requestDetails(state, request);
      return true;
    },
    detach,
    dispose() { for (const viewer of captures.keys()) detach(viewer); },
  };
}
