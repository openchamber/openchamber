import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

// The idle event wakes a waiting agent at once; this is the fallback when an
// event is missed, such as across a reconnect of the event hub.
const POLL_MS = 5_000;
const RECORD_PAGE_LIMIT = 50;

const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const recordSchema = z.object({ id: z.string().min(1), type: z.string() });
const permissionRuleSchema = z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'deny', 'ask']) });
const sessionSchema = z.object({
  id: z.string().min(1),
  model: z.object({ id: z.string().min(1), providerID: z.string().min(1), variant: z.string().optional() }).nullish(),
  permissions: z.array(permissionRuleSchema).optional(),
});
const usageSessionSchema = z.object({
  model: z.object({ id: z.string().min(1), providerID: z.string().min(1) }).nullish(),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
});

export class WorkflowAgentStopped extends Error {
  constructor() {
    super('The agent was stopped');
    this.name = 'WorkflowAgentStopped';
  }
}

/** `provider/model`, optionally with `#variant`, as OpenCode's model ref. */
const parseModelRef = (value) => {
  const [model, variant] = value.split('#');
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  const ref = { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
};

/**
 * Workflow agents are OpenCode child sessions of the session that started the
 * run, so the chat lists them as that session's subagents and the user can
 * open any of them. One agent is one session and one turn; a JSON answer that
 * does not match its schema gets a follow-up prompt in the same session.
 */
export const createWorkflowAgentSessions = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady = async () => {},
  globalEventHub,
  createClient = OpenCode.make,
  fetchImpl = fetch,
  pollMs = POLL_MS,
}) => {
  // Session id -> wakers of the turns waiting on it.
  const waiters = new Map();
  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });

  // Every v2 route lives under /api and the client appends it, so it only
  // wants the origin. Per-directory scoping is a request header.
  const getClient = async (directory) => {
    await waitForOpenCodeReady(10_000, 250);
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return createClient({ baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin, headers, fetch: fetchImpl });
  };

  /**
   * Admits a synthetic message into a session, the way dispatch-results
   * delivers a dispatched session's answer. Throws with `status` set, so the
   * caller can tell an id admitted before (409) and a gone session (404).
   */
  const postSynthetic = async (sessionId, body) => {
    const response = await fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, ''), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`OpenCode refused the workflow report with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`), { status: response.status });
    }
  };

  const unsubscribe = globalEventHub.subscribeEvent((event) => {
    for (const payload of event?.translated?.() ?? []) {
      const status = statusEventSchema.safeParse(payload);
      if (!status.success || status.data.properties.status.type !== 'idle') continue;
      for (const wake of waiters.get(status.data.properties.sessionID) ?? []) wake();
    }
  });

  const pause = (sessionId, signal) => new Promise((resolve) => {
    const set = waiters.get(sessionId) ?? new Set();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      set.delete(done);
      if (set.size === 0) waiters.delete(sessionId);
      resolve();
    };
    const timer = setTimeout(done, pollMs);
    timer.unref?.();
    set.add(done);
    waiters.set(sessionId, set);
    signal.addEventListener('abort', done, { once: true });
  });

  const readRecords = async (client, sessionId) => {
    const page = await client.message.list({ sessionID: sessionId, limit: RECORD_PAGE_LIMIT, order: 'desc' });
    return Array.isArray(page?.data) ? page.data : null;
  };

  /** The newest end-of-run record of a session, or null when it has none. */
  const latestIdleId = async (client, sessionId) => {
    const records = await readRecords(client, sessionId);
    const idle = (records ?? []).map((record) => recordSchema.safeParse(record)).find((parsed) => parsed.success && parsed.data.type === 'idle');
    return idle?.data.id ?? null;
  };

  /**
   * Waits until the turn that began after `afterIdleId` is over: the session
   * is not running, none of its own subagents runs, and OpenCode has written
   * the run's idle record. Unknown is never "over".
   */
  const waitForTurn = async (client, sessionId, afterIdleId, signal) => {
    for (;;) {
      if (signal.aborted) throw new WorkflowAgentStopped();
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      if (statuses && !statuses[sessionId]) {
        const working = await activityProbe.hasWorkingChildren(sessionId, statuses);
        if (working === false) {
          const records = await readRecords(client, sessionId).catch(() => null);
          const outcome = records ? readDispatchOutcome(records, 0, afterIdleId) : null;
          if (outcome) return outcome;
        }
      }
      await pause(sessionId, signal);
    }
  };

  const prompt = async (client, sessionId, text, signal) => {
    const afterIdleId = await latestIdleId(client, sessionId);
    // A run stopped meanwhile sends nothing; one stopped while the prompt was
    // on its way interrupts the turn it started, which the run's own
    // interrupts may have missed.
    if (signal.aborted) throw new WorkflowAgentStopped();
    await client.session.prompt({ sessionID: sessionId, text });
    if (signal.aborted) {
      await client.session.interrupt({ sessionID: sessionId }).catch(() => undefined);
      throw new WorkflowAgentStopped();
    }
    return waitForTurn(client, sessionId, afterIdleId, signal);
  };

  /**
   * Interrupts a running agent session. Failure is reported, not thrown: the
   * run is being stopped either way.
   */
  const interrupt = async (directory, sessionId) => {
    try {
      const client = await getClient(directory);
      await client.session.interrupt({ sessionID: sessionId });
    } catch (error) {
      console.warn(`[workflows] could not interrupt agent session ${sessionId}:`, error?.message ?? error);
    }
  };

  /**
   * Creates the agent's session under `parentSessionId` and runs `text` in it.
   * `onSession(sessionId)` hears the id as soon as the session exists, so a
   * stop can interrupt it. Resolves to `{ sessionId, outcome }`, where outcome
   * is dispatch-results' `{ state, text, errorMessage }`.
   */
  const start = async ({ directory, parentSessionId, title, agent, model, allowTools = [], text, signal, onSession }) => {
    const client = await getClient(directory);
    let modelRef = model ? parseModelRef(model) : null;
    if (model && !modelRef) throw new Error(`model must be provider/model or provider/model#variant, got ${model}`);
    const parent = modelRef && allowTools.length === 0
      ? null
      : sessionSchema.safeParse(await client.session.get({ sessionID: parentSessionId }).catch(() => null));
    // Like a subagent: without a model of its own the agent runs on the
    // session that started the run.
    if (!modelRef && parent?.success && parent.data.model) modelRef = parent.data.model;
    const request = { parentID: parentSessionId, title };
    if (agent) request.agent = agent;
    if (modelRef) request.model = modelRef;
    // A child given permissions of its own no longer inherits its parent's, so
    // they come first and the allows, read last, win. Without the parent's
    // rules nothing is set: the agent keeps them and answers in plain text,
    // which the prompt allows for.
    if (allowTools.length > 0 && parent?.success) {
      request.permissions = [
        ...(parent.data.permissions ?? []),
        ...allowTools.map((tool) => ({ action: tool, resource: '*', effect: 'allow' })),
      ];
    }
    const created = sessionSchema.parse(await client.session.create(request));
    onSession(created.id);
    if (signal.aborted) throw new WorkflowAgentStopped();
    const outcome = await prompt(client, created.id, text, signal);
    return { sessionId: created.id, outcome };
  };

  /** A plain session for a saved workflow the user runs where no session is open. */
  const createSession = async ({ directory, title }) => {
    const client = await getClient(directory);
    return sessionSchema.parse(await client.session.create({ title })).id;
  };

  /** A follow-up prompt in an agent's own session, such as a schema correction. */
  const followUp = async ({ directory, sessionId, text, signal }) => {
    const client = await getClient(directory);
    return prompt(client, sessionId, text, signal);
  };

  /**
   * The model an agent's session ran on and what it spent, as OpenCode keeps
   * them on the session. Null when the session cannot be read.
   */
  const readUsage = async ({ directory, sessionId }) => {
    const client = await getClient(directory);
    const session = usageSessionSchema.safeParse(await client.session.get({ sessionID: sessionId }).catch(() => null));
    if (!session.success) return null;
    const { model, cost, tokens } = session.data;
    return {
      model: model ? `${model.providerID}/${model.id}` : null,
      usage: { cost, input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write },
    };
  };

  return { start, createSession, followUp, interrupt, readUsage, postSynthetic, stop: unsubscribe };
};
