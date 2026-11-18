import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { classifyLimitFailure, modelFamilyOf, parseLimitReport, parseModelSetting } from './policy.js';
import { toClaudeUsage } from '../quota/providers/claude/transforms.js';
import { createSessionAccountStore } from './session-accounts.js';

const settleSchema = z.object({ ticket: z.string().min(1), applied: z.boolean() });

// The usage sweep answers for one provider only: the Anthropic OAuth usage
// endpoint, which every stored Claude account's own token can read.
const USAGE_PROVIDER_ID = 'anthropic';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const usageReportSchema = z.object({
  providerID: z.literal(USAGE_PROVIDER_ID),
  accounts: z.array(z.object({
    id: z.string().min(1).max(200),
    label: z.string().max(200).catch(''),
    usage: z.unknown(),
  })).min(1).max(20),
});

const querySchema = z.object({
  providerID: z.string().optional(),
  sessionID: z.string().optional(),
});

const sessionAccountBodySchema = z.object({
  sessionID: z.string().min(1).max(200),
  modelID: z.string().min(1).max(200).optional().catch(undefined),
  activeCredentialID: z.string().min(1).max(200).optional().catch(undefined),
});

const sessionAccountPutSchema = z.object({
  sessionID: z.string().min(1).max(200),
  providerID: z.string().min(1).max(200),
  mode: z.enum(['global', 'preferred', 'fixed']),
  credentialID: z.string().min(1).max(200).optional(),
});

const PLUGIN_ID = 'openchamber-limit-failover';
const ROUTE = '/api/openchamber/limit-failover';

/**
 * A failure that reports an account we switched to this recently most likely
 * comes from a request sent with the previous account before the switch.
 */
const SWITCH_GRACE_MS = 60_000;

