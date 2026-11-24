import { z } from 'zod';

import type { JsonValue, ToolPart } from '@/lib/opencode/model';
import { executeToolCalls, opencodeNamespaceTool } from '@/lib/opencode/tools';


export const OPENCODE_TOOL_VERB_KEYS = {
  session_rename: 'chat.toolPart.opencode.action.sessionRename',
  session_move: 'chat.toolPart.opencode.action.sessionMove',
  worktree_create: 'chat.toolPart.opencode.action.worktreeCreate',
  worktree_list: 'chat.toolPart.opencode.action.worktreeList',
  worktree_remove: 'chat.toolPart.opencode.action.worktreeRemove',
  models: 'chat.toolPart.opencode.action.models',
  list_mcp_resources: 'chat.toolPart.opencode.action.listMcpResources',
  read_mcp_resource: 'chat.toolPart.opencode.action.readMcpResource',
  schedule_create: 'chat.toolPart.opencode.action.scheduleCreate',
  schedule_list: 'chat.toolPart.opencode.action.scheduleList',
  schedule_pause: 'chat.toolPart.opencode.action.schedulePause',
  schedule_resume: 'chat.toolPart.opencode.action.scheduleResume',
  schedule_delete: 'chat.toolPart.opencode.action.scheduleDelete',
  automation_create: 'chat.toolPart.opencode.action.automationCreate',
  automation_list: 'chat.toolPart.opencode.action.automationList',
  automation_pause: 'chat.toolPart.opencode.action.automationPause',
  automation_resume: 'chat.toolPart.opencode.action.automationResume',
  automation_delete: 'chat.toolPart.opencode.action.automationDelete',
  artifact_create: 'chat.toolPart.opencode.action.artifactCreate',
  artifact_read: 'chat.toolPart.opencode.action.artifactRead',
  artifact_update: 'chat.toolPart.opencode.action.artifactUpdate',
  artifact_delete: 'chat.toolPart.opencode.action.artifactDelete',
} as const;

type OpencodeTool = keyof typeof OPENCODE_TOOL_VERB_KEYS;

const SHOWN_TOOLS = new Set<string>(Object.keys(OPENCODE_TOOL_VERB_KEYS));
const isShownTool = (tool: string): tool is OpencodeTool => SHOWN_TOOLS.has(tool);

export const opencodeToolVerb = (toolName: string) => {
  const tool = opencodeNamespaceTool(toolName);
  return tool && isShownTool(tool) ? { tool, key: OPENCODE_TOOL_VERB_KEYS[tool] } : null;
};

export const opencodeCallSucceeded = (part: ToolPart): boolean => {
  if (part.state.status !== 'completed') return false;
  const calls = executeToolCalls('metadata' in part.state ? part.state.metadata : undefined);
  return calls.length === 0 || calls.every((call) => call.status === 'completed');
};

const text = z.string().trim().min(1).optional().catch(undefined);

const renamedSchema = z.object({ sessionID: z.string(), title: z.string().trim().min(1) });
const movedSchema = z.object({ sessionID: z.string(), directory: z.string().trim().min(1) });
const worktreeSchema = z.object({ directory: z.string().trim().min(1) });
const worktreesSchema = z.object({
  worktrees: z.array(z.object({
    directory: z.string().trim().min(1),
    type: z.enum(['root', 'worktree']).optional().catch(undefined),
  })),
});
const worktreeRemovedSchema = z.object({ directory: z.string().trim().min(1), removed: z.boolean() });

const modelsSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    name: text,
    models: z.array(z.object({ id: z.string().min(1), name: text })),
  })),
  total: z.number().optional().catch(undefined),
  next: z.number().nullable().optional().catch(undefined),
});

const mcpCatalogSchema = z.object({
  resources: z.array(z.object({ server: z.string(), name: z.string(), uri: z.string(), description: text })),
  templates: z.array(z.object({ server: z.string(), name: z.string(), uriTemplate: z.string(), description: text })).catch([]),
});

const mcpContentSchema = z.object({
  server: z.string(),
  uri: z.string(),
  contents: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string(), mimeType: text }),
    z.object({ type: z.literal('blob'), blob: z.string(), mimeType: text }),
  ])),
});

const scheduleWhenSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('in'), in: z.string() }),
  z.object({ type: z.literal('at'), at: z.string() }),
  z.object({ type: z.literal('every'), every: z.string() }),
  z.object({ type: z.literal('cron'), cron: z.string() }),
]);

const scheduleConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shell'), run: z.string() }),
  z.object({ type: z.literal('code'), code: z.string() }),
]);

const scheduleViewSchema = z.object({
  id: z.string(),
  name: text,
  when: scheduleWhenSchema,
  tz: text,
  prompt: z.string(),
  status: z.enum(['active', 'paused', 'done']),
  nextDueAt: text,
  if: scheduleConditionSchema.optional().catch(undefined),
  until: scheduleConditionSchema.optional().catch(undefined),
  endsAt: text,
  remainingRuns: z.number().optional().catch(undefined),
});

export type ScheduleView = z.infer<typeof scheduleViewSchema>;

const schedulesSchema = z.object({
  schedules: z.array(scheduleViewSchema.nullable().catch(null)).transform((entries) => entries.filter((entry) => entry !== null)),
});
const removedSchema = z.object({ id: z.string() });

// OpenCode 2.3.1 replaced schedules with automations; the schedule readers above stay for older history.
const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('at'), at: z.string() }),
  z.object({ type: z.literal('every'), every: z.string() }),
  z.object({ type: z.literal('cron'), cron: z.string() }),
  z.object({ type: z.literal('event'), server: z.string(), event: z.string() }),
]);

const automationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), prompt: z.string(), to: z.object({ session: text, subagent: text }).optional().catch(undefined) }),
  z.object({ type: z.literal('code'), code: z.string() }),
  z.object({ type: z.literal('shell'), command: z.string() }),
]);

const automationViewSchema = z.object({
  id: z.string(),
  name: text,
  trigger: automationTriggerSchema,
  tz: text,
  action: automationActionSchema,
  status: z.enum(['active', 'paused', 'done']),
  nextDueAt: text,
  expires: text,
});

export type AutomationView = z.infer<typeof automationViewSchema>;

const automationsSchema = z.object({
  automations: z.array(automationViewSchema.nullable().catch(null)).transform((entries) => entries.filter((entry) => entry !== null)),
});

const artifactSchema = z.object({ id: z.string(), provider: text, title: z.string(), url: z.string().url() });
const artifactContentSchema = z.object({ info: artifactSchema, files: z.record(z.string(), z.string()) });

const reader = <Tool extends OpencodeTool, Schema extends z.ZodType>(tool: Tool, schema: Schema) => (data: JsonValue) => {
  const parsed = schema.safeParse(data);
  return parsed.success ? { tool, data: parsed.data } : null;
};

const READERS = {
  session_rename: reader('session_rename', renamedSchema),
  session_move: reader('session_move', movedSchema),
  worktree_create: reader('worktree_create', worktreeSchema),
  worktree_list: reader('worktree_list', worktreesSchema),
  worktree_remove: reader('worktree_remove', worktreeRemovedSchema),
  models: reader('models', modelsSchema),
  list_mcp_resources: reader('list_mcp_resources', mcpCatalogSchema),
  read_mcp_resource: reader('read_mcp_resource', mcpContentSchema),
  schedule_create: reader('schedule_create', scheduleViewSchema),
  schedule_list: reader('schedule_list', schedulesSchema),
  schedule_pause: reader('schedule_pause', scheduleViewSchema),
  schedule_resume: reader('schedule_resume', scheduleViewSchema),
  schedule_delete: reader('schedule_delete', removedSchema),
  automation_create: reader('automation_create', automationViewSchema),
  automation_list: reader('automation_list', automationsSchema),
  automation_pause: reader('automation_pause', automationViewSchema),
  automation_resume: reader('automation_resume', automationViewSchema),
  automation_delete: reader('automation_delete', removedSchema),
  artifact_create: reader('artifact_create', artifactSchema),
  artifact_read: reader('artifact_read', artifactContentSchema),
  artifact_update: reader('artifact_update', artifactSchema),
  artifact_delete: reader('artifact_delete', removedSchema),
} satisfies { [Tool in OpencodeTool]: (data: JsonValue) => { tool: Tool; data: object } | null };

const jsonText = z.string().transform((value, context) => {
  try {
    return z.json().parse(JSON.parse(value));
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});

export type OpencodeToolResult = NonNullable<ReturnType<(typeof READERS)[OpencodeTool]>>;

export const parseOpencodeToolResult = (tool: OpencodeTool, output: string | undefined): OpencodeToolResult | null => {
  const outer = jsonText.safeParse(output?.trim() ?? '');
  if (!outer.success) return null;
  const inner = jsonText.safeParse(outer.data);
  return READERS[tool](inner.success ? inner.data : outer.data);
};
