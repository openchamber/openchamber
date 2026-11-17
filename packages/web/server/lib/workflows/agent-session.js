import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

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
  location: z.object({ directory: z.string().min(1) }).nullish(),
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

const parseModelRef = (value) => {
  const [model, variant] = value.split('#');
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  const ref = { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
};

const workflowAgentMetadata = (parentSessionId) => ({ openchamber: { kind: 'workflow-agent', parentID: parentSessionId } });

export const createWorkflowAgentSessions = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady = async () => {},
  globalEventHub,
  createClient = OpenCode.make,
  fetchImpl = fetch,
  pollMs = POLL_MS,
}) => {
  const waiters = new Map();
  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });

  const getClient = async (directory) => {
    await waitForOpenCodeReady(10_000, 250);
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return createClient({ baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin, headers, fetch: fetchImpl });
  };

  const postSynthetic = async (sessionId, body) => {
    const response = await fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, ''), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`OpenCode refused the synthetic message with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`), { status: response.status });
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

  const latestIdleId = async (client, sessionId) => {
    const records = await readRecords(client, sessionId);
    const idle = (records ?? []).map((record) => recordSchema.safeParse(record)).find((parsed) => parsed.success && parsed.data.type === 'idle');
    return idle?.data.id ?? null;
  };

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
    if (signal.aborted) throw new WorkflowAgentStopped();
    await client.session.prompt({ sessionID: sessionId, text });
    if (signal.aborted) {
      await client.session.interrupt({ sessionID: sessionId }).catch(() => undefined);
      throw new WorkflowAgentStopped();
    }
    return waitForTurn(client, sessionId, afterIdleId, signal);
  };

  const interrupt = async (directory, sessionId) => {
    try {
      const client = await getClient(directory);
      await client.session.interrupt({ sessionID: sessionId });
    } catch (error) {
      console.warn(`[workflows] could not interrupt agent session ${sessionId}:`, error?.message ?? error);
    }
  };

  const start = async ({ directory, parentSessionId, title, agent, model, allowTools = [], text, signal, onSession }) => {
    const client = await getClient(directory);
    let modelRef = model ? parseModelRef(model) : null;
    if (model && !modelRef) throw new Error(`model must be provider/model or provider/model#variant, got ${model}`);
    const parent = sessionSchema.parse(await client.session.get({ sessionID: parentSessionId }));
    if (!modelRef && parent.model) modelRef = parent.model;
    const request = {
      title,
      metadata: workflowAgentMetadata(parentSessionId),
      location: { directory: parent.location?.directory || directory },
    };
    if (agent) request.agent = agent;
    if (modelRef) request.model = modelRef;
    const permissions = [
      ...(parent.permissions ?? []),
      ...allowTools.map((tool) => ({ action: tool, resource: '*', effect: 'allow' })),
    ];
    if (permissions.length > 0) request.permissions = permissions;
    const created = sessionSchema.parse(await client.session.create(request));
    await onSession(created.id);
    if (signal.aborted) throw new WorkflowAgentStopped();
    const outcome = await prompt(client, created.id, text, signal);
    return { sessionId: created.id, outcome };
  };

  const createSession = async ({ directory, title }) => {
    const client = await getClient(directory);
    return sessionSchema.parse(await client.session.create({ title })).id;
  };

  const followUp = async ({ directory, sessionId, text, signal }) => {
    const client = await getClient(directory);
    return prompt(client, sessionId, text, signal);
  };

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