/** A named reset further out than this holds the turn too long to wait out. */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** Retry a little after the named reset, so a clock skew does not hit the closed window. */
const WAIT_SLACK_MS = 15_000;

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
const PLUGIN_SOURCE = `const LIMIT_ERROR_TYPES = new Set(["provider.quota", "provider.free-limit", "provider.budget-limit", "provider.model-budget-limit", "provider.go-limit", "provider.chatgpt-limit", "provider.rate-limit"])
const ROUTE = ${JSON.stringify(ROUTE)}
const USAGE_URL = ${JSON.stringify(USAGE_URL)}

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

// What Anthropic's anthropic-ratelimit-unified-* headers say about a 429: the
// account's rejected status, the reset epoch and the window that rejected.
const captureHeaders = (response) => {
  const status = response.headers.get("anthropic-ratelimit-unified-status")
  if (!status) return undefined
  const reset = Number(response.headers.get("anthropic-ratelimit-unified-reset"))
  const resetAt = Number.isFinite(reset) && reset > 0 ? (reset < 1e10 ? reset * 1000 : reset) : undefined
  const claim = response.headers.get("anthropic-ratelimit-unified-representative-claim")
  return { status, ...(resetAt !== undefined ? { resetAt } : {}), ...(claim ? { claim } : {}) }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    // The 429 headers a session hit last, consumed by the retry report that
    // follows it; a report without them decides as before.
    const captured = new Map()
    const rememberCaptured = (sessionID, info) => {
      captured.set(sessionID, { info, at: Date.now() })
      if (captured.size > 100) captured.delete(captured.keys().next().value)
    }
    const takeCaptured = (sessionID) => {
      const entry = captured.get(sessionID)
      if (!entry) return undefined
      captured.delete(sessionID)
      return Date.now() - entry.at <= 60_000 ? entry.info : undefined
    }

    await ctx.session.hook("http.response", async (event) => {
      if (event.model.providerID !== "anthropic" || event.response.status !== 429) return
      const info = captureHeaders(event.response)
      if (info && info.resetAt !== undefined) rememberCaptured(event.sessionID, info)
    })

    // A pinned session's turn starts on its account: the server names the
    // credential to activate, and activating the active credential is a no-op.
    await ctx.session.hook("prompt", async (event) => {
      const target = callback()
      if (!target) return
      try {
        // The turn's model and the credential active before this turn, so the
        // server can refuse an account that is out for this model and can tell
        // a real switch from a turn that was already on its pin.
        const session = await ctx.session.get?.({ sessionID: event.sessionID })?.catch(() => undefined)
        const model = session?.data?.model ?? session?.model
        const activeCredentialID = model?.providerID
          ? (await accounts(ctx, model.providerID).catch(() => undefined))?.activeCredentialID
          : undefined
        const response = await fetch(target.url + "/session-account", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({ sessionID: event.sessionID, modelID: model?.id, activeCredentialID }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (typeof answer?.activate !== "string") return
        await ctx.credential.activate({ credentialID: answer.activate })
      } catch {
        // The turn runs on whatever account is active.
      }
    })

    // Every stored Claude account's plan usage, for the account picker and the
    // headroom choice. Each account's own token reads only its usage and is
    // sent nowhere: the sweep posts the usage JSON alone.
    let sweeping = false
    const sweepUsage = async () => {
      const target = callback()
      if (!target || sweeping) return
      sweeping = true
      try {
        const provider = (await ctx.provider.get({ providerID: "anthropic" }).catch(() => undefined))?.data
        const integrationID = provider?.integrationID ?? "anthropic"
        const integration = (await ctx.integration.get({ integrationID }).catch(() => undefined))?.data
        const connections = (integration?.connections ?? []).filter((connection) => connection.type === "credential")
        const results = []
        for (const connection of connections) {
          const value = await ctx.integration.connection.resolve(connection).catch(() => undefined)
          if (value?.type !== "oauth" || typeof value.access !== "string" || value.access.length === 0) continue
          const response = await fetch(USAGE_URL, {
            headers: { authorization: "Bearer " + value.access },
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined)
          if (!response?.ok) continue
          const usage = await response.json().catch(() => undefined)
          if (usage !== null && typeof usage === "object") {
            results.push({ id: connection.id, label: connection.label ?? "", usage })
          }
        }
        if (results.length === 0) return
        await fetch(target.url + "/usage", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({ providerID: "anthropic", accounts: results }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
      } catch {
      } finally {
        sweeping = false
      }
    }
    const sweepTimer = setInterval(sweepUsage, 10 * 60_000)
    sweepTimer.unref?.()
    const firstSweep = setTimeout(sweepUsage, 5_000)
    firstSweep.unref?.()

    await ctx.session.hook("retry", async (event) => {
      if (!LIMIT_ERROR_TYPES.has(event.error?.type)) return
      const target = callback()
      if (!target) return
      const capturedInfo = takeCaptured(event.sessionID)
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
            ...(capturedInfo ? { captured: capturedInfo } : {}),
            ...(await accounts(ctx, event.model.providerID)),
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (answer.action === "fail") {
          event.decision = { retry: false }
          return
        }
        if (answer.action === "wait") {
          event.decision = { retry: true, delay: Math.max(0, Math.ceil(answer.delay)) }
          return
        }
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
        void sweepUsage()
      } catch {
        // OpenCode's own decision stands when the server cannot be reached.
      }
    })

    return () => {
      clearInterval(sweepTimer)
      clearTimeout(firstSweep)
    }
  },
}
`;

/**
 * Account switching and the fallback model when a provider's usage limit is
 * hit. The managed OpenCode plugin reports limit failures from its `retry`
 * hook, captures Anthropic's own limit headers on every 429, activates a
 * session's pinned account when its turn starts, and sweeps each stored
 * Claude account's plan usage; this runtime decides what happens next from
 * the user's settings, the per-session account pins and the accounts it has
 * seen run out, and tells every client what it switched.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`../opencode/instance-dir.js`)
 * @param {string|null} [dependencies.dataDir] the persistent data directory; the
 *   per-session account pins live there, and stay in memory when it is null
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {(req: import('express').Request) => boolean} dependencies.authorizeRequest the agent tool's callback check
 * @param {(event: { type: string, properties: object }) => void} [dependencies.broadcastUiEvent]
 * @param {() => number} [dependencies.now]
 */
