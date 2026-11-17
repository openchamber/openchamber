import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { classifyLimitFailure, parseLimitReport, parseModelSetting } from './policy.js';

const settleSchema = z.object({ ticket: z.string().min(1), applied: z.boolean() });

const PLUGIN_ID = 'openchamber-limit-failover';
const ROUTE = '/api/openchamber/limit-failover';

const SWITCH_GRACE_MS = 60_000;

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

const PLUGIN_SOURCE = `const LIMIT_ERROR_TYPES = new Set(["provider.quota", "provider.free-limit", "provider.budget-limit", "provider.model-budget-limit", "provider.rate-limit"])
const ROUTE = ${JSON.stringify(ROUTE)}

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

// Location-scoped reads answer { location, data }.
const accounts = async (ctx, providerID) => {
  const provider = (await ctx.provider.get({ providerID }).catch(() => undefined))?.data
  const integrationID = provider?.integrationID ?? providerID
  const integration = (await ctx.integration.get({ integrationID }).catch(() => undefined))?.data
  const active = await ctx.integration.connection.active(integrationID).catch(() => undefined)
  return {
    credentials: (integration?.connections ?? [])
      .filter((connection) => connection.type === "credential")
      .map((connection) => ({ id: connection.id, label: connection.label })),
    activeCredentialID: active?.type === "credential" ? active.id : undefined,
  }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.session.hook("retry", async (event) => {
      if (!LIMIT_ERROR_TYPES.has(event.error?.type)) return
      const target = callback()
      if (!target) return
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({
            sessionID: event.sessionID,
            providerID: event.model.providerID,
            modelID: event.model.id,
            error: {
              type: event.error.type,
              message: event.error.message,
              body: event.error.response?.body,
              retryAfterMs: event.error.retryAfterMs,
            },
            proposed: event.decision,
            ...(await accounts(ctx, event.model.providerID)),
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (answer.action === "retry") {
          event.decision = { retry: true, delay: 0 }
          return
        }
        if (answer.action !== "activate-credential" && answer.action !== "switch-model") return
        // The server announces a switch only once it happened, so it hears the outcome either way.
        const settle = (applied) => answer.ticket
          ? fetch(target.url + "/settle", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
              body: JSON.stringify({ ticket: answer.ticket, applied }),
              signal: AbortSignal.timeout(10_000),
            }).catch(() => undefined)
          : undefined
        try {
          if (answer.action === "activate-credential") {
            await ctx.credential.activate({ credentialID: answer.credentialID })
          } else {
            await ctx.session.switchModel({ sessionID: event.sessionID, model: answer.model })
          }
        } catch {
          await settle(false)
          return
        }
        event.decision = { retry: true, delay: 0 }
        await settle(true)
      } catch {
        // OpenCode's own decision stands when the server cannot be reached.
      }
    })
  },
}
`;

/**
 * Account switching and the fallback model when a provider's usage limit is
 * hit. The managed OpenCode plugin reports limit failures from its `retry`
 * hook; this runtime decides what happens next from the user's settings and
 * the accounts it has seen run out, and tells every client what it switched.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`../opencode/instance-dir.js`)
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {(req: import('express').Request) => boolean} dependencies.authorizeRequest the agent tool's callback check
 * @param {(event: { type: string, properties: object }) => void} [dependencies.broadcastUiEvent]
 * @param {() => number} [dependencies.now]
 */
