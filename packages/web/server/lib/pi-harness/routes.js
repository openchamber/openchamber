import { createPiEventAdapter } from './event-adapter.js';

function sendSse(res, entry) {
  res.write(`id: ${entry.eventId}\n`);
  res.write(`event: ${entry.payload.type || 'message'}\n`);
  res.write(
    `data: ${JSON.stringify({ ...entry.payload, directory: entry.directory, payload: entry.payload })}\n\n`,
  );
}

function extractText(body) {
  if (typeof body?.text === 'string') return body.text;
  if (typeof body?.content === 'string') return body.content;
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

function extractDirectory(req, body) {
  return (
    (typeof body?.directory === 'string' && body.directory) ||
    (typeof req.query?.directory === 'string' && req.query.directory) ||
    ''
  );
}

async function syncSessionList(client, state) {
  try {
    const payload = await client.listSessions();
    const ids = Array.isArray(payload?.sessions) ? payload.sessions : [];
    for (const id of ids) {
      try {
        const info = await client.getSession(id);
        state.upsertSession(info);
      } catch {
        state.upsertSession({ sessionId: id });
      }
    }
  } catch {
    // Pi-Harness unreachable — return what we have in memory
  }
  return state.listSessions();
}

export function registerPiHarnessRoutes(app, { client, state, config, readSettings }) {
  const adapter = createPiEventAdapter({ state });

  // ---- Bootstrap endpoints ----

  app.get('/path', async (_req, res) => {
    const settings = typeof readSettings === 'function' ? await readSettings().catch(() => ({})) : {};
    const directory = settings?.lastDirectory || config.workspaceRoot || '';
    res.json({ directory });
  });

  app.get('/global/config', (_req, res) => res.json({}));

  app.get('/global/health', (_req, res) =>
    res.json({ status: 'ok', openCodeRunning: true, backendRuntime: 'pi-harness' }),
  );

  app.get('/config', (_req, res) => res.json({}));

  app.get('/config/providers', (_req, res) =>
    res.json({
      all: [
        {
          id: config.providerID,
          name: 'Pi-Harness',
          models: [{ id: config.modelID, name: config.modelID }],
        },
      ],
      connected: [
        {
          id: config.providerID,
          name: 'Pi-Harness',
          models: [{ id: config.modelID, name: config.modelID }],
        },
      ],
      default: { [config.providerID]: config.modelID },
    }),
  );

  app.get('/provider', (_req, res) =>
    res.json([
      { id: config.providerID, name: 'Pi-Harness', connected: true },
    ]),
  );

  app.get('/provider/auth', (_req, res) => res.json([]));

  app.get('/project', async (_req, res) => {
    const settings = typeof readSettings === 'function' ? await readSettings().catch(() => ({})) : {};
    const projects = Array.isArray(settings?.projects) ? settings.projects : [];
    res.json(
      projects.map((p) => ({
        id: p.id || p.path,
        name: p.name || p.path || 'Project',
        worktree: p.path || '',
        sandboxes: [],
      })),
    );
  });

  app.get('/project/current', async (_req, res) => {
    const settings = typeof readSettings === 'function' ? await readSettings().catch(() => ({})) : {};
    const project = Array.isArray(settings?.projects) ? settings.projects[0] : null;
    res.json({
      id: project?.id || 'pi-project',
      name: project?.name || 'Pi Project',
      worktree: project?.path || config.workspaceRoot || '',
    });
  });

  app.get('/agent', (_req, res) => res.json([]));
  app.get('/skill', (_req, res) => res.json([]));
  app.get('/command', (_req, res) => res.json([]));
  app.get('/question', (_req, res) => res.json([]));
  app.get('/permission', (_req, res) => res.json([]));
  app.get('/mcp', (_req, res) => res.json({}));
  app.get('/lsp', (_req, res) => res.json({}));
  app.get('/vcs', (_req, res) => res.json(null));

  // ---- Session API ----

  app.get('/session', async (_req, res, next) => {
    try {
      res.json(await syncSessionList(client, state));
    } catch (error) {
      next(error);
    }
  });

  app.post('/session', async (req, res, next) => {
    try {
      const directory = extractDirectory(req, req.body) || config.workspaceRoot || undefined;
      const model = req.body?.model || {};
      const created = await client.createSession({
        sessionId: req.body?.id || req.body?.sessionID,
        provider: model.providerID || config.providerID,
        model: model.modelID || config.modelID,
        workspaceDir: directory,
      });
      const info = state.upsertSession({
        sessionId: created.sessionId,
        workspaceDir: directory,
        title: req.body?.title,
      });
      state.publish(directory, { type: 'session.created', properties: { info } });
      res.status(201).json(info);
    } catch (error) {
      next(error);
    }
  });

  app.get('/session/status', (_req, res) => res.json(state.getStatusMap()));

  app.get('/session/:id', async (req, res, next) => {
    try {
      const existing = state.getSession(req.params.id);
      if (existing) return res.json(existing);
      const info = await client.getSession(req.params.id);
      res.json(state.upsertSession(info));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/session/:id', async (req, res, next) => {
    try {
      await client.deleteSession(req.params.id);
      const info = state.getSession(req.params.id) || { id: req.params.id };
      state.deleteSession(req.params.id);
      state.publish('global', { type: 'session.deleted', properties: { info } });
      res.json(true);
    } catch (error) {
      next(error);
    }
  });

  // ---- Session messages ----

  app.get('/session/:id/message', (req, res) => res.json(state.getMessages(req.params.id)));

  // ---- Session prompt (stream) ----

  app.post('/session/:id/message', async (req, res, next) => {
    const sessionID = req.params.id;
    const directory =
      extractDirectory(req, req.body) ||
      state.getSession(sessionID)?.directory ||
      config.workspaceRoot ||
      '';
    const content = extractText(req.body);
    const messageID = req.body?.messageID || req.body?.messageId;

    if (!content) {
      return res.status(400).json({ error: 'Pi-Harness POC requires a text prompt' });
    }

    if (Array.isArray(req.body?.parts) && req.body.parts.some((p) => p?.type === 'file')) {
      return res.status(400).json({ error: 'Pi-Harness POC does not support file attachments' });
    }

    try {
      state.addUserMessage({ sessionID, messageID, text: content });
      const controller = new AbortController();
      state.setActiveStream(sessionID, controller);

      const response = await client.sendMessageStream(sessionID, { content }, { signal: controller.signal });
      res.json(true);

      // Consume Pi SSE stream in background and translate events
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        const consume = async () => {
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const frames = buffer.split('\n\n');
              buffer = frames.pop() || '';
              for (const frame of frames) {
                const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
                if (!dataLine) continue;
                try {
                  const event = JSON.parse(dataLine.slice(5).trim());
                  adapter.apply(sessionID, directory, event);
                } catch {
                  // Skip unparseable frames
                }
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              adapter.apply(sessionID, directory, {
                type: 'error',
                error: error?.message || String(error),
              });
            }
          } finally {
            state.clearActiveStream(sessionID, controller);
          }
        };
        consume().catch(() => {});
      } else {
        state.clearActiveStream(sessionID, controller);
      }
    } catch (error) {
      state.clearActiveStream(sessionID);
      next(error);
    }
  });

  // ---- Session abort ----

  app.post('/session/:id/abort', async (req, res, next) => {
    try {
      const aborted = state.abortActiveStream(req.params.id);
      await client.cancelSession(req.params.id).catch(() => null);
      state.setStatus(req.params.id, { type: 'idle' });
      state.publish(req.body?.directory || 'global', {
        type: 'session.idle',
        properties: { sessionID: req.params.id },
      });
      res.json(aborted || true);
    } catch (error) {
      next(error);
    }
  });

  // ---- Session prompt_async (v2) ----

  app.post('/session/:id/prompt_async', async (req, res, next) => {
    // Forward prompt_async requests to the message handler
    // by merging the body and re-interpreting
    const sessionID = req.params.id;
    const directory =
      extractDirectory(req, req.body) ||
      state.getSession(sessionID)?.directory ||
      config.workspaceRoot ||
      '';
    const content = extractText(req.body);
    const messageID = req.body?.messageID || req.body?.messageId;

    if (!content) {
      return res.status(400).json({ error: 'Pi-Harness POC requires a text prompt' });
    }

    try {
      state.addUserMessage({ sessionID, messageID, text: content });
      const controller = new AbortController();
      state.setActiveStream(sessionID, controller);

      const response = await client.sendMessageStream(sessionID, { content }, { signal: controller.signal });
      res.json({ status: 'streaming', messageID: messageID || `pi_user_${Date.now()}` });

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        const consume = async () => {
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const frames = buffer.split('\n\n');
              buffer = frames.pop() || '';
              for (const frame of frames) {
                const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
                if (!dataLine) continue;
                try {
                  const event = JSON.parse(dataLine.slice(5).trim());
                  adapter.apply(sessionID, directory, event);
                } catch {
                  // skip
                }
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              adapter.apply(sessionID, directory, {
                type: 'error',
                error: error?.message || String(error),
              });
            }
          } finally {
            state.clearActiveStream(sessionID, controller);
          }
        };
        consume().catch(() => {});
      } else {
        state.clearActiveStream(sessionID, controller);
      }
    } catch (error) {
      state.clearActiveStream(sessionID);
      next(error);
    }
  });

  // ---- SSE event streams ----

  const registerEventStream = (path) => {
    app.get(path, (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const lastEventId = req.headers['last-event-id'];
      for (const entry of state.replayAfter(typeof lastEventId === 'string' ? lastEventId : '')) {
        sendSse(res, entry);
      }
      const unsubscribe = state.subscribe((entry) => sendSse(res, entry));
      req.on('close', unsubscribe);
    });
  };

  registerEventStream('/event');
  registerEventStream('/global/event');

  // ---- Static routes used by existing OpenChamber server (unauthenticated) ----

  app.get('/api/health', (_req, res) =>
    res.json({
      status: 'ok',
      openCodeRunning: true,
      backendRuntime: 'pi-harness',
      piHarnessUrl: config.baseUrl || null,
    }),
  );
}
