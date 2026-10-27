import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// This function is serialized into the managed plugin. Keep it self-contained.
export const setupRotationPlugin = async (ctx, { url, token, request = fetch, now = Date.now }) => {
  if (!url || !token) return;
  const requests = new Map();
  const rotated = new Set();
  const controller = new AbortController();
  const terminalTypes = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted'];
  const events = ctx.event.subscribe({
    signal: controller.signal,
    types: terminalTypes,
  });
  const cleanupEvents = (async () => {
    for await (const event of events) {
      // OpenCode 2.0.32 can deliver other events despite the requested filter.
      if (!terminalTypes.includes(event.type)) continue;
      requests.delete(event.data.sessionID);
      rotated.delete(event.data.sessionID);
    }
  })().catch(() => {});
  await ctx.session.hook('model.request', (event) => {
    if (event.kind === 'primary') requests.set(event.sessionID, { startedAt: now(), claimed: false });
  }, { providerID: 'openai' });
  await ctx.session.hook('retry', async (event) => {
    const requestState = requests.get(event.sessionID);
    // Without the request boundary a concurrent switch cannot be attributed safely.
    if (!requestState || requestState.claimed) return;
    requestState.claimed = true;
    const startedAt = requestState.startedAt;
    // Native attempts include ordinary transient retries. Attempt 2 starts a
    // new logical step; a later first quota error still gets one account retry.
    if (event.attempt === 2) rotated.delete(event.sessionID);
    const recoveryAttempt = rotated.has(event.sessionID) ? 2 : 1;
    try {
      const response = await request(`${url}/account-rotation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ providerID: event.model.providerID, error: event.error,
          sessionID: event.sessionID, directory: ctx.location.directory, startedAt, recoveryAttempt }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (requests.get(event.sessionID) !== requestState) return;
      if (result.limited === true) {
        const retry = result.retry === true && recoveryAttempt === 1;
        if (retry) rotated.add(event.sessionID);
        event.decision = retry ? { retry: true, delay: 0 } : { retry: false };
      }
    } catch {
      // Callback failure leaves OpenCode's original provider error and policy intact.
    } finally {
      if (requests.get(event.sessionID) === requestState) requests.delete(event.sessionID);
    }
  }, { providerID: 'openai' });
  return async () => { controller.abort(); requests.clear(); rotated.clear(); await cleanupEvents; };
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
  recoveryAttempt: z.union([z.literal(1), z.literal(2)]),
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
    const { recoveryAttempt, ...input } = parsed.data;
    try {
      const result = await runtime.recover({ ...input, allowSwitch: recoveryAttempt === 1 });
      if (result.retry) broadcast({ type: 'openchamber:account-rotated', properties: {
        providerID: input.providerID, accountLabel: result.accountLabel, sessionID: input.sessionID,
      } });
      return res.json(result);
    } catch {
      return res.status(503).json({ error: 'Account rotation failed' });
    }
  });
};
