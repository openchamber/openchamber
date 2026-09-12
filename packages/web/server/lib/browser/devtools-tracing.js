const TRACE_CLEANUP_TIMEOUT_MS = 15_000;

export const releaseDevToolsTracing = (state) => {
  clearTimeout(state.traceCleanupTimer);
  state.traceCleanupTimer = null;
  state.traceStartId = null;
  state.traceRelease?.();
  state.traceRelease = null;
};

export const trackDevToolsTraceResponse = (state, message) => {
  if (message.id !== state.traceStartId) return;
  state.traceStartId = null;
  if (Object.hasOwn(message, 'error')) releaseDevToolsTracing(state);
};

export const handleClosingTraceMessage = (state, data) => {
  let message;
  try {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    message = JSON.parse(raw);
  } catch { return; }
  if (message?.method !== 'Tracing.tracingComplete') return;
  releaseDevToolsTracing(state);
  try { state.socket.close(); } catch {}
};

export const closeDevToolsSocket = (state) => {
  const socket = state.socket;
  if (!socket || socket.readyState !== 1) {
    return;
  }
  let id = Number.MAX_SAFE_INTEGER;
  for (const sessionId of [null, ...state.policy.childSessionIds()]) {
    const suffix = sessionId ? { sessionId } : {};
    try { socket.send(JSON.stringify({ id: id--, method: 'Debugger.resume', ...suffix })); } catch {}
  }
  if (!state.traceRelease) {
    try { socket.close(); } catch {}
    return;
  }
  try { socket.send(JSON.stringify({ id, method: 'Tracing.end' })); } catch {
    try { socket.terminate(); } catch {}
    return;
  }
  state.traceCleanupTimer = setTimeout(() => {
    state.traceCleanupTimer = null;
    try { socket.terminate(); } catch {}
  }, TRACE_CLEANUP_TIMEOUT_MS);
  state.traceCleanupTimer.unref?.();
};
