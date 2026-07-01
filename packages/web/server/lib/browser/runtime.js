import { WebSocketServer } from 'ws';
import {
  BROWSER_ERROR_CODES,
  OP_SPECS,
  classifyOrigin,
  isExternalNavigationBlocked,
  opFromToolName,
  resolveCapability,
  routeToolCall,
} from './command-router.js';
import { buildOpScript } from './op-scripts.js';
import { isStaleRef } from './snapshot.js';
import {
  BROWSER_WS_MAX_PAYLOAD_BYTES,
  decodeBrowserWsMessage,
  encodeBrowserWsMessage,
  isBrowserWsPathname,
  parseRequestPathname,
} from './browser-ws-protocol.js';
import { registerBrowserMcpEndpoint } from './mcp-endpoint.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const WAIT_POLL_INTERVAL_MS = 250;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Browser-control runtime. Mirrors the terminal runtime shape:
 *   createBrowserControlRuntime({ app, server, express, ... }) -> { dispatch, shutdown }
 *
 * The server is platform-agnostic: it relays every op to whichever renderer
 * executor (web iframe or desktop webview) registered itself as a controller over
 * the control WS, and correlates the reply. Policy (capability + consent) is
 * enforced via command-router BEFORE any relay.
 */
export function createBrowserControlRuntime({
  app,
  server,
  express,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  getBrowserPolicy,
  getBrowserMcpToken,
  requestOpenBrowser,
  onBrowserAudit,
  heartbeatIntervalMs = 15_000,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  /** controllerId -> controller state */
  const controllers = new Map();
  let lastControllerId = null;
  let cidSeq = 0;

  // Every model-driven op is audited (server log + optional sink) so a
  // prompt-injected page can't drive actions unseen.
  const audit = (tool, controllerId, origin, decision, detail) => {
    const line = `[BrowserControl] ${decision} tool=${tool} controller=${controllerId} origin=${origin}${detail ? ` (${detail})` : ''}`;
    if (decision === 'DENY' || decision === 'FAIL') console.warn(line);
    else console.log(line);
    if (typeof onBrowserAudit === 'function') {
      try { onBrowserAudit({ tool, controllerId, origin, decision, detail: detail || undefined, at: Date.now() }); } catch { /* ignore */ }
    }
  };

  const resolvePolicy = () => {
    try {
      const p = typeof getBrowserPolicy === 'function' ? getBrowserPolicy() : null;
      return p || { enabled: false };
    } catch {
      return { enabled: false };
    }
  };

  const capabilitiesFor = (backend, originClass) => {
    const caps = {};
    for (const op of Object.keys(OP_SPECS)) {
      caps[op] = resolveCapability({ op, backend, originClass }).supported;
    }
    return caps;
  };

  const controllerInfo = (controller) => ({
    controllerId: controller.controllerId,
    backend: controller.backend,
    originClass: controller.originClass,
    url: controller.url,
    title: controller.title,
    capabilities: capabilitiesFor(controller.backend, controller.originClass),
  });

  const sendToController = (controller, payload) => {
    const socket = controller?.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(encodeBrowserWsMessage(payload));
      return true;
    } catch {
      return false;
    }
  };

  const failPending = (controller, code, message) => {
    for (const [, pending] of controller.pending) {
      clearTimeout(pending.timer);
      pending.reject({ code, message });
    }
    controller.pending.clear();
  };

  /** Reverse-RPC: send one primitive to the controller's executor, await result. */
  const sendPrimitive = (controller, primitive, args, timeoutMs = commandTimeoutMs) => {
    if (!controller || !controller.socket || controller.socket.readyState !== 1) {
      return Promise.reject({ code: BROWSER_ERROR_CODES.CONTROLLER_GONE, message: 'Browser pane is not connected.' });
    }
    cidSeq += 1;
    const cid = `c${cidSeq}`;
    const deadline = Math.min(Math.max(1000, timeoutMs), MAX_COMMAND_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.pending.delete(cid);
        sendToController(controller, { t: 'cancel', cid });
        reject({ code: BROWSER_ERROR_CODES.BROWSER_TIMEOUT, message: `Browser command '${primitive}' timed out after ${deadline}ms.` });
      }, deadline);
      controller.pending.set(cid, { resolve, reject, timer });
      const sent = sendToController(controller, { t: 'cmd', cid, primitive, args: args || {} });
      if (!sent) {
        clearTimeout(timer);
        controller.pending.delete(cid);
        reject({ code: BROWSER_ERROR_CODES.CONTROLLER_GONE, message: 'Browser pane is not connected.' });
      }
    });
  };

  /** Run a page-eval op and translate __ocError markers into typed failures. */
  const runEvalOp = async (controller, op, args) => {
    // The diagnostics capture is installed once per document (epoch). Re-shipping
    // the full install preamble on every op is wasted bytes + re-parse; ship it
    // only on the first eval of an epoch. bumpEpoch (navigate/reload) invalidates
    // this so capture re-arms on the first op after each load. `snapshot` uses a
    // separate script that never carries the install, so it must not mark the
    // epoch installed (else a later drain would skip the install and see nothing).
    const carriesDiag = op !== 'snapshot';
    const installDiag = carriesDiag && controller.diagInstalledEpoch !== controller.snapshotEpoch;
    const js = buildOpScript(op, args, { epoch: controller.snapshotEpoch, installDiag });
    if (js === null) {
      return { ok: false, code: BROWSER_ERROR_CODES.EXEC_ERROR, message: `No page script for op '${op}'` };
    }
    if (installDiag) controller.diagInstalledEpoch = controller.snapshotEpoch;
    const res = await sendPrimitive(controller, 'eval', { js });
    const value = res && typeof res === 'object' && 'value' in res ? res.value : res;
    if (value && typeof value === 'object' && typeof value.__ocError === 'string') {
      return { ok: false, code: value.__ocError, message: value.message || value.__ocError };
    }
    return { ok: true, value };
  };

  const bumpEpoch = (controller) => {
    controller.snapshotEpoch = String(Number(controller.snapshotEpoch || '1') + 1);
  };

  const waitForOp = async (controller, args, policy) => {
    const kind = args?.kind;
    const rawTimeout = Number(args?.timeoutMs);
    const timeoutMs = Math.min(Math.max(250, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000), MAX_COMMAND_TIMEOUT_MS);

    if (kind === 'timeout') {
      // `value` is the ms to wait; 0 is a valid "return immediately" (don't let
      // the falsy-zero fall through to the 30s default).
      const rawValue = Number(args?.value);
      const waitMs = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : timeoutMs;
      await delay(Math.min(waitMs, MAX_COMMAND_TIMEOUT_MS));
      return { ok: true, value: { waited: true } };
    }

    if (kind === 'function' && policy.advancedEnabled !== true) {
      return { ok: false, code: BROWSER_ERROR_CODES.CONSENT_DENIED, message: "wait_for kind 'function' evaluates JS and requires advanced browser tools." };
    }

    if (kind === 'navigation') {
      const startEpoch = controller.snapshotEpoch;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (controller.snapshotEpoch !== startEpoch) return { ok: true, value: { navigated: true, url: controller.url } };
        await delay(WAIT_POLL_INTERVAL_MS);
      }
      return { ok: false, code: BROWSER_ERROR_CODES.BROWSER_TIMEOUT, message: 'Timed out waiting for navigation.' };
    }

    const checkJs =
      kind === 'load'
        ? "(function(){ return document.readyState === 'complete'; })()"
        : kind === 'selector'
          ? `(function(){ try { return !!document.querySelector(${JSON.stringify(String(args.value))}); } catch (e) { return false; } })()`
          : kind === 'function'
            ? `(function(){ try { return !!(${String(args.value)}); } catch (e) { return false; } })()`
            : null;

    if (checkJs === null) {
      return { ok: false, code: BROWSER_ERROR_CODES.BAD_ARGS, message: `Unsupported wait kind '${kind}'` };
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const res = await sendPrimitive(controller, 'eval', { js: checkJs }, WAIT_POLL_INTERVAL_MS + 2000);
        const value = res && typeof res === 'object' && 'value' in res ? res.value : res;
        if (value === true) return { ok: true, value: { satisfied: kind } };
      } catch (err) {
        // A single slow poll (page main-thread briefly blocked) hits the per-poll
        // deadline — that's not a wait failure, keep polling against the overall
        // timeoutMs budget. Only a gone pane ends the wait early.
        if (err && err.code === BROWSER_ERROR_CODES.CONTROLLER_GONE) {
          return { ok: false, code: err.code, message: err.message };
        }
      }
      await delay(WAIT_POLL_INTERVAL_MS);
    }
    return { ok: false, code: BROWSER_ERROR_CODES.BROWSER_TIMEOUT, message: `Timed out waiting for ${kind}.` };
  };

  const pickController = (controllerId) => {
    if (controllerId && controllers.has(controllerId)) return controllers.get(controllerId);
    if (controllerId) return null;
    if (lastControllerId && controllers.has(lastControllerId)) return controllers.get(lastControllerId);
    const first = controllers.values().next();
    return first.done ? null : first.value;
  };

  const handleLifecycle = async (op, args, policy) => {
    if (op === 'status' || op === 'list_panes') {
      const wanted = args?.controllerId;
      const list = [...controllers.values()]
        .filter((c) => !wanted || c.controllerId === wanted)
        .map((c) => ({ ...controllerInfo(c), attached: true, lastOp: c.lastOp, lastActivityAt: c.lastActivityAt }));
      return { ok: true, value: { controllers: list, count: list.length } };
    }
    if (op === 'open') {
      // `open` bypasses evaluateConsent (it's a lifecycle op), so enforce the
      // localhost-only navigation gate here too.
      if (args?.url && isExternalNavigationBlocked(args.url, policy)) {
        return { ok: false, code: BROWSER_ERROR_CODES.CONSENT_DENIED, message: 'Navigating to a non-localhost site is blocked. Enable "Allow agents on any website" in Settings.' };
      }
      const controller = pickController(args?.controllerId);
      if (!controller) {
        if (typeof requestOpenBrowser === 'function') {
          try { requestOpenBrowser({ url: args?.url }); } catch { /* best effort */ }
        }
        // Give the UI a moment to open + register a pane.
        for (let i = 0; i < 32; i += 1) {
          await delay(250);
          const c = pickController(args?.controllerId);
          if (c) {
            if (args?.url) await executeOp(c, 'navigate', { url: args.url }, policy);
            return { ok: true, value: controllerInfo(c) };
          }
        }
        return { ok: false, code: BROWSER_ERROR_CODES.NO_BROWSER_PANE, message: 'Open the Browser tab in the context panel, then retry.' };
      }
      if (args?.url) {
        const nav = await executeOp(controller, 'navigate', { url: args.url }, policy);
        if (!nav.ok) return nav;
      }
      return { ok: true, value: controllerInfo(controller) };
    }
    if (op === 'close') {
      const controller = pickController(args?.controllerId);
      if (controller) sendToController(controller, { t: 'detach' });
      return { ok: true, value: { closed: true } };
    }
    return { ok: false, code: BROWSER_ERROR_CODES.UNKNOWN_OP, message: `Unknown lifecycle op '${op}'` };
  };

  /** Execute a single (already policy-cleared) op against a controller. */
  const executeOp = async (controller, op, args, policy) => {
    controller.lastOp = op;
    controller.lastActivityAt = Date.now();

    // Stale-ref guard before any round-trip.
    if (typeof args?.ref === 'string' && isStaleRef(args.ref, controller.snapshotEpoch)) {
      return { ok: false, code: BROWSER_ERROR_CODES.STALE_REF, message: 'This ref is from an older snapshot. Take a fresh browser_snapshot.' };
    }

    try {
      if (op === 'navigate') {
        const res = await sendPrimitive(controller, 'navigate', { url: args.url });
        bumpEpoch(controller);
        controller.suppressNextNavigatedBump = true;
        controller.url = args.url;
        controller.originClass = classifyOrigin(args.url);
        return { ok: true, value: res && res.value !== undefined ? res.value : { navigated: true } };
      }
      if (op === 'back' || op === 'forward' || op === 'reload') {
        const res = await sendPrimitive(controller, op, {});
        bumpEpoch(controller);
        controller.suppressNextNavigatedBump = true;
        return { ok: true, value: res && res.value !== undefined ? res.value : { [op]: true } };
      }
      if (op === 'screenshot') {
        let rect;
        if (args?.mode === 'element' && (args.ref || args.selector)) {
          const located = await runEvalOp(controller, 'highlight', { ref: args.ref, selector: args.selector });
          if (located.ok && located.value && located.value.rect) rect = located.value.rect;
        }
        const res = await sendPrimitive(controller, 'screenshot', { mode: args?.mode || 'viewport', rect }, MAX_COMMAND_TIMEOUT_MS);
        return { ok: true, value: res && res.value !== undefined ? res.value : res };
      }
      if (op === 'set_viewport') {
        const res = await sendPrimitive(controller, 'setViewport', { width: args.width, height: args.height, dpr: args.dpr });
        return { ok: true, value: res && res.value !== undefined ? res.value : { ok: true } };
      }
      if (op === 'emulate_device') {
        const res = await sendPrimitive(controller, 'emulateDevice', { device: args.device });
        return { ok: true, value: res && res.value !== undefined ? res.value : { ok: true } };
      }
      if (op === 'wait_for') return await waitForOp(controller, args, policy);
      if (op === 'file_upload') {
        const res = await sendPrimitive(controller, 'setInputFiles', { ref: args.ref, selector: args.selector, paths: args.paths });
        return { ok: true, value: res && res.value !== undefined ? res.value : res };
      }

      // Default: page-eval op (includes console_messages/network_requests/page_errors,
      // which drain the in-page diagnostics buffer installed by the op preamble).
      return await runEvalOp(controller, op, args);
    } catch (err) {
      if (err && typeof err === 'object' && err.code) return { ok: false, code: err.code, message: err.message };
      return { ok: false, code: BROWSER_ERROR_CODES.EXEC_ERROR, message: String(err && err.message ? err.message : err) };
    }
  };

  /**
   * Public entry used by the MCP endpoint. Gates policy/capability, resolves the
   * controller, then executes. Always returns a result envelope (never throws).
   */
  const dispatch = async (toolName, args = {}, options = {}) => {
    const policy = resolvePolicy();
    const op = opFromToolName(toolName);
    // Honor an explicit controllerId from the tool args (the MCP endpoint forwards
    // args verbatim) so a model with multiple panes can target a specific one via
    // browser_status → controllerId, instead of always hitting the last-registered pane.
    const controller = op && OP_SPECS[op]?.lifecycle
      ? null
      : pickController(options.controllerId ?? args?.controllerId);

    const origin = controller ? controller.originClass : '-';
    const cid = controller ? controller.controllerId : '-';

    const routed = routeToolCall({ toolName, args, controller, policy });
    if (!routed.ok) {
      audit(toolName, cid, origin, 'DENY', routed.code);
      return { ok: false, code: routed.code, message: routed.message };
    }

    if (routed.lifecycle) {
      const result = await handleLifecycle(routed.op, args, policy);
      audit(toolName, cid, origin, result.ok ? 'ALLOW' : 'FAIL', result.ok ? '' : result.code);
      return result;
    }

    if (!controller) {
      audit(toolName, '-', '-', 'DENY', BROWSER_ERROR_CODES.NO_BROWSER_PANE);
      return { ok: false, code: BROWSER_ERROR_CODES.NO_BROWSER_PANE, message: 'No browser pane is connected. Use browser_open or open the Browser tab.' };
    }

    const result = await executeOp(controller, routed.op, routed.args, policy);
    audit(toolName, cid, origin, result.ok ? 'ALLOW' : 'FAIL', result.ok ? '' : result.code);
    return result;
  };

  // ---- WebSocket broker (renderer executors connect here) ----
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: BROWSER_WS_MAX_PAYLOAD_BYTES });

  wsServer.on('connection', (socket) => {
    let boundControllerId = null;

    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        try { socket.ping(); } catch { /* ignore */ }
      }
    }, heartbeatIntervalMs);

    socket.on('message', (raw) => {
      const msg = decodeBrowserWsMessage(raw);
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'hello' && typeof msg.controllerId === 'string') {
        boundControllerId = msg.controllerId;
        const existing = controllers.get(msg.controllerId);
        const controller = existing || {
          controllerId: msg.controllerId,
          pending: new Map(),
          snapshotEpoch: '1',
        };
        controller.socket = socket;
        controller.backend = msg.backend === 'desktop-cdp' ? 'desktop-cdp' : 'web-iframe';
        controller.url = typeof msg.url === 'string' ? msg.url : controller.url;
        controller.title = typeof msg.title === 'string' ? msg.title : controller.title;
        controller.originClass = classifyOrigin(controller.url);
        controller.lastActivityAt = Date.now();
        controllers.set(msg.controllerId, controller);
        lastControllerId = msg.controllerId;
        sendToController(controller, { t: 'hello-ok', ...controllerInfo(controller) });
        return;
      }

      const controller = boundControllerId ? controllers.get(boundControllerId) : null;
      if (!controller) return;
      controller.lastActivityAt = Date.now();

      if (msg.t === 'res' && typeof msg.cid === 'string') {
        const pending = controller.pending.get(msg.cid);
        if (!pending) return;
        controller.pending.delete(msg.cid);
        clearTimeout(pending.timer);
        if (msg.ok === false) pending.reject({ code: msg.code || BROWSER_ERROR_CODES.EXEC_ERROR, message: msg.message || 'Executor error' });
        else pending.resolve({ value: msg.value });
        return;
      }

      if (msg.t === 'event' && msg.kind === 'navigated') {
        if (typeof msg.payload?.url === 'string') {
          controller.url = msg.payload.url;
          controller.originClass = classifyOrigin(controller.url);
        }
        if (typeof msg.payload?.title === 'string') controller.title = msg.payload.title;
        // A programmatic navigate/back/forward/reload already bumped the epoch;
        // skip the echo so a snapshot taken right after isn't spuriously staled.
        if (controller.suppressNextNavigatedBump) controller.suppressNextNavigatedBump = false;
        else bumpEpoch(controller);
        return;
      }

      if (msg.t === 'bye') {
        // Socket-scoped: a stale pane (e.g. the panel pane during a pop-out
        // hand-off) must not delete the controller after another window (the
        // pop-out) has re-registered the same id on a different socket.
        if (controller.socket === socket) {
          // Fail in-flight commands immediately instead of letting them hang
          // until their per-command deadline (teardown does this on socket close;
          // an explicit detach must too).
          failPending(controller, BROWSER_ERROR_CODES.CONTROLLER_GONE, 'Browser pane detached.');
          controllers.delete(controller.controllerId);
          if (lastControllerId === controller.controllerId) lastControllerId = null;
        }
      }
    });

    const teardown = () => {
      clearInterval(heartbeat);
      if (!boundControllerId) return;
      const controller = controllers.get(boundControllerId);
      if (controller && controller.socket === socket) {
        failPending(controller, BROWSER_ERROR_CODES.CONTROLLER_GONE, 'Browser pane disconnected.');
        controllers.delete(boundControllerId);
        if (lastControllerId === boundControllerId) lastControllerId = null;
      }
    };

    socket.on('close', teardown);
    socket.on('error', () => { /* ignore; close handles teardown */ });
  });

  const upgradeHandler = (req, sock, head) => {
    const pathname = parseRequestPathname(req.url);
    if (!isBrowserWsPathname(pathname)) return;

    const run = async () => {
      try {
        if (uiAuthController?.enabled) {
          const token = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!token) {
            rejectWebSocketUpgrade(sock, 401, 'UI authentication required');
            return;
          }
          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(sock, 403, 'Invalid origin');
            return;
          }
        }
        if (!wsServer) {
          rejectWebSocketUpgrade(sock, 500, 'Browser control unavailable');
          return;
        }
        wsServer.handleUpgrade(req, sock, head, (ws) => wsServer.emit('connection', ws, req));
      } catch {
        rejectWebSocketUpgrade(sock, 500, 'Upgrade failed');
      }
    };
    void run();
  };

  server.on('upgrade', upgradeHandler);

  // ---- MCP endpoint (model entry point) ----
  registerBrowserMcpEndpoint({ app, express, dispatch, getBrowserMcpToken });

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler);
    for (const controller of controllers.values()) {
      failPending(controller, BROWSER_ERROR_CODES.CONTROLLER_GONE, 'Server shutting down.');
    }
    controllers.clear();
    if (!wsServer) return;
    try {
      for (const client of wsServer.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wsServer.close(() => resolve()));
    } catch {
      /* ignore */
    } finally {
      wsServer = null;
    }
  };

  return { dispatch, shutdown, getControllerCount: () => controllers.size };
}
