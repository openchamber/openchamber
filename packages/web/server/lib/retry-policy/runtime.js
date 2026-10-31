import { z } from 'zod';

import { RETRY_WAIT_MAX_MS } from './policy.js';

const PLUGIN_ID = 'openchamber-retry-policy';
const ROUTE = '/api/openchamber/retry-policy';
const RETRY_DELAY_MAX_MS = 2_147_483_647;

const reportSchema = z.object({
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
const PLUGIN_SOURCE = `const ROUTE = ${JSON.stringify(ROUTE)}

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.session.hook("retry", async (event) => {
      // OpenCode decides whether the failure is retryable; this plugin only
      // shortens the wait it already chose.
      if (!event.decision?.retry) return
      const delay = event.decision.delay
      if (!Number.isFinite(delay) || delay <= 0) return
      const target = callback()
      if (!target) return
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({ delay }),
          signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (!Number.isFinite(answer?.delay) || answer.delay < 0) return
        // Never lengthen what OpenCode proposed; a stale or broken answer must
        // leave its own schedule in place.
        event.decision = { retry: true, delay: Math.min(answer.delay, delay) }
      } catch {
        // OpenCode's own delay stands when the server cannot be reached.
      }
    })
  },
}
`;

/**
 * Caps the wait OpenCode puts between provider retry attempts.
 *
 * OpenCode's `session.retry` hook runs before it publishes the retry and
 * sleeps, and its `decision.delay` is mutable. The managed plugin asks this
 * runtime for the user's cap on every failed attempt, so changing the setting
 * applies to the next retry without restarting OpenCode.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`../opencode/instance-dir.js`)
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {(req: import('express').Request) => boolean} dependencies.authorizeRequest the agent tool's callback check
 */
export const createRetryPolicyRuntime = ({
  fsPromises,
  path,
  instanceDir,
  readSettings,
  authorizeRequest,
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
      if (!Number.isFinite(cap) || cap <= 0) return res.json({ delay: report.data.delay });
      return res.json({ delay: Math.min(report.data.delay, Math.min(cap, RETRY_WAIT_MAX_MS)) });
    });
  };

  return { pluginDirectory, materializePlugin, registerRoutes };
};
