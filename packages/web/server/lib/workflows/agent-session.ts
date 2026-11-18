import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import type { DispatchResultsOptions } from '../dispatch-results/runtime.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import { hasErrorMessage } from './contracts.js';
import type { SyntheticMessage, WorkflowRuntimeOptions } from './contracts.js';
import type { WorkflowClientFactory, WorkflowSessionClient, WorkflowSessionRequest } from './opencode-client.js';

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

export interface WorkflowAgentSessionOptions {
  buildOpenCodeUrl: SessionActivityOptions['buildOpenCodeUrl'];
  getOpenCodeAuthHeaders: SessionActivityOptions['getOpenCodeAuthHeaders'];
  waitForOpenCodeReady?: (timeoutMs: number, pollMs: number) => Promise<void>;
  globalEventHub: Pick<DispatchResultsOptions['globalEventHub'], 'subscribeEvent'>;
  createClient?: WorkflowClientFactory;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

type AgentSessions = WorkflowRuntimeOptions['agentSessions'];
type ModelRef = NonNullable<z.infer<typeof sessionSchema>['model']>;

export class WorkflowAgentStopped extends Error {
  constructor() {
    super('The agent was stopped');
    this.name = 'WorkflowAgentStopped';
  }
}

const parseModelRef = (value: string) => {
  const [model = '', variant] = value.split('#');
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  const ref: ModelRef = { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
};

const workflowAgentMetadata = (parentSessionId: string) => ({ openchamber: { kind: 'workflow-agent', parentID: parentSessionId } });

export const createWorkflowAgentSessions = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady = async () => {},
  globalEventHub,
  createClient = OpenCode.make,
  fetchImpl = fetch,
  pollMs = POLL_MS,
}: WorkflowAgentSessionOptions) => {
  const waiters = new Map<string, Set<() => void>>();
  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });

  const getClient = async (directory: string) => {
    await waitForOpenCodeReady(10_000, 250);
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return createClient({ baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin, headers, fetch: fetchImpl });
  };

  const postSynthetic = async (sessionId: string, body: SyntheticMessage) => {
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

  const pause = (sessionId: string, signal: AbortSignal) => new Promise<void>((resolve) => {
    const set = waiters.get(sessionId) ?? new Set<() => void>();
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

  const readRecords = async (client: WorkflowSessionClient, sessionId: string) => {
    const page = await client.message.list({ sessionID: sessionId, limit: RECORD_PAGE_LIMIT, order: 'desc' });
    return Array.isArray(page?.data) ? page.data : null;
  };

  const latestIdleId = async (client: WorkflowSessionClient, sessionId: string) => {
    const records = await readRecords(client, sessionId);
    const idle = (records ?? []).map((record) => recordSchema.safeParse(record)).find(
      (parsed): parsed is z.ZodSafeParseSuccess<z.infer<typeof recordSchema>> => parsed.success && parsed.data.type === 'idle',
    );
    return idle?.data.id ?? null;
  };

  const waitForTurn = async (client: WorkflowSessionClient, sessionId: string, afterIdleId: string | null, signal: AbortSignal) => {
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

  const prompt = async (client: WorkflowSessionClient, sessionId: string, text: string, signal: AbortSignal) => {
    const afterIdleId = await latestIdleId(client, sessionId);
    if (signal.aborted) throw new WorkflowAgentStopped();
    await client.session.prompt({ sessionID: sessionId, text });
    if (signal.aborted) {
      await client.session.interrupt({ sessionID: sessionId }).catch(() => undefined);
      throw new WorkflowAgentStopped();
    }
    return waitForTurn(client, sessionId, afterIdleId, signal);
  };

  const interrupt: AgentSessions['interrupt'] = async (directory, sessionId) => {
    try {
      const client = await getClient(directory);
      await client.session.interrupt({ sessionID: sessionId });
    } catch (error) {
      console.warn(`[workflows] could not interrupt agent session ${sessionId}:`, hasErrorMessage(error) ? error.message ?? error : error);
    }
  };

  const start: AgentSessions['start'] = async ({ directory, parentSessionId, title, agent, model, allowTools = [], text, signal, onSession }) => {
    const client = await getClient(directory);
    let modelRef = model ? parseModelRef(model) : null;
    if (model && !modelRef) throw new Error(`model must be provider/model or provider/model#variant, got ${model}`);
    const parent = sessionSchema.parse(await client.session.get({ sessionID: parentSessionId }));
    if (!modelRef && parent.model) modelRef = parent.model;
    const request: WorkflowSessionRequest = {
      title,
      metadata: workflowAgentMetadata(parentSessionId),
      location: { directory: parent.location?.directory || directory },
    };
    if (agent) request.agent = agent;
    if (modelRef) request.model = modelRef;
    const permissions: z.infer<typeof permissionRuleSchema>[] = [
      ...(parent.permissions ?? []),
      ...allowTools.map((tool): z.infer<typeof permissionRuleSchema> => ({ action: tool, resource: '*', effect: 'allow' })),
    ];
    if (permissions.length > 0) request.permissions = permissions;
    const created = sessionSchema.parse(await client.session.create(request));
    await onSession(created.id);
    if (signal.aborted) throw new WorkflowAgentStopped();
    const outcome = await prompt(client, created.id, text, signal);
    return { sessionId: created.id, outcome };
  };

  const createSession: AgentSessions['createSession'] = async ({ directory, title }) => {
    const client = await getClient(directory);
    return sessionSchema.parse(await client.session.create({ title })).id;
  };

  const followUp: AgentSessions['followUp'] = async ({ directory, sessionId, text, signal }) => {
    const client = await getClient(directory);
    return prompt(client, sessionId, text, signal);
  };

  const readUsage: AgentSessions['readUsage'] = async ({ directory, sessionId }) => {
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
