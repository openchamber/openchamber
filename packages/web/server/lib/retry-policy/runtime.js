import { z } from 'zod';

import { RETRY_NOW_COMMAND, RETRY_WAIT_MAX_MS } from './policy.js';

const PLUGIN_ID = 'openchamber-retry-policy';
const ROUTE = '/api/openchamber/retry-policy';
const RETRY_DELAY_MAX_MS = 2_147_483_647;

const reportSchema = z.object({
  sessionID: z.string().min(1),
  attempt: z.number().int().positive(),
  message: z.string(),
  delay: z.number().finite().nonnegative().max(RETRY_DELAY_MAX_MS),
});

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

// No imports: OpenCode loads the entry from its own directory, where nothing
// is installed. It reaches the server through the callback address and token
// the agent tool runtime puts into the managed child's environment.
const PLUGIN_SOURCE = `const COMMAND = ${JSON.stringify(RETRY_NOW_COMMAND)}
const ROUTE = ${JSON.stringify(ROUTE)}

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

/** Resolves the retry a command names, when one is waiting. */
const waiters = new Map()

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND,
        description: "Retry the provider attempt that is waiting now",
        execute: async (input) => {
          const wake = waiters.get(input.sessionID)
          if (wake) wake()
        },
      })
    })

    await ctx.session.hook("retry", async (event) => {
      // OpenCode decides whether the failure is retryable; this plugin only
      // changes the wait it already chose.
      if (!event.decision?.retry) return
      const delay = event.decision.delay
      if (!Number.isFinite(delay) || delay <= 0) return
      const target = callback()
      if (!target) return
      const startedAt = Date.now()
      let answer
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({
            sessionID: event.sessionID,
            attempt: event.attempt,
            message: event.error?.message ?? "",
            delay,
          }),
          signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) return
        answer = await response.json()
      } catch {
        // OpenCode's own delay stands when the server cannot be reached.
        return
      }
      if (!Number.isFinite(answer?.delay) || answer.delay < 0) return
      // Never lengthen what OpenCode proposed; a stale or broken answer must
      // leave its own schedule in place.
      const capped = Math.min(answer.delay, delay)
      if (answer.hold !== true || capped <= 0) {
        event.decision = { retry: true, delay: capped }
        return
      }

      // The server already announced the wait on this side. Holding the hook
      // keeps OpenCode from sleeping it out, so the command can end it early.
      const remaining = Math.max(0, capped - (Date.now() - startedAt))
      if (remaining > 0) {
        await new Promise((resolve) => {
          let timer
          const wake = () => {
            if (timer) clearTimeout(timer)
            waiters.delete(event.sessionID)
            resolve()
          }
          waiters.set(event.sessionID, wake)
          timer = setTimeout(wake, remaining)
        })
      }
      event.decision = { retry: true, delay: 0 }
    })
  },
}
`;

/**
 * Caps the wait OpenCode puts between provider retry attempts, and optionally
 * holds that wait so the user can end it.
 *
 * OpenCode's `session.retry` hook runs before it publishes the retry and
 * sleeps, and its `decision.delay` is mutable. The managed plugin asks this
 * runtime for the user's cap on every failed attempt, so changing the setting
 * applies to the next retry without restarting OpenCode. When the retry-now
 * control is on, the plugin holds the hook instead of returning the delay;
 * OpenCode then never publishes its own retry status, so this runtime
 * announces one for the clients.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`../opencode/instance-dir.js`)
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {(req: import('express').Request) => boolean} dependencies.authorizeRequest the agent tool's callback check
 * @param {(sessionID: string, metadata: { attempt: number, message: string, next: number }) => void} [dependencies.announceRetry] the session runtime's status owner
 */
export const createRetryPolicyRuntime = ({
  fsPromises,
  path,
  instanceDir,
  readSettings,
  authorizeRequest,
  announceRetry = () => {},
}) => {
  const pluginDirectory = path.join(instanceDir, 'retry-policy', PLUGIN_ID);

  const materializePlugin = async () => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
    return pluginDirectory;
  };

  const registerRoutes = (app, express) => {
    app.post(ROUTE, express.json({ limit: '8kb' }), async (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const report = reportSchema.safeParse(req.body);
      if (!report.success) return res.status(400).json({ error: 'Invalid retry report' });
      const settings = await Promise.resolve(readSettings()).catch(() => null);
      const cap = Number(settings?.retryWaitMaxMs);
      const delay = Number.isFinite(cap) && cap > 0
        ? Math.min(report.data.delay, Math.min(cap, RETRY_WAIT_MAX_MS))
        : report.data.delay;
      const hold = settings?.retryNowEnabled === true && delay > 0;
      if (hold) {
        announceRetry(report.data.sessionID, {
          attempt: report.data.attempt,
          message: report.data.message,
          next: Date.now() + delay,
        });
      }
      return res.json({ delay, hold });
    });
  };

  return { pluginDirectory, materializePlugin, registerRoutes };
};
