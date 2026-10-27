import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// This function is serialized into the managed plugin. Keep it self-contained.
export const setupRotationPlugin = async (ctx, { url, token, request = fetch, now = Date.now }) => {
  if (!url || !token) return;
  const started = new Map();
  const controller = new AbortController();
  const events = ctx.event.subscribe({
    signal: controller.signal,
    types: ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted'],
  });
  const cleanupEvents = (async () => {
    for await (const event of events) started.delete(event.data.sessionID);
  })().catch(() => {});
  await ctx.session.hook('model.request', (event) => {
    if (event.kind === 'primary') started.set(event.sessionID, now());
  }, { providerID: 'openai' });
  await ctx.session.hook('retry', async (event) => {
    const startedAt = started.get(event.sessionID);
    started.delete(event.sessionID);
    // Without the request boundary a concurrent switch cannot be attributed safely.
    if (startedAt === undefined) return;
    try {
      const response = await request(`${url}/account-rotation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ providerID: event.model.providerID, error: event.error,
          sessionID: event.sessionID, directory: ctx.location.directory, startedAt, attempt: event.attempt }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (result.limited === true) event.decision = result.retry === true && event.attempt === 2
        ? { retry: true, delay: 0 } : { retry: false };
    } catch {
      // Callback failure leaves OpenCode's original provider error and policy intact.
    }
  }, { providerID: 'openai' });
  return async () => { controller.abort(); started.clear(); await cleanupEvents; };
};

export const materializeRotationPlugin = async (dataDir) => {
  const directory = path.join(dataDir, 'account-rotation', 'plugin');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'openchamber-account-rotation', private: true, type: 'module', main: './index.js',
  }), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'index.js'), `export default {
  id: 'openchamber-account-rotation',
  setup: (ctx) => (${setupRotationPlugin.toString()})(ctx, {
    url: process.env.OPENCHAMBER_AGENT_TOOL_URL,
    token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN,
  }),
};\n`, { mode: 0o600 });
  return directory;
};

const recoverySchema = z.object({
  providerID: z.string().min(1),
  sessionID: z.string().min(1),
  directory: z.string().min(1),
  startedAt: z.number().finite().nonnegative(),
  attempt: z.number().int().min(2),
  error: z.object({ message: z.string(), status: z.number().optional(),
    response: z.object({ body: z.string() }).optional() }),
});

export const registerRotationPluginRoute = (app, { express, runtime, authorize, broadcast }) => {
  app.post('/api/openchamber/agent-tool/account-rotation', (req, res, next) => {
    if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }, express.json({ limit: '1mb' }), async (req, res) => {
    const parsed = recoverySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid rotation request' });
    const { attempt, ...input } = parsed.data;
    try {
      const result = await runtime.recover({ ...input, allowSwitch: attempt === 2 });
      if (result.retry) broadcast({ type: 'openchamber:account-rotated', properties: {
        providerID: input.providerID, accountLabel: result.accountLabel, sessionID: input.sessionID,
      } });
      return res.json(result);
    } catch {
      return res.status(503).json({ error: 'Account rotation failed' });
    }
  });
};
