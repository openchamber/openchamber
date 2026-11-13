import { z } from 'zod';

/**
 * A workflow run as the OpenChamber server summarizes it
 * (`packages/web/server/lib/workflows/runtime.js`, `summarizeRun`): the plan,
 * the agents with their state and session, and recent log lines. The script and
 * the agents' full answers stay on the server.
 */

const agentStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'stopped']);
const runStateSchema = z.enum(['awaiting-approval', 'running', 'completed', 'failed', 'stopped', 'declined']);

const workflowAgentSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  phase: z.string().nullable(),
  state: agentStateSchema,
  sessionId: z.string().min(1).optional(),
  replayed: z.boolean().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The model it ran on (`provider/model`), or asked for while it runs. */
  model: z.string().optional(),
  /** What its session spent; read once the agent's call settles. */
  usage: z.object({
    cost: z.number(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }).optional(),
  error: z.string().optional(),
  preview: z.string().optional(),
});

export const workflowRunSchema = z.object({
  id: z.string().min(1),
  parentSessionId: z.string().min(1),
  directory: z.string(),
  name: z.string(),
  description: z.string(),
  state: runStateSchema,
  attempt: z.number(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  currentPhase: z.string().nullable(),
  phases: z.array(z.string()),
  agents: z.array(workflowAgentSchema),
  logs: z.array(z.object({ at: z.number(), message: z.string() })),
  error: z.string().optional(),
  resultPreview: z.string().optional(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowRunState = WorkflowRun['state'];
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;
export type WorkflowAgentState = WorkflowAgent['state'];

export const workflowRunListSchema = z.object({ runs: z.array(workflowRunSchema) });

/**
 * An answer as the panel shows it: text an agent or script wrote, read as
 * markdown, or a JSON value (a schema answer, a script's object), shown as JSON.
 */
/**
 * A JSON value as a tree the panel can lay out: lists of records become
 * cards, records become labelled fields, everything else reads as text.
 */
export type JsonNode =
  | { kind: 'scalar'; text: string; tone: 'string' | 'number' | 'boolean' | 'null' }
  | { kind: 'list'; items: JsonNode[] }
  | { kind: 'record'; entries: [string, JsonNode][] };

const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() => z.union([
  z.string().transform((text): JsonNode => ({ kind: 'scalar', text, tone: 'string' })),
  z.number().transform((value): JsonNode => ({ kind: 'scalar', text: String(value), tone: 'number' })),
  z.boolean().transform((value): JsonNode => ({ kind: 'scalar', text: String(value), tone: 'boolean' })),
  z.null().transform((): JsonNode => ({ kind: 'scalar', text: 'null', tone: 'null' })),
  z.array(jsonNodeSchema).transform((items): JsonNode => ({ kind: 'list', items })),
  z.record(z.string(), jsonNodeSchema).transform((record): JsonNode => ({ kind: 'record', entries: Object.entries(record) })),
]));

const workflowAnswerSchema = z.union([
  z.string().transform((text) => ({ kind: 'text' as const, text })),
  z.json().transform((value) => ({ kind: 'json' as const, value, tree: jsonNodeSchema.parse(value) })),
]);

export type WorkflowAnswer = z.infer<typeof workflowAnswerSchema>;

/** What the Workflows panel reads of one run beyond its summary. */
export const workflowRunDetailSchema = z.object({
  runId: z.string().min(1),
  logs: z.array(z.object({ at: z.number(), message: z.string() })),
  script: z.string(),
  // Whatever JSON the agent passed: an object by convention, a list or a string allowed.
  args: z.json().optional(),
  result: workflowAnswerSchema.optional(),
});

export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>;

/** One agent's prompt and full answer. */
export const workflowAgentDetailSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  schema: z.json().optional(),
  result: workflowAnswerSchema.optional(),
  error: z.string().optional(),
});

export type WorkflowAgentDetail = z.infer<typeof workflowAgentDetailSchema>;

/** Tokens an agent spent on its own work; cache reads are left out, they dwarf the rest and cost little. */
export const workflowAgentTokens = (agent: WorkflowAgent): number | null => (
  agent.usage ? agent.usage.input + agent.usage.output + agent.usage.reasoning + agent.usage.cacheWrite : null
);

type WorkflowRunTotals = { tokens: number; cost: number; measured: number };

/** What these agents spent, over those whose session was read; replayed answers cost nothing this attempt. */
export const workflowAgentsTotals = (agents: readonly WorkflowAgent[]): WorkflowRunTotals => {
  let tokens = 0;
  let cost = 0;
  let measured = 0;
  for (const agent of agents) {
    if (agent.replayed || !agent.usage) continue;
    tokens += workflowAgentTokens(agent) ?? 0;
    cost += agent.usage.cost;
    measured += 1;
  }
  return { tokens, cost, measured };
};

/** The whole run's spend, the same way. */
export const workflowRunTotals = (run: WorkflowRun): WorkflowRunTotals => workflowAgentsTotals(run.agents);

/** A run that is still going or still waiting for the user. */
export const isWorkflowRunOpen = (run: WorkflowRun): boolean => run.state === 'running' || run.state === 'awaiting-approval';

type WorkflowPhaseGroup = {
  title: string | null;
  agents: WorkflowAgent[];
  done: number;
  running: number;
  failed: number;
};

/**
 * The run's agents grouped by phase, in plan order: the planned phases first,
 * then any phase the script named on the way, then agents started outside a
 * phase. A planned phase nobody reached yet shows with no agents.
 */
export const groupWorkflowAgentsByPhase = (run: WorkflowRun): WorkflowPhaseGroup[] => {
  const groups = new Map<string | null, WorkflowAgent[]>();
  for (const title of run.phases) groups.set(title, []);
  for (const agent of run.agents) {
    const list = groups.get(agent.phase) ?? [];
    list.push(agent);
    groups.set(agent.phase, list);
  }
  return [...groups.entries()]
    .filter(([title, agents]) => title !== null || agents.length > 0)
    .map(([title, agents]) => ({
      title,
      agents,
      done: agents.filter((agent) => agent.state === 'completed').length,
      running: agents.filter((agent) => agent.state === 'running').length,
      failed: agents.filter((agent) => agent.state === 'failed' || agent.state === 'stopped').length,
    }));
};
