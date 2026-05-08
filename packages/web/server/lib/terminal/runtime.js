import { WebSocketServer } from 'ws';
import {
  TERMINAL_INPUT_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_INPUT_WS_PATH,
  TERMINAL_OUTPUT_REPLAY_MAX_BYTES,
  appendTerminalOutputReplayChunk,
  createTerminalOutputReplayBuffer,
  createTerminalInputWsControlFrame,
  isRebindRateLimited,
  listTerminalOutputReplayChunksSince,
  normalizeTerminalInputWsMessageToText,
  parseRequestPathname,
  pruneRebindTimestamps,
  readTerminalInputWsControlFrame,
} from './index.js';

export function createTerminalRuntime({
  app,
  server,
  express,
  fs,
  path,
  uiAuthController,
  buildAugmentedPath,
  searchPathFor,
  isExecutable,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
  TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
}) {
  let ptyProviderPromise = null;
  const getPtyProvider = async () => {
    if (ptyProviderPromise) {
      return ptyProviderPromise;
    }

    ptyProviderPromise = (async () => {
      const isBunRuntime = typeof globalThis.Bun !== 'undefined';

      if (isBunRuntime) {
        try {
          const bunPty = await import('bun-pty');
          console.log('Using bun-pty for terminal sessions');
          return { spawn: bunPty.spawn, backend: 'bun-pty' };
        } catch (error) {
          console.warn('bun-pty unavailable, falling back to node-pty');
        }
      }

      try {
        const nodePty = await import('node-pty');
        console.log('Using node-pty for terminal sessions');
        return { spawn: nodePty.spawn, backend: 'node-pty' };
      } catch (error) {
        console.error('Failed to load node-pty:', error && error.message ? error.message : error);
        if (isBunRuntime) {
          throw new Error('No PTY backend available. Install bun-pty or node-pty.');
        }
        throw new Error('node-pty is not available. Run: npm rebuild node-pty (or install Bun for bun-pty)');
      }
    })();

    return ptyProviderPromise;
  };

  const getTerminalShellCandidates = () => {
    if (process.platform === 'win32') {
      const windowsCandidates = [
        process.env.OPENCHAMBER_TERMINAL_SHELL,
        process.env.SHELL,
        process.env.ComSpec,
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'pwsh.exe',
        'powershell.exe',
        'cmd.exe',
      ].filter(Boolean);

      const resolved = [];
      const seen = new Set();
      for (const candidateRaw of windowsCandidates) {
        const candidate = String(candidateRaw).trim();
        if (!candidate) continue;

        const lookedUp = candidate.includes('\\') || candidate.includes('/')
          ? candidate
          : searchPathFor(candidate);
        const executable = lookedUp && isExecutable(lookedUp) ? lookedUp : (isExecutable(candidate) ? candidate : null);
        if (!executable || seen.has(executable)) continue;
        seen.add(executable);
        resolved.push(executable);
      }
      return resolved;
    }

    const unixCandidates = [
      process.env.OPENCHAMBER_TERMINAL_SHELL,
      process.env.SHELL,
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh',
      'zsh',
      'bash',
      'sh',
    ].filter(Boolean);

    const resolved = [];
    const seen = new Set();
    for (const candidateRaw of unixCandidates) {
      const candidate = String(candidateRaw).trim();
      if (!candidate) continue;

      const lookedUp = candidate.includes('/') ? candidate : searchPathFor(candidate);
      const executable = lookedUp && isExecutable(lookedUp) ? lookedUp : (isExecutable(candidate) ? candidate : null);
      if (!executable || seen.has(executable)) continue;
      seen.add(executable);
      resolved.push(executable);
    }

    return resolved;
  };

  const utf8LocaleFallback = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  const lcCtypeFallback = process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';

  const spawnTerminalPtyWithFallback = (pty, { cols, rows, cwd, env }) => {
    const shellCandidates = getTerminalShellCandidates();
    if (shellCandidates.length === 0) {
      throw new Error('No executable shell found for terminal session');
    }

    let lastError = null;
    for (const shell of shellCandidates) {
      try {
        const ptyOptions = {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd,
          env: {
            ...env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: env.LANG || process.env.LANG || utf8LocaleFallback,
            LC_CTYPE: env.LC_CTYPE || process.env.LC_CTYPE || lcCtypeFallback,
          },
        };

        if (process.platform === 'win32') {
          ptyOptions.useConpty = true;
        }

        const ptyProcess = pty.spawn(shell, [], ptyOptions);

        return { ptyProcess, shell };
      } catch (error) {
        lastError = error;
        console.warn(`Failed to spawn PTY using shell ${shell}:`, error && error.message ? error.message : error);
      }
    }

    const baseMessage = lastError && lastError.message ? lastError.message : 'PTY spawn failed';
    throw new Error(`Failed to spawn terminal PTY with available shells (${shellCandidates.join(', ')}): ${baseMessage}`);
  };

  const terminalSessions = new Map();
  const terminalWsConnections = new Set();
  const MAX_TERMINAL_SESSIONS = 20;
  const TERMINAL_IDLE_TIMEOUT = 30 * 60 * 1000;
  const terminalRuntimeName = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
  const sanitizeTerminalEnv = (env) => {
    const next = { ...env };
    delete next.BASH_XTRACEFD;
    delete next.BASH_ENV;
    delete next.ENV;
    return next;
  };
  const terminalTransportCapabilities = {
    input: {
      preferred: 'ws',
      transports: ['http', 'ws'],
      ws: {
        path: TERMINAL_INPUT_WS_PATH,
        v: 2,
        enc: 'text+json-bin-control',
      },
    },
    stream: {
      preferred: 'ws',
      transports: ['sse', 'ws'],
      ws: {
        path: TERMINAL_INPUT_WS_PATH,
        v: 2,
        enc: 'text+json-bin-control',
      },
    },
  };

  const killTerminalProcess = (ptyProcess, mode = 'term') => {
    if (!ptyProcess) return;

    // Best-effort: try killing the process group first so child processes
    // started by shells (e.g. preview dev servers) don't orphan.
    if (process.platform !== 'win32') {
      const pid = ptyProcess.pid;
      if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(-pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM');
        } catch {
        }
      }
    }

    try {
      // node-pty accepts an optional signal string; bun-pty ignores extra args.
      ptyProcess.kill(mode === 'kill' ? 'SIGKILL' : undefined);
    } catch {
    }
  };

  const sendTerminalInputWsControl = (socket, payload) => {
    if (!socket || socket.readyState !== 1) {
      return;
    }

    try {
      socket.send(createTerminalInputWsControlFrame(payload), { binary: true });
    } catch {
    }
  };

  let terminalInputWsServer = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_INPUT_WS_MAX_PAYLOAD_BYTES,
  });

  terminalInputWsServer.on('connection', (socket) => {
    const connectionState = {
      socket,
      boundSessionId: null,
      invalidFrames: 0,
      rebindTimestamps: [],
      replayCursorBySession: new Map(),
      lastActivityAt: Date.now(),
    };

    terminalWsConnections.add(connectionState);

    sendTerminalInputWsControl(socket, { t: 'ok', v: 2 });

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);

    socket.on('pong', () => {
      connectionState.lastActivityAt = Date.now();
    });

    socket.on('message', (message, isBinary) => {
      connectionState.lastActivityAt = Date.now();

      if (isBinary) {
        const controlMessage = readTerminalInputWsControlFrame(message);
        if (!controlMessage || typeof controlMessage.t !== 'string') {
          connectionState.invalidFrames += 1;
          sendTerminalInputWsControl(socket, {
            t: 'e',
            c: 'BAD_FRAME',
            f: connectionState.invalidFrames >= 10,
          });
          if (connectionState.invalidFrames >= 10) {
            socket.close(1008, 'protocol violation');
          }
          return;
        }

        if (controlMessage.t === 'p') {
          sendTerminalInputWsControl(socket, { t: 'po', v: 2 });
          return;
        }

        if (controlMessage.t !== 'b' || typeof controlMessage.s !== 'string') {
          connectionState.invalidFrames += 1;
          sendTerminalInputWsControl(socket, {
            t: 'e',
            c: 'BAD_FRAME',
            f: connectionState.invalidFrames >= 10,
          });
          if (connectionState.invalidFrames >= 10) {
            socket.close(1008, 'protocol violation');
          }
          return;
        }

        const now = Date.now();
        connectionState.rebindTimestamps = pruneRebindTimestamps(
          connectionState.rebindTimestamps,
          now,
          TERMINAL_INPUT_WS_REBIND_WINDOW_MS
        );

        if (isRebindRateLimited(connectionState.rebindTimestamps, TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW)) {
          sendTerminalInputWsControl(socket, { t: 'e', c: 'RATE_LIMIT', f: false });
          return;
        }

        const nextSessionId = controlMessage.s.trim();
        const targetSession = terminalSessions.get(nextSessionId);
        if (!targetSession) {
          connectionState.boundSessionId = null;
          sendTerminalInputWsControl(socket, { t: 'e', c: 'SESSION_NOT_FOUND', f: false });
          return;
        }

        const replaySinceRaw =
          typeof controlMessage.r === 'number' && Number.isFinite(controlMessage.r)
            ? Math.max(0, Math.trunc(controlMessage.r))
            : 0;
        const rememberedReplayCursor = connectionState.replayCursorBySession.get(nextSessionId) ?? 0;
        const replaySince = Math.max(replaySinceRaw, rememberedReplayCursor);

        connectionState.rebindTimestamps.push(now);
        connectionState.boundSessionId = nextSessionId;
        sendTerminalInputWsControl(socket, {
          t: 'bok',
          v: 2,
          s: nextSessionId,
          runtime: terminalRuntimeName,
          ptyBackend: targetSession.ptyBackend || 'unknown',
        });

        const replayChunks = listTerminalOutputReplayChunksSince(targetSession.outputReplayBuffer, replaySince);
        for (const replayChunk of replayChunks) {
          try {
            socket.send(replayChunk.data);
            connectionState.replayCursorBySession.set(nextSessionId, replayChunk.id);
          } catch {
            break;
          }
        }
        return;
      }

      const payload = normalizeTerminalInputWsMessageToText(message);
      if (payload.length === 0) {
        return;
      }

      if (!connectionState.boundSessionId) {
        sendTerminalInputWsControl(socket, { t: 'e', c: 'NOT_BOUND', f: false });
        return;
      }

      const session = terminalSessions.get(connectionState.boundSessionId);
      if (!session) {
        connectionState.boundSessionId = null;
        sendTerminalInputWsControl(socket, { t: 'e', c: 'SESSION_NOT_FOUND', f: false });
        return;
      }

      try {
        session.ptyProcess.write(payload);
        session.lastActivity = Date.now();
      } catch {
        sendTerminalInputWsControl(socket, { t: 'e', c: 'WRITE_FAIL', f: false });
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeatInterval);
      connectionState.boundSessionId = null;
      terminalWsConnections.delete(connectionState);
    });

    socket.on('error', (error) => {
      void error;
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== TERMINAL_INPUT_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.enabled) {
          // Must be awaited: this call performs async token verification.
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        if (!terminalInputWsServer) {
          rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable');
          return;
        }

        terminalInputWsServer.handleUpgrade(req, socket, head, (ws) => {
          terminalInputWsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  });

  const wireTerminalSession = (sessionId, session) => {
    session.ptyProcess.onData((data) => {
      session.lastActivity = Date.now();
      const replayChunk = appendTerminalOutputReplayChunk(
        session.outputReplayBuffer,
        data,
        TERMINAL_OUTPUT_REPLAY_MAX_BYTES
      );

      for (const wsConnection of terminalWsConnections) {
        if (wsConnection.boundSessionId !== sessionId) {
          continue;
        }

        if (!wsConnection.socket || wsConnection.socket.readyState !== 1) {
          continue;
        }

        try {
          wsConnection.socket.send(data);
          if (replayChunk) {
            wsConnection.replayCursorBySession.set(sessionId, replayChunk.id);
          }
        } catch {
        }
      }
    });

    session.ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      for (const wsConnection of terminalWsConnections) {
        if (wsConnection.boundSessionId !== sessionId) {
          continue;
        }

        wsConnection.boundSessionId = null;
        wsConnection.replayCursorBySession.delete(sessionId);
        sendTerminalInputWsControl(wsConnection.socket, {
          t: 'x',
          v: 2,
          s: sessionId,
          exitCode,
          signal,
        });
      }

      terminalSessions.delete(sessionId);
    });
  };

  const idleSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of terminalSessions.entries()) {
      if (now - session.lastActivity > TERMINAL_IDLE_TIMEOUT) {
        console.log(`Cleaning up idle terminal session: ${sessionId}`);
        try {
          killTerminalProcess(session.ptyProcess, 'term');
        } catch (error) {

        }
        terminalSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  app.post('/api/terminal/create', async (req, res) => {
    try {
      if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
        return res.status(429).json({ error: 'Maximum terminal sessions reached' });
      }

      const { cwd, cols, rows } = req.body;
      if (!cwd) {
        return res.status(400).json({ error: 'cwd is required' });
      }

      try {
        await fs.promises.access(cwd);
      } catch {
        return res.status(400).json({ error: 'Invalid working directory' });
      }

      const sessionId = Math.random().toString(36).substring(2, 15) +
                        Math.random().toString(36).substring(2, 15);

      const envPath = buildAugmentedPath();
      const resolvedEnv = sanitizeTerminalEnv({ ...process.env, PATH: envPath });

      const pty = await getPtyProvider();
      const { ptyProcess, shell } = spawnTerminalPtyWithFallback(pty, {
        cols,
        rows,
        cwd,
        env: resolvedEnv,
      });

      const session = {
        ptyProcess,
        ptyBackend: pty.backend,
        cwd,
        lastActivity: Date.now(),
        clients: new Set(),
        outputReplayBuffer: createTerminalOutputReplayBuffer(),
      };

      terminalSessions.set(sessionId, session);
      wireTerminalSession(sessionId, session);

      console.log(`Created terminal session: ${sessionId} in ${cwd} using shell ${shell}`);
      res.json({ sessionId, cols: cols || 80, rows: rows || 24, capabilities: terminalTransportCapabilities });
    } catch (error) {
      console.error('Failed to create terminal session:', error);
      res.status(500).json({ error: error.message || 'Failed to create terminal session' });
    }
  });

  app.get('/api/terminal/:sessionId/stream', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const clientId = Math.random().toString(36).substring(7);
    session.clients.add(clientId);
    session.lastActivity = Date.now();

    const ptyBackend = session.ptyBackend || 'unknown';
    res.write(`data: ${JSON.stringify({ type: 'connected', runtime: terminalRuntimeName, ptyBackend })}\n\n`);

    const heartbeatInterval = setInterval(() => {
      try {

        res.write(': heartbeat\n\n');
      } catch (error) {
        console.error(`Heartbeat failed for client ${clientId}:`, error);
        clearInterval(heartbeatInterval);
      }
    }, 15000);

    const dataHandler = (data) => {
      try {
        session.lastActivity = Date.now();
        const ok = res.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`);
        if (!ok && session.ptyProcess && typeof session.ptyProcess.pause === 'function') {
          session.ptyProcess.pause();
          res.once('drain', () => {
            if (session.ptyProcess && typeof session.ptyProcess.resume === 'function') {
              session.ptyProcess.resume();
            }
          });
        }
      } catch (error) {
        console.error(`Error sending data to client ${clientId}:`, error);
        cleanup();
      }
    };

    const exitHandler = ({ exitCode, signal }) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'exit', exitCode, signal })}\n\n`);
        res.end();
      } catch (error) {

      }
      cleanup();
    };

    const dataDisposable = session.ptyProcess.onData(dataHandler);
    const exitDisposable = session.ptyProcess.onExit(exitHandler);

    const cleanup = () => {
      clearInterval(heartbeatInterval);
      session.clients.delete(clientId);

      if (dataDisposable && typeof dataDisposable.dispose === 'function') {
        dataDisposable.dispose();
      }
      if (exitDisposable && typeof exitDisposable.dispose === 'function') {
        exitDisposable.dispose();
      }

      try {
        res.end();
      } catch (error) {

      }

      console.log(`Client ${clientId} disconnected from terminal session ${sessionId}`);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

    console.log(`Terminal connected: session=${sessionId} client=${clientId} runtime=${terminalRuntimeName} pty=${ptyBackend}`);
  });

  app.post('/api/terminal/:sessionId/input', express.text({ type: '*/*' }), (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    const data = typeof req.body === 'string' ? req.body : '';

    try {
      session.ptyProcess.write(data);
      session.lastActivity = Date.now();
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to write to terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to write to terminal' });
    }
  });

  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    const { cols, rows } = req.body;
    if (!cols || !rows) {
      return res.status(400).json({ error: 'cols and rows are required' });
    }

    try {
      session.ptyProcess.resize(cols, rows);
      session.lastActivity = Date.now();
      res.json({ success: true, cols, rows });
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to resize terminal' });
    }
  });

  app.delete('/api/terminal/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    try {
      killTerminalProcess(session.ptyProcess, 'term');
      terminalSessions.delete(sessionId);
      console.log(`Closed terminal session: ${sessionId}`);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to close terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to close terminal' });
    }
  });

  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const { sessionId } = req.params;
    const { cwd, cols, rows } = req.body;

    if (!cwd) {
      return res.status(400).json({ error: 'cwd is required' });
    }

    const existingSession = terminalSessions.get(sessionId);
    if (existingSession) {
      try {
        killTerminalProcess(existingSession.ptyProcess, 'term');
      } catch (error) {
      }
      terminalSessions.delete(sessionId);
    }

    try {
      try {
        const stats = await fs.promises.stat(cwd);
        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Invalid working directory: not a directory' });
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid working directory: not accessible' });
      }

      const newSessionId = Math.random().toString(36).substring(2, 15) +
                          Math.random().toString(36).substring(2, 15);

      const envPath = buildAugmentedPath();
      const resolvedEnv = sanitizeTerminalEnv({ ...process.env, PATH: envPath });

      const pty = await getPtyProvider();
      const { ptyProcess, shell } = spawnTerminalPtyWithFallback(pty, {
        cols,
        rows,
        cwd,
        env: resolvedEnv,
      });

      const session = {
        ptyProcess,
        ptyBackend: pty.backend,
        cwd,
        lastActivity: Date.now(),
        clients: new Set(),
        outputReplayBuffer: createTerminalOutputReplayBuffer(),
      };

      terminalSessions.set(newSessionId, session);
      wireTerminalSession(newSessionId, session);

      console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${cwd} using shell ${shell}`);
      res.json({ sessionId: newSessionId, cols: cols || 80, rows: rows || 24, capabilities: terminalTransportCapabilities });
    } catch (error) {
      console.error('Failed to restart terminal session:', error);
      res.status(500).json({ error: error.message || 'Failed to restart terminal session' });
    }
  });

  app.post('/api/terminal/force-kill', (req, res) => {
    const { sessionId, cwd } = req.body;
    let killedCount = 0;

    if (sessionId) {
      const session = terminalSessions.get(sessionId);
      if (session) {
        try {
          killTerminalProcess(session.ptyProcess, 'kill');
        } catch (error) {
        }
        terminalSessions.delete(sessionId);
        killedCount++;
      }
    } else if (cwd) {
      for (const [id, session] of terminalSessions) {
        if (session.cwd === cwd) {
          try {
            killTerminalProcess(session.ptyProcess, 'kill');
          } catch (error) {
          }
          terminalSessions.delete(id);
          killedCount++;
        }
      }
    } else {
      for (const [id, session] of terminalSessions) {
        try {
          killTerminalProcess(session.ptyProcess, 'kill');
        } catch (error) {
        }
        terminalSessions.delete(id);
        killedCount++;
      }
    }

    console.log(`Force killed ${killedCount} terminal session(s)`);
    res.json({ success: true, killedCount });
  });

  const shutdown = async () => {
    if (idleSweepInterval) {
      clearInterval(idleSweepInterval);
    }

    for (const [sessionId, session] of terminalSessions.entries()) {
      try {
        killTerminalProcess(session.ptyProcess, 'kill');
      } catch {
      }
      terminalSessions.delete(sessionId);
    }

    if (!terminalInputWsServer) {
      return;
    }

    try {
      for (const client of terminalInputWsServer.clients) {
        try {
          client.terminate();
        } catch {
        }
      }

      await new Promise((resolve) => {
        terminalInputWsServer.close(() => resolve());
      });
    } catch {
    } finally {
      terminalInputWsServer = null;
    }
  };

  return { shutdown };
}