export const createLimitFailoverRuntime = ({
  fsPromises,
  path,
  instanceDir,
  readSettings,
  authorizeRequest,
  broadcastUiEvent = () => {},
  now = Date.now,
}) => {
  const pluginDirectory = path.join(instanceDir, 'limit-failover', PLUGIN_ID);

  const exhaustedUntil = new Map();
  const switchedAt = new Map();
  const settledAt = new Map();
  const tickets = new Map();

  const openTicket = (at, ticket) => {
    const id = randomUUID();
    tickets.set(id, { ...ticket, openedAt: at });
    return id;
  };

  const forgetOldSettlements = (at) => {
    for (const [credentialID, when] of switchedAt) {
      if (when <= at - SWITCH_GRACE_MS) switchedAt.delete(credentialID);
    }
    for (const [key, when] of settledAt) {
      if (when <= at - SWITCH_GRACE_MS) settledAt.delete(key);
    }
    for (const [id, ticket] of tickets) {
      if (ticket.openedAt <= at - SWITCH_GRACE_MS) tickets.delete(id);
    }
  };

  const materializePlugin = async () => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
    return pluginDirectory;
  };

  const isExhausted = (credentialID, at) => {
    const until = exhaustedUntil.get(credentialID);
    if (until === undefined) return false;
    if (until > at) return true;
    exhaustedUntil.delete(credentialID);
    return false;
  };

  const nextCredential = (report, at) => {
    const { credentials, activeCredentialID } = report;
    const start = credentials.findIndex((credential) => credential.id === activeCredentialID);
    const order = start === -1
      ? credentials
      : [...credentials.slice(start + 1), ...credentials.slice(0, start)];
    return order.find((candidate) => !isExhausted(candidate.id, at)) ?? null;
  };

  const decideNow = async (report) => {
    const at = now();
    const failure = classifyLimitFailure(report, at);
    if (!failure) return { action: 'none' };

    forgetOldSettlements(at);
    const active = report.activeCredentialID;
    if (active) {
      const key = `${report.sessionID}:${active}`;
      const switched = switchedAt.get(active);
      if (switched !== undefined && !((settledAt.get(key) ?? -Infinity) >= switched)) {
        settledAt.set(key, at);
        return { action: 'retry' };
      }
      exhaustedUntil.set(active, failure.resetAt);
    }

    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const switchProviders = Array.isArray(settings?.accountSwitchProviders) ? settings.accountSwitchProviders : [];
    if (switchProviders.includes(report.providerID)) {
      const next = nextCredential(report, at);
      if (next) {
        settledAt.set(`${report.sessionID}:${next.id}`, at);
        if (switchedAt.has(next.id)) return { action: 'activate-credential', credentialID: next.id };
        switchedAt.set(next.id, at);
        const ticket = openTicket(at, {
          sessionID: report.sessionID,
          credentialID: next.id,
          announcement: {
            kind: 'account',
            sessionId: report.sessionID,
            providerId: report.providerID,
            fromAccount: report.credentials.find((credential) => credential.id === active)?.label ?? null,
            toAccount: next.label,
          },
        });
        return { action: 'activate-credential', credentialID: next.id, ticket };
      }
    }

    const fallback = parseModelSetting(settings?.fallbackModel, settings?.fallbackVariant);
    if (fallback && !(fallback.providerID === report.providerID && fallback.id === report.modelID)) {
      const ticket = openTicket(at, {
        sessionID: report.sessionID,
        credentialID: null,
        announcement: {
          kind: 'model',
          sessionId: report.sessionID,
          providerId: report.providerID,
          modelId: report.modelID,
          toProviderId: fallback.providerID,
          toModelId: fallback.id,
        },
      });
      return { action: 'switch-model', model: fallback, ticket };
    }
    return { action: 'none' };
  };

  const settle = (ticketID, applied) => {
    const ticket = tickets.get(ticketID);
    if (!ticket) return false;
    tickets.delete(ticketID);
    if (applied) {
      broadcastUiEvent({ type: 'openchamber:limit-failover', properties: ticket.announcement });
    } else if (ticket.credentialID) {
      switchedAt.delete(ticket.credentialID);
      settledAt.delete(`${ticket.sessionID}:${ticket.credentialID}`);
    }
    return true;
  };

  let queue = Promise.resolve();
  const decide = (report) => {
    const result = queue.then(() => decideNow(report));
    queue = result.catch(() => {});
    return result;
  };

  const registerRoutes = (app, express) => {
    app.post(ROUTE, express.json({ limit: '256kb' }), async (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const report = parseLimitReport(req.body);
      if (!report) return res.status(400).json({ error: 'Invalid limit report' });
      return res.json(await decide(report));
    });
    app.post(`${ROUTE}/settle`, express.json({ limit: '16kb' }), (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const outcome = settleSchema.safeParse(req.body);
      if (!outcome.success) return res.status(400).json({ error: 'Invalid outcome' });
      return res.json({ settled: settle(outcome.data.ticket, outcome.data.applied) });
    });
  };

  return { pluginDirectory, materializePlugin, decide, settle, registerRoutes };
};