export const createLimitFailoverRuntime = ({
  fsPromises,
  path,
  instanceDir,
  dataDir = null,
  readSettings,
  authorizeRequest,
  broadcastUiEvent = () => {},
  now = Date.now,
}) => {
  const pluginDirectory = path.join(instanceDir, 'limit-failover', PLUGIN_ID);
  const sessionAccounts = createSessionAccountStore({ fsPromises, path, dataDir, now });

  /**
   * Credential id -> family (`*` for the whole account) -> when that limit
   * lifts. A model-scoped window exhausts only its family on the account, so
   * an account out of Fable still serves Opus and Sonnet.
   */
  const exhaustedUntil = new Map();

  /** Provider id -> the plugin's last usage sweep: `{ at, accounts }`. */
  const accountUsage = new Map();
  /** Credential id -> when this runtime made it active. */
  const switchedAt = new Map();
  /**
   * `session:credential` -> when that session last used its one grace retry
   * on that account, or caused the switch to it. Only entries newer than the
   * account's switch count, so a later switch back gets a fresh grace.
   */
  const settledAt = new Map();
  /** Ticket id -> a switch the plugin was told to make and has not reported on yet. */
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
    // A plugin that never reported back (OpenCode stopped mid-switch) leaves nothing to announce.
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

  const markExhausted = (credentialID, scope, until) => {
    const family = scope.kind === 'account' ? '*' : scope.family;
    let families = exhaustedUntil.get(credentialID);
    if (families === undefined) {
      families = new Map();
      exhaustedUntil.set(credentialID, families);
    }
    families.set(family, Math.max(families.get(family) ?? 0, until));
  };

  /** The credential's live exhaustion marks, as the account list serves them. */
  const exhaustionOf = (credentialID, at) => {
    const families = exhaustedUntil.get(credentialID);
    if (families === undefined) return [];
    const live = [];
    for (const [family, until] of families) {
      if (until > at) live.push({ family, until });
      else families.delete(family);
    }
    if (families.size === 0) exhaustedUntil.delete(credentialID);
    return live;
  };

  const isExhaustedFor = (credentialID, families, at) => (
    exhaustionOf(credentialID, at).some((mark) => mark.family === '*' || families.includes(mark.family))
  );

  const usageSnapshot = (providerID) => accountUsage.get(providerID) ?? null;

  /** The family's weekly window percent, else the account's own weekly one. */
  const familyWindowPercent = (usage, family) => {
    if (usage === null || usage === undefined) return null;
    if (family !== null) {
      const entry = Object.entries(usage.models ?? {}).find(([name]) => name.toLowerCase() === family);
      const percent = entry ? entry[1].windows?.['7d']?.usedPercent : undefined;
      if (percent != null) return percent;
    }
    const accountPercent = usage.windows?.['7d']?.usedPercent;
    return accountPercent != null ? accountPercent : null;
  };

  /**
   * The next account after the active one, in the provider's own order, that
   * has not run out for the failing model's family. With no stored account
   * active (an environment key, or the active one could not be read) every
   * stored account is a candidate. A usage sweep reorders the free accounts
   * by the family's weekly window: the fullest account goes last.
   */
  const nextCredential = (report, at) => {
    const { credentials, activeCredentialID } = report;
    const family = modelFamilyOf(report.modelID);
    const families = family === null ? [] : [family];
    const start = credentials.findIndex((credential) => credential.id === activeCredentialID);
    const order = start === -1
      ? credentials
      : [...credentials.slice(start + 1), ...credentials.slice(0, start)];
    const free = order.filter((candidate) => !isExhaustedFor(candidate.id, families, at));
    const snapshot = usageSnapshot(report.providerID);
    if (snapshot === null || family === null) return free[0] ?? null;
    const percentOf = (candidate) => {
      const account = snapshot.accounts.find((entry) => entry.id === candidate.id);
      return account ? familyWindowPercent(account.usage, family) : null;
    };
    return free
      .map((candidate, index) => ({ candidate, index, percent: percentOf(candidate) }))
      .sort((a, b) => {
        const left = a.percent ?? Number.POSITIVE_INFINITY;
        const right = b.percent ?? Number.POSITIVE_INFINITY;
        return left !== right ? left - right : a.index - b.index;
      })
      .map((entry) => entry.candidate)[0] ?? null;
  };

  /**
   * The session's pin for the reporting provider, or null when the session
   * follows the global settings or pinned another provider.
   */
  const pinFor = async (report) => {
    const entry = await sessionAccounts.get(report.sessionID);
    return entry !== null && entry.providerID === report.providerID ? entry : null;
  };

  /**
   * What the plugin should do about one reported failure:
   * `activate-credential`, `switch-model`, `retry` (the active account changed
   * after this request went out), `fail` (a fixed session on its own account:
   * the turn ends with the error instead of moving) or `none`.
   */
  const decideNow = async (report) => {
    const at = now();
    const failure = classifyLimitFailure(report, at);
    if (!failure) return { action: 'none' };

    forgetOldSettlements(at);
    const active = report.activeCredentialID;
    // An unreadable pin file must not look like "no pin": a fixed session would
    // be switched and the next save would overwrite the file. Decide nothing.
    const pin = await pinFor(report).catch(() => 'unreadable');
    if (pin === 'unreadable') return { action: 'none' };
    const family = failure.scope.kind === 'model' ? failure.scope.family : modelFamilyOf(report.modelID);
    const families = family ? [family] : [];

    // A fixed session never rides the grace retry or the global switch: a limit
    // ends its turn, and the only move is back to its pin while that pin is
    // free for this model.
    if (pin !== null && pin.mode === 'fixed') {
      if (active) markExhausted(active, failure.scope, failure.resetAt);
      const onPin = active === undefined || active === pin.credentialID;
      if (!onPin && !isExhaustedFor(pin.credentialID, families, at)) {
        switchedAt.set(pin.credentialID, at);
        return { action: 'activate-credential', credentialID: pin.credentialID };
      }
      return waitForReset(failure, at) ?? { action: 'fail' };
    }

    if (active) {
      const key = `${report.sessionID}:${active}`;
      const switched = switchedAt.get(active);
      // A grace retry covers a request sent before a switch, not a repeat on an
      // account already out for this model: that one is marked and decided.
      const alreadyOut = isExhaustedFor(active, families, at);
      if (!alreadyOut && switched !== undefined && !((settledAt.get(key) ?? -Infinity) >= switched)) {
        settledAt.set(key, at);
        return { action: 'retry' };
      }
      markExhausted(active, failure.scope, failure.resetAt);
    }

    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const switchProviders = Array.isArray(settings?.accountSwitchProviders) ? settings.accountSwitchProviders : [];
    if (switchProviders.includes(report.providerID)) {
      const next = nextCredential(report, at);
      if (next) {
        settledAt.set(`${report.sessionID}:${next.id}`, at);
        // Another session's report already chose this account and its plugin
        // has not activated it yet: same answer, no second announcement.
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
    return waitForReset(failure, at) ?? { action: 'none' };
  };

  /** Retry once the named reset lifts, when nothing else can move the turn. */
  const waitForReset = (failure, at) => {
    if (!failure.named) return null;
    const delay = failure.resetAt - at + WAIT_SLACK_MS;
    if (delay <= WAIT_SLACK_MS || delay > MAX_WAIT_MS) return null;
    return { action: 'wait', delay };
  };

  /**
   * The plugin's outcome for a ticket. An applied switch is announced to every
   * client; a failed one is forgotten, so the account it named is not treated
   * as just switched to.
   */
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

  // One decision at a time: sessions on the same account fail together, and
  // the second report must see the switch the first one made (it then gets a
  // grace retry) instead of switching again.
  let queue = Promise.resolve();
  const decide = (report) => {
    const result = queue.then(() => decideNow(report));
    queue = result.catch(() => {});
    return result;
  };

  // The account list the UI reads: the plugin's last usage sweep merged with
  // the live exhaustion marks. Marks of accounts the sweep has not seen carry
  // no usage; the UI joins them with its own credential list by id.
  const publicAccounts = (providerID) => {
    const at = now();
    const snapshot = usageSnapshot(providerID);
    const byId = new Map((snapshot?.accounts ?? []).map((account) => [account.id, account]));
    for (const credentialID of exhaustedUntil.keys()) {
      if (!byId.has(credentialID)) byId.set(credentialID, { id: credentialID, label: credentialID, usage: null });
    }
    return {
      providerID,
      usageAt: snapshot === null ? null : snapshot.at,
      accounts: [...byId.values()].map((account) => ({
        id: account.id,
        label: account.label,
        usage: account.usage ?? null,
        exhausted: exhaustionOf(account.id, at).map((mark) => ({ scope: mark.family, resetAt: mark.until })),
      })),
    };
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

    // The plugin's prompt hook: which account the session's turn should run
    // on. Answering `activate` records a switch like the failover's own, so a
    // report that raced the activation gets one grace retry instead of
    // blaming the account it just made active.
    app.post(`${ROUTE}/session-account`, express.json({ limit: '4kb' }), async (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const body = sessionAccountBodySchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'Invalid session account request' });
      const entry = await sessionAccounts.get(body.data.sessionID).catch(() => null);
      if (entry === null || (entry.mode !== 'preferred' && entry.mode !== 'fixed')) {
        return res.json({ activate: null });
      }
      // Activating the pin puts every session on it, since one credential is
      // active per provider. Skip it while the pin is out for this turn's
      // model, or for the whole account; it re-engages once the mark lifts.
      const family = body.data.modelID ? modelFamilyOf(body.data.modelID) : null;
      if (isExhaustedFor(entry.credentialID, family ? [family] : [], now())) return res.json({ activate: null });
      // A turn already on its pin changed nothing, so it gets no grace: the
      // limit it hits is its own. Only a pin that replaces another account
      // counts as a switch.
      if (body.data.activeCredentialID !== undefined && body.data.activeCredentialID !== entry.credentialID) {
        switchedAt.set(entry.credentialID, now());
      }
      return res.json({ activate: entry.credentialID });
    });

    // The plugin's usage sweep: the raw Anthropic payloads, one per stored
    // account, transformed here so the plugin stays a reporter.
    app.post(`${ROUTE}/usage`, express.json({ limit: '512kb' }), (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const body = usageReportSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'Invalid usage report' });
      accountUsage.set(body.data.providerID, {
        at: now(),
        accounts: body.data.accounts.map((account) => ({
          id: account.id,
          label: account.label || account.id,
          usage: toClaudeUsage(account.usage),
        })),
      });
      return res.json({ stored: true });
    });
  };

  // The account list and the per-session pin, read by the UI. Registered after
  // the API auth guard, unlike the plugin routes above, which carry their own
  // token check and answer before that guard.
  const registerUiRoutes = (app, express) => {
    app.get(`${ROUTE}/accounts`, (req, res) => {
      const query = querySchema.safeParse(req.query);
      const providerID = query.success ? query.data.providerID ?? '' : '';
      if (providerID !== USAGE_PROVIDER_ID) return res.json({ providerID, usageAt: null, accounts: [] });
      return res.json(publicAccounts(providerID));
    });
    app.get(`${ROUTE}/session-account`, (req, res) => {
      const query = querySchema.safeParse(req.query);
      const sessionID = query.success ? query.data.sessionID ?? '' : '';
      if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });
      sessionAccounts.get(sessionID)
        .then((entry) => res.json({ config: entry }))
        .catch(() => res.status(500).json({ error: 'Stored session accounts are unreadable' }));
    });
    app.put(`${ROUTE}/session-account`, express.json({ limit: '4kb' }), async (req, res) => {
      const body = sessionAccountPutSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'Invalid session account' });
      const { sessionID, providerID, mode, credentialID } = body.data;
      if (mode !== 'global' && credentialID === undefined) {
        return res.status(400).json({ error: 'credentialID is required unless mode is global' });
      }
      try {
        if (mode === 'global') {
          await sessionAccounts.clear(sessionID);
          return res.json({ config: null });
        }
        return res.json({ config: await sessionAccounts.set({ sessionID, providerID, mode, credentialID }) });
      } catch (error) {
        return res.status(500).json({ error: error?.message ?? 'Failed to store the session account' });
      }
    });
  };

  return { pluginDirectory, materializePlugin, decide, settle, registerRoutes, registerUiRoutes };
};
