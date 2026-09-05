import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { buildTerminalShellLaunch, createTerminalShellResolver, normalizeTerminalShell } from './shells.js';
import { stripAppImageArgv0Leak, resolveLinuxPtyLaunch } from '../inherited-env.js';

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const INTERACTIVE_TERMINAL_MODE = 'interactive';
const COMMAND_TERMINAL_MODE = 'command';
// Error code the create/restart routes attach when the requested cwd no longer
// exists. Mirrored by `TERMINAL_CWD_MISSING_CODE` in packages/ui/src/lib/terminalApi.ts.
const TERMINAL_CWD_MISSING_CODE = 'TERMINAL_CWD_MISSING';
const TERMINAL_PURPOSE = Object.freeze({ type: 'terminal' });
const MAX_PURPOSE_ID_CHARS = 128;
const OBJECT_TAG = '[object Object]';
const validateSize = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const isString = (value) => String(value) === value;
const isObjectRecord = (value) => value != null && !Array.isArray(value) && Object.prototype.toString.call(value) === OBJECT_TAG;
const normalizeCreateMode = ({ mode, command }) => {
  const normalizedMode = mode == null ? INTERACTIVE_TERMINAL_MODE : mode;
  if (normalizedMode !== INTERACTIVE_TERMINAL_MODE && normalizedMode !== COMMAND_TERMINAL_MODE) throw new Error('Invalid terminal mode');
  if (normalizedMode === INTERACTIVE_TERMINAL_MODE) {
    if (command != null) throw new Error('Interactive terminal create does not accept a command');
    return { mode: INTERACTIVE_TERMINAL_MODE, command: null };
  }
  if (!isString(command) || !command.trim()) throw new Error('Terminal command is required');
  const trimmedCommand = command.trim();
  if (trimmedCommand.length > MAX_INPUT_CHARS) throw new Error('Terminal command exceeds the input limit');
  return { mode: COMMAND_TERMINAL_MODE, command: trimmedCommand };
};
const normalizePurposeId = (value, errorMessage) => {
  if (!isString(value) || !value.trim()) throw new Error(errorMessage);
  const normalized = value.trim();
  if (normalized.length > MAX_PURPOSE_ID_CHARS) throw new Error(errorMessage);
  return normalized;
};
const normalizeTerminalPurpose = (value) => {
  if (value == null) return TERMINAL_PURPOSE;
  if (!isObjectRecord(value)) throw new Error('Invalid terminal purpose');
  if (value.type === 'terminal') return TERMINAL_PURPOSE;
  if (value.type !== 'project-action') throw new Error('Invalid terminal purpose');
  return {
    type: 'project-action',
    actionId: normalizePurposeId(value.actionId, 'Terminal project action id is required'),
    executionId: normalizePurposeId(value.executionId, 'Terminal execution id is required'),
  };
};
const getSessionPurpose = (session) => session.purpose ?? TERMINAL_PURPOSE;
const isPurposeActionMatch = (left, right) => {
  if (left.type !== right.type) return false;
  return left.type !== 'project-action' || left.actionId === right.actionId;
};
const findRunningActionSession = (sessions, resolvedCwd, purpose, path) => {
  if (purpose.type !== 'project-action') return null;
  for (const session of sessions.values()) {
    if (session.status !== 'running') continue;
    if (path.resolve(session.cwd) !== resolvedCwd) continue;
    const sessionPurpose = getSessionPurpose(session);
    if (sessionPurpose.type === 'project-action' && sessionPurpose.actionId === purpose.actionId) return session;
  }
  return null;
};
const findPendingActionCreate = (pendingSessionCreates, resolvedCwd, purpose) => {
  if (purpose.type !== 'project-action') return null;
  for (const pending of pendingSessionCreates.values()) {
    if (pending.cancelled || pending.cwd !== resolvedCwd) continue;
    if (pending.purpose?.type === 'project-action' && pending.purpose.actionId === purpose.actionId) return pending;
  }
  return null;
};
const trimHistory = (history) => {
  const bytes = Buffer.from(history);
  if (bytes.byteLength <= MAX_HISTORY_BYTES) return history;
  let start = bytes.byteLength - MAX_HISTORY_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
};

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, terminalTerminationGraceMs = TERMINATION_GRACE_MS,
}) {
  const sessions = new Map();
  const pendingSessionCreates = new Map();
  const pendingSessionRestarts = new Map();
  const connections = new Set();
  const pendingTerminations = new Set();
  const runtime = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
  let ptyProviderPromise = null;
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });

  const getPtyProvider = async () => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = loadPtyProvider ? loadPtyProvider() : (async () => {
        if (typeof globalThis.Bun !== 'undefined') {
          try { const pty = await import('bun-pty'); return { spawn: pty.spawn, backend: 'bun-pty' }; } catch { /* fall through */ }
        }
        const pty = await import('node-pty');
        return { spawn: pty.spawn, backend: 'node-pty' };
      })();
    }
    return ptyProviderPromise;
  };

  const spawnPty = async ({ cwd, cols, rows, themeMode, shell, loginShell, mode, command }) => {
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell);
    let lastError = null;
    for (const executable of resolvedShell.executables) {
      try {
        const env = { ...process.env, PATH: buildAugmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        // The daemon's IPC fd is closed inside the PTY. An explicit override is
        // required because bun-pty also inherits Bun's native process environment.
        env.NODE_CHANNEL_FD = '';
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        // AppImage exports ARGV0; zsh would otherwise rewrite argv[0] for every command (#2588).
        // bun-pty also merges the native OS environ, so wrap with `env -u ARGV0` on Linux.
        stripAppImageArgv0Leak(env);
        const shellLaunch = buildTerminalShellLaunch(executable, { mode, command, loginShell });
        const launch = resolveLinuxPtyLaunch(shellLaunch.executable, shellLaunch.args);
        const options = { name: 'xterm-256color', cwd, cols, rows, env };
        if (process.platform === 'win32') options.useConpty = true;
        return { process: await provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, loginShell };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return;
    if (process.platform !== 'win32' && Number.isInteger(ptyProcess.pid) && ptyProcess.pid > 0) {
      try { process.kill(-ptyProcess.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { /* already gone */ }
  };

  const terminateProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return Promise.resolve();
    if (force) { killProcess(ptyProcess, true); return Promise.resolve(); }
    let termination;
    termination = new Promise((resolve) => {
      let settled = false;
      let disposable = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        resolve();
      };
      const timeout = setTimeout(() => { killProcess(ptyProcess, true); finish(); }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); } catch { /* backend is already gone */ }
      killProcess(ptyProcess, false);
    }).finally(() => pendingTerminations.delete(termination));
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket, message) => {
    if (socket?.readyState !== 1) return false;
    try { socket.send(createTerminalWsControlFrame(message), { binary: true }); return true; } catch { return false; }
  };

  const closeAttachments = (sessionId, code, message) => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session) => ({
    t: 'snapshot', v: 3, s: session.id, q: session.sequence, history: session.history,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    mode: session.mode ?? INTERACTIVE_TERMINAL_MODE, purpose: getSessionPurpose(session),
    runtime, ptyBackend: session.backend,
  });

  const publish = (session, event) => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const drainEvents = (session) => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          }, { respondToPrimaryDeviceAttributes: true });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) session.process?.write(response);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          session.history = trimHistory(session.history + sanitized.visible);
          session.lastActivity = Date.now();
          publish(session, { t: 'output', d: event.data, ...(sanitized.visible !== event.data ? { r: sanitized.visible } : {}) });
        } else {
          session.status = 'exited';
          session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = Number.isInteger(event.signal) ? event.signal : null;
          session.process = null;
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session, ptyProcess) => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, exitCode, signal }); drainEvents(session); });
  };

  // A working directory that no longer exists (a deleted worktree) is the one
  // rejection the client can recover from by moving the session to its
  // project, so the response names it. Every other rejection stays generic.
  const invalidWorkingDirectory = (code) => Object.assign(new Error('Invalid working directory'), code ? { code } : {});
  const validateCwd = async (cwd) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    let stats;
    try { stats = await fs.promises.stat(cwd); }
    catch (error) { throw invalidWorkingDirectory(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? TERMINAL_CWD_MISSING_CODE : undefined); }
    if (!stats?.isDirectory()) throw invalidWorkingDirectory();
  };
  const errorBody = (error, fallback) => ({ error: error?.message || fallback, ...(typeof error?.code === 'string' ? { code: error.code } : {}) });

  const applyAppearance = (session, { themeMode, terminalBackground, terminalForeground }) => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (typeof terminalBackground === 'string') session.terminalBackground = terminalBackground;
    if (typeof terminalForeground === 'string') session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      try { session.process?.write(terminalThemeModeReport(session.themeMode)); } catch { /* process exited */ }
    }
  };

  const startSession = async (session, { cwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell, mode = INTERACTIVE_TERMINAL_MODE, command = null, purpose = TERMINAL_PURPOSE }, clear = true) => {
    await validateCwd(cwd);
    const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell, mode, command });
    if (clear) { session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; }
    session.cwd = cwd; session.cols = cols; session.rows = rows; session.process = spawned.process;
    session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.status = 'running'; session.exitCode = null; session.signal = null;
    session.mode = mode; session.command = mode === COMMAND_TERMINAL_MODE ? command : null;
    session.purpose = purpose;
    session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
    session.lastActivity = Date.now(); session.eventQueue.length = 0;
    wire(session, spawned.process);
    return spawned.process;
  };

  const createSession = async ({ sessionId, cwd, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false, mode, command, purpose }) => {
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
    const normalizedShell = normalizeTerminalShell(shell);
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    const launchMode = normalizeCreateMode({ mode, command });
    const normalizedPurpose = normalizeTerminalPurpose(purpose);
    const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    const existing = sessions.get(id);
    const resolvedCwd = path.resolve(cwd);
    if (existing?.status === 'running') {
      if (path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (!isPurposeActionMatch(getSessionPurpose(existing), normalizedPurpose)) throw new Error('Terminal session is already running with a different purpose');
      if (normalizedPurpose.type === 'project-action') { applyAppearance(existing, { themeMode, terminalBackground, terminalForeground }); return existing; }
      if ((existing.mode ?? INTERACTIVE_TERMINAL_MODE) !== launchMode.mode) throw new Error('Terminal session is already running with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && existing.command !== launchMode.command) throw new Error('Terminal session is already running with a different command');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const runningActionSession = findRunningActionSession(sessions, resolvedCwd, normalizedPurpose, path);
    if (runningActionSession) {
      applyAppearance(runningActionSession, { themeMode, terminalBackground, terminalForeground });
      return runningActionSession;
    }
    const pending = pendingSessionCreates.get(id);
    if (pending) {
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (!isPurposeActionMatch(pending.purpose, normalizedPurpose)) throw new Error('Terminal session is already being created with a different purpose');
      if (normalizedPurpose.type === 'project-action') return pending.promise;
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      if (pending.mode !== launchMode.mode) throw new Error('Terminal session is already being created with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && pending.command !== launchMode.command) throw new Error('Terminal session is already being created with a different command');
      const session = await pending.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const pendingActionCreate = findPendingActionCreate(pendingSessionCreates, resolvedCwd, normalizedPurpose);
    if (pendingActionCreate) {
      const session = await pendingActionCreate.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const superseded = normalizedPurpose.type === 'project-action'
      ? [...sessions.values()].filter((session) => session.id !== id && session.status === 'exited'
        && path.resolve(session.cwd) === resolvedCwd && isPurposeActionMatch(getSessionPurpose(session), normalizedPurpose))
      : [];
    if (!existing && sessions.size - superseded.length + pendingSessionCreates.size >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    const pendingEntry = { cwd: resolvedCwd, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose, cancelled: false, promise: null };
    const creation = (async () => {
      const session = existing ?? { id, sequence: 0, history: '', pendingHistoryControlSequence: '', pendingThemeControlSequence: '', eventQueue: [], draining: false, createdAt: Date.now() };
      const ptyProcess = await startSession(session, { cwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose });
      if (pendingEntry.cancelled) {
        session.process = null;
        await terminateProcess(ptyProcess, true);
        throw new Error('Terminal session was closed during creation');
      }
      for (const previous of superseded) {
        if (sessions.get(previous.id) !== previous || previous.status !== 'exited') continue;
        sessions.delete(previous.id);
        closeAttachments(previous.id, 'SUPERSEDED', 'Terminal replaced by a new action run');
      }
      sessions.set(id, session);
      return session;
    })();
    pendingEntry.promise = creation;
    pendingSessionCreates.set(id, pendingEntry);
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  wsServer.on('connection', (socket) => {
    const connection = { socket, attachments: new Map() };
    connections.add(connection);
    send(socket, { t: 'hello', v: 3 });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!message || message.v !== 3 || typeof message.t !== 'string') { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: 3 }); return; }
      if (message.t === 'hello') return;
      const id = typeof message.s === 'string' ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      const session = sessions.get(id);
      if (!session) { send(socket, { t: 'error', v: 3, s: id, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      if (message.t === 'attach') {
        const attachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        const initial = snapshot(session);
        send(socket, initial);
        for (const event of attachment.pending) if (event.q > initial.q) send(socket, event);
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (typeof message.d !== 'string' || !message.d || message.d.length > MAX_INPUT_CHARS) { send(socket, { t: 'error', v: 3, s: id, code: 'BAD_INPUT', message: 'Invalid terminal input', fatal: false }); return; }
        if (session.status !== 'running' || !session.process) { send(socket, { t: 'error', v: 3, s: id, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return; }
        try { session.process.write(message.d); session.lastActivity = Date.now(); } catch { send(socket, { t: 'error', v: 3, s: id, code: 'WRITE_FAILED', message: 'Failed to write to terminal', fatal: false }); }
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req, socket, head) => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    const accept = () => {
      if (!wsServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
      try {
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    };
    const checkOrigin = () => {
      try {
        const result = isRequestOriginAllowed(req);
        if (!(result instanceof Promise)) {
          if (result) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        void result.then((allowed) => {
          if (allowed) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        }).catch(() => rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    };
    if (!uiAuthController?.enabled) { accept(); return; }
    try {
      const result = uiAuthController.ensureSessionToken(req, null);
      if (!(result instanceof Promise)) {
        if (result) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      void result.then((sessionToken) => {
        if (sessionToken) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
      }).catch(() => rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'));
    } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
  };
  server.on('upgrade', upgradeHandler);

  app.get('/api/terminal/shells', async (_req, res) => {
    try {
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list terminal shells' });
    }
  });
  app.get('/api/terminal/sessions', (req, res) => {
    const rawCwd = typeof req.query?.cwd === 'string' ? req.query.cwd.trim() : '';
    const cwdFilter = rawCwd ? path.resolve(rawCwd) : null;
    const list = [];
    for (const session of sessions.values()) {
      if (cwdFilter && path.resolve(session.cwd) !== cwdFilter) continue;
      list.push({
        sessionId: session.id,
        cwd: session.cwd,
        status: session.status,
        createdAt: Number.isInteger(session.createdAt) ? session.createdAt : null,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    res.json({ sessions: list });
  });
  app.post('/api/terminal/touch', (req, res) => {
    const rawIds = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
    const now = Date.now();
    let touched = 0;
    for (const id of rawIds) {
      if (typeof id !== 'string') continue;
      const session = sessions.get(id);
      if (!session) continue;
      session.lastActivity = now;
      touched += 1;
    }
    res.json({ touched });
  });
  app.post('/api/terminal/create', async (req, res) => {
    try {
      const session = await createSession(req.body ?? {});
      res.json({
        sessionId: session.id,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    catch (error) { res.status(error?.message === 'Maximum terminal sessions reached' ? 429 : 400).json(errorBody(error, 'Failed to create terminal session')); }
  });
  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = req.body ?? {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { if (session.status === 'running') session.process?.resize(cols, rows); session.cols = cols; session.rows = rows; res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: error?.message || 'Failed to resize terminal' }); }
  });
  app.post('/api/terminal/:sessionId/appearance', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, req.body ?? {});
    res.json({ success: true });
  });
  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    if ((session.mode ?? INTERACTIVE_TERMINAL_MODE) === COMMAND_TERMINAL_MODE) return res.status(400).json({ error: 'Command-mode terminal sessions cannot be restarted' });
    const cwd = req.body?.cwd ?? session.cwd;
    const cols = req.body?.cols ?? session.cols;
    const rows = req.body?.rows ?? session.rows;
    const themeMode = req.body?.themeMode ?? session.themeMode;
    const terminalBackground = req.body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = req.body?.terminalForeground ?? session.terminalForeground;
    const shell = req.body?.shell ?? 'auto';
    const loginShell = req.body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      await validateCwd(cwd);
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
      const oldProcess = session.process;
      const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell });
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = cwd; session.cols = cols; session.rows = rows;
      session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
       wire(session, spawned.process); void terminateProcess(oldProcess); publish(session, { t: 'restarted', history: '' });
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) { res.status(400).json(errorBody(error, 'Failed to restart terminal')); }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  app.delete('/api/terminal/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      const pending = pendingSessionCreates.get(req.params.sessionId);
      if (!pending) return res.status(404).json({ error: 'Terminal session not found' });
      pending.cancelled = true;
      try { await pending.promise; }
      catch (error) {
        if (error?.message !== 'Terminal session was closed during creation') throw error;
      }
      return res.json({ success: true });
    }
    sessions.delete(session.id);
    closeAttachments(session.id, 'CLOSED', 'Terminal closed');
    await terminateProcess(session.process);
    res.json({ success: true });
  });
  app.post('/api/terminal/force-kill', (req, res) => {
    const { sessionId, cwd } = req.body ?? {}; let killedCount = 0;
    const killedSessionIds = [];
    for (const [id, session] of sessions) {
      if ((sessionId && id !== sessionId) || (!sessionId && cwd && session.cwd !== cwd)) continue;
      sessions.delete(id); closeAttachments(id, 'KILLED', 'Terminal was killed'); void terminateProcess(session.process, true); killedSessionIds.push(id); killedCount += 1;
    }
    res.json({ success: true, killedCount, killedSessionIds });
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (!attached && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        sessions.delete(id); closeAttachments(id, 'IDLE_TIMEOUT', 'Terminal expired after being idle'); void terminateProcess(session.process, true);
      }
    }
  }, 5 * 60 * 1000);

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    await Promise.allSettled([...pendingSessionRestarts.values()]);
    for (const session of sessions.values()) void terminateProcess(session.process, true);
    sessions.clear();
    await Promise.allSettled([...pendingTerminations]);
    if (!wsServer) return;
    for (const client of wsServer.clients) client.terminate();
    await Promise.race([
      new Promise((resolve) => wsServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    wsServer = null;
  };
  return { shutdown };
}
