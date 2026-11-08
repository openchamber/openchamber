import { z } from 'zod';

import type { ToolInput } from '@/lib/opencode/model';

/**
 * Reading what OpenChamber's own agent tools answered, for the chat to show
 * it in their own words. The tools answer one envelope
 * (`packages/web/server/lib/agent-tool/runtime.js`): `{ schemaVersion, ok,
 * action, data }` on success, `error.message` on failure. Behind Code Mode the
 * envelope is what the `execute` script returned, which is usually that text
 * as is, sometimes the same JSON quoted once more, and sometimes something
 * else the script made of it; anything that is not an envelope reads as
 * `null`, and the row shows its plain output.
 */

const envelopeSchema = z.object({
  ok: z.boolean(),
  action: z.string().min(1),
  data: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional().catch(undefined),
});

export type OpenChamberEnvelope = {
  ok: boolean;
  action: string;
  data: unknown;
  errorMessage: string | undefined;
};

const jsonText = z.string().transform((text, context) => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});

export const parseOpenChamberEnvelope = (output: string | undefined): OpenChamberEnvelope | null => {
  const outer = jsonText.safeParse(output?.trim() ?? '');
  if (!outer.success) return null;
  // The envelope as text, or that text quoted once more.
  const inner = jsonText.safeParse(outer.data);
  const parsed = envelopeSchema.safeParse(inner.success ? inner.data : outer.data);
  if (!parsed.success) return null;
  return {
    ok: parsed.data.ok,
    action: parsed.data.action,
    data: parsed.data.data,
    errorMessage: parsed.data.error?.message?.trim() || undefined,
  };
};

const text = z.string().trim().min(1).optional().catch(undefined);

export const linkedSchema = z.object({
  linked: z.object({
    id: text,
    number: z.number().optional().catch(undefined),
    title: text,
    url: z.string().url(),
    kind: text,
  }),
});

export const dispatchedSchema = z.object({
  sessionId: z.string().min(1),
  directory: text,
  title: text,
  agent: text,
  model: z.object({ providerID: text, modelID: text }).optional().catch(undefined),
});

export const movedSchema = z.object({
  sessionId: z.string().min(1),
  directory: text,
  worktree: z.object({ name: text, branch: text, path: text }).optional().catch(undefined),
});

export const memorySavedSchema = z.object({
  memory: z.object({
    title: text,
    type: z.enum(['fact', 'preference', 'reference']).optional().catch(undefined),
    scope: z.enum(['global', 'project']).optional().catch(undefined),
  }),
  replaced: z.boolean().optional().catch(undefined),
  // Stored, but held back from future sessions.
  warning: text,
});

export const knowledgeSavedSchema = z.object({
  todo: z.object({ text: text, completed: z.boolean().optional().catch(undefined) }).optional().catch(undefined),
  note: z.object({ body: text }).optional().catch(undefined),
  plan: z.object({ title: text, path: text }).optional().catch(undefined),
  // A plan saved without its steps checklist.
  warning: text,
}).refine((saved) => Boolean(saved.todo?.text || saved.note?.body || saved.plan?.path), 'nothing to show');

const scheduledTaskSchema = z.object({
  name: text,
  enabled: z.boolean().optional().catch(undefined),
  schedule: z.object({
    kind: z.enum(['daily', 'weekly', 'once', 'cron']),
    times: z.array(z.string()).optional().catch(undefined),
    time: text,
    date: text,
    weekdays: z.array(z.number()).optional().catch(undefined),
    cron: text,
    timezone: text,
  }),
});

export const scheduledSchema = z.object({ task: scheduledTaskSchema });

const notifiedSchema = z.object({ delivered: z.boolean() });

export const projectsListedSchema = z.object({
  projects: z.array(z.object({ id: z.string(), path: text, label: text })),
});

export const sessionsListedSchema = z.object({
  sessions: z.array(z.object({
    id: z.string().min(1),
    title: text,
    parentID: text,
    time: z.object({ updated: z.number().optional().catch(undefined) }).optional().catch(undefined),
    location: z.object({ directory: text }).optional().catch(undefined),
  })),
});

const modelRefSchema = z.object({ providerID: z.string(), modelID: z.string() });

export const modelPreferencesSchema = z.object({
  defaultModel: text,
  defaultVariant: text,
  defaultAgent: text,
  favoriteModels: z.array(modelRefSchema).catch([]),
  recentModels: z.array(modelRefSchema).catch([]),
});

export const modelsFoundSchema = z.object({
  models: z.array(z.object({ id: z.string().min(1), name: text, provider: text })),
  total: z.number().optional().catch(undefined),
  // Where the next page starts; null on the last page.
  next: z.number().nullable().optional().catch(undefined),
});

export const memoriesListedSchema = z.object({
  memories: z.array(z.object({
    memoryId: z.string(),
    title: text,
    type: z.enum(['fact', 'preference', 'reference']).optional().catch(undefined),
    scope: z.enum(['global', 'project']).optional().catch(undefined),
  })),
  // A scope that failed to load: its entries are missing from the list.
  globalUnavailable: z.boolean().optional().catch(undefined),
  projectUnavailable: z.boolean().optional().catch(undefined),
});

export const knowledgeListedSchema = z.object({
  notes: z.array(z.object({ id: z.string(), body: text })).catch([]),
  todos: z.array(z.object({ id: z.string(), text: text, completed: z.boolean().optional().catch(undefined) })).catch([]),
  plans: z.array(z.object({
    id: z.string(),
    title: text,
    path: text,
    progress: z.object({ done: z.number(), total: z.number() }).optional().catch(undefined),
  })).catch([]),
});

export const scheduleListedSchema = z.object({
  tasks: z.array(scheduledTaskSchema.extend({ id: z.string() })),
});

export const pageOpenedSchema = z.object({ url: z.string().url(), title: text });

export const screenshotSchema = z.object({
  path: z.string().trim().min(1),
  url: z.string().url().optional().catch(undefined),
  title: text,
});

const windowSchema = z.object({
  usedPercent: z.number().nullable().catch(null),
  remainingPercent: z.number().nullable().catch(null),
  resetAt: z.number().nullable().catch(null),
  resetAtFormatted: z.string().nullable().optional().catch(null),
  resetAfterFormatted: z.string().nullable().optional().catch(null),
}).passthrough();

export const usageSchema = z.object({
  providers: z.array(z.object({
    providerId: z.string(),
    providerName: text,
    ok: z.boolean(),
    error: text,
    usage: z.object({ windows: z.record(z.string(), windowSchema).optional().catch(undefined) }).nullable().optional().catch(null),
  })),
});

type UsageProviderRow = z.infer<typeof usageSchema>['providers'][number];
type UsageWindowRow = z.infer<typeof windowSchema>;

/**
 * The window of a provider that is closest to its limit: the one a person
 * glancing at the row needs. Windows without a share (a credit balance) are
 * skipped; a provider with none of them has nothing to draw.
 */
export const tightestWindow = (provider: UsageProviderRow): { key: string; window: UsageWindowRow } | null => {
  let best: { key: string; window: UsageWindowRow } | null = null;
  for (const [key, window] of Object.entries(provider.usage?.windows ?? {})) {
    if (window.usedPercent === null) continue;
    if (!best || window.usedPercent > (best.window.usedPercent ?? -1)) best = { key, window };
  }
  return best;
};

const VIEW_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ['session.link', linkedSchema],
  ['session.create', dispatchedSchema],
  ['session.send', dispatchedSchema],
  ['session.fork', dispatchedSchema],
  ['session.moveToWorktree', movedSchema],
  ['memory.save', memorySavedSchema],
  ['knowledge.save', knowledgeSavedSchema],
  ['schedule.create', scheduledSchema],
  ['schedule.update', scheduledSchema],
  ['notify.send', notifiedSchema],
  ['usage.read', usageSchema],
  ['projects.list', projectsListedSchema],
  ['session.list', sessionsListedSchema],
  ['models.list', modelPreferencesSchema],
  ['models.search', modelsFoundSchema],
  ['memory.list', memoriesListedSchema],
  ['knowledge.list', knowledgeListedSchema],
  ['schedule.list', scheduleListedSchema],
  ['browser.open', pageOpenedSchema],
  ['browser.capture', screenshotSchema],
]);

/**
 * Whether the chat has a view of its own for this answer: a successful action
 * it knows, with the data that view reads. Anything else keeps the plain
 * output, so a changed answer never leaves the row empty.
 */
export const hasOpenChamberView = (envelope: OpenChamberEnvelope): boolean => {
  if (!envelope.ok) return false;
  const schema = VIEW_SCHEMAS.get(envelope.action);
  return schema ? schema.safeParse(envelope.data).success : false;
};
const secretRunSchema = z.object({
  answer: z.union([
    z.object({
      status: z.literal('ran'),
      outcome: z.enum(['exited', 'timeout', 'killed', 'not-started']).catch('killed'),
      exitCode: z.number().int().nullable().catch(null),
    }),
    z.object({ status: z.literal('declined') }),
    z.object({ answered: z.literal(false) }),
  ]),
  stdout: z.string().optional().catch(undefined),
  stderr: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

type SecretRunVerbKey =
  | 'chat.toolPart.openchamber.action.secretRun'
  | 'chat.toolPart.openchamber.action.secretRunFailed'
  | 'chat.toolPart.openchamber.action.secretRunTimedOut'
  | 'chat.toolPart.openchamber.action.secretRunNotStarted'
  | 'chat.toolPart.openchamber.action.secretRunStopped'
  | 'chat.toolPart.openchamber.action.secretRunDeclined'
  | 'chat.toolPart.openchamber.action.secretRunNotRun'
  | 'chat.toolPart.openchamber.action.secretRequestSaved'
  | 'chat.toolPart.openchamber.action.secretRequestDeclined'
  | 'chat.toolPart.openchamber.action.secretRequestNotGiven';

const secretRequestSchema = z.object({
  answer: z.union([
    z.object({ status: z.literal('saved'), file: z.string().optional().catch(undefined) }),
    z.object({ status: z.literal('declined') }),
    z.object({ answered: z.literal(false) }),
  ]),
});

/**
 * How a finished secret tool call reads in its row. For `secret.run`: the
 * verb (with the exit code when it was not 0) and what the command printed as
 * the agent got it, stdout, stderr, then why it did not finish, values
 * already replaced by the server. For `secret.request`: the verb, and the file
 * a saved value went to. `null` for any other answer.
 */
export const secretRowView = (
  envelope: Pick<OpenChamberEnvelope, 'ok' | 'action'> & { data?: unknown } | null,
): { key: SecretRunVerbKey; code?: number; output?: string; file?: string } | null => {
  if (envelope?.ok !== true) return null;
  if (envelope.action === 'secret.request') {
    const request = secretRequestSchema.safeParse(envelope.data);
    if (!request.success) return null;
    const { answer } = request.data;
    if ('answered' in answer) return { key: 'chat.toolPart.openchamber.action.secretRequestNotGiven' };
    if (answer.status === 'declined') return { key: 'chat.toolPart.openchamber.action.secretRequestDeclined' };
    return { key: 'chat.toolPart.openchamber.action.secretRequestSaved', file: answer.file };
  }
  if (envelope.action !== 'secret.run') return null;
  const parsed = secretRunSchema.safeParse(envelope.data);
  if (!parsed.success) return null;
  const { answer, stdout = '', stderr = '', error = '' } = parsed.data;
  const output = [stdout, stderr, error].map((part) => part.trimEnd()).filter(Boolean).join('\n');
  if ('answered' in answer) return { key: 'chat.toolPart.openchamber.action.secretRunNotRun', output };
  if (answer.status === 'declined') return { key: 'chat.toolPart.openchamber.action.secretRunDeclined', output };
  if (answer.outcome === 'timeout') return { key: 'chat.toolPart.openchamber.action.secretRunTimedOut', output };
  if (answer.outcome === 'not-started') return { key: 'chat.toolPart.openchamber.action.secretRunNotStarted', output };
  if (answer.outcome === 'killed' || answer.exitCode === null) return { key: 'chat.toolPart.openchamber.action.secretRunStopped', output };
  if (answer.exitCode !== 0) return { key: 'chat.toolPart.openchamber.action.secretRunFailed', code: answer.exitCode, output };
  return { key: 'chat.toolPart.openchamber.action.secretRun', output };
};

/** The verb key of each OpenChamber tool action, for the row's subtitle once the action succeeded. */
export const OPENCHAMBER_ACTION_VERB_KEYS = {
  'projects.list': 'chat.toolPart.openchamber.action.projectsList',
  'models.list': 'chat.toolPart.openchamber.action.modelsList',
  'models.search': 'chat.toolPart.openchamber.action.modelsSearch',
  'session.list': 'chat.toolPart.openchamber.action.sessionList',
  'session.create': 'chat.toolPart.openchamber.action.sessionCreate',
  'session.send': 'chat.toolPart.openchamber.action.sessionSend',
  'session.fork': 'chat.toolPart.openchamber.action.sessionFork',
  'session.status': 'chat.toolPart.openchamber.action.sessionStatus',
  'session.messages': 'chat.toolPart.openchamber.action.sessionMessages',
  'session.moveToWorktree': 'chat.toolPart.openchamber.action.sessionMoveToWorktree',
  'session.link': 'chat.toolPart.openchamber.action.sessionLink',
  'pr.watch': 'chat.toolPart.openchamber.action.prWatch',
  'pr.unwatch': 'chat.toolPart.openchamber.action.prUnwatch',
  'work.name': 'chat.toolPart.openchamber.action.workName',
  'file.open': 'chat.toolPart.openchamber.action.fileOpen',
  'schedule.list': 'chat.toolPart.openchamber.action.scheduleList',
  'schedule.create': 'chat.toolPart.openchamber.action.scheduleCreate',
  'schedule.update': 'chat.toolPart.openchamber.action.scheduleUpdate',
  'schedule.run': 'chat.toolPart.openchamber.action.scheduleRun',
  'schedule.delete': 'chat.toolPart.openchamber.action.scheduleDelete',
  'schedule.toggle': 'chat.toolPart.openchamber.action.scheduleToggle',
  'knowledge.list': 'chat.toolPart.openchamber.action.knowledgeList',
  'knowledge.save': 'chat.toolPart.openchamber.action.knowledgeSave',
  'knowledge.delete': 'chat.toolPart.openchamber.action.knowledgeDelete',
  'knowledge.show': 'chat.toolPart.openchamber.action.knowledgeShow',
  'memory.read': 'chat.toolPart.openchamber.action.memoryRead',
  'memory.list': 'chat.toolPart.openchamber.action.memoryList',
  'memory.save': 'chat.toolPart.openchamber.action.memorySave',
  'memory.delete': 'chat.toolPart.openchamber.action.memoryDelete',
  'notify.send': 'chat.toolPart.openchamber.action.notifySend',
  'usage.read': 'chat.toolPart.openchamber.action.usageRead',
  'browser.open': 'chat.toolPart.openchamber.action.browserOpen',
  'browser.snapshot': 'chat.toolPart.openchamber.action.browserSnapshot',
  'browser.click': 'chat.toolPart.openchamber.action.browserClick',
  'browser.type': 'chat.toolPart.openchamber.action.browserType',
  'browser.select': 'chat.toolPart.openchamber.action.browserSelect',
  'browser.scroll': 'chat.toolPart.openchamber.action.browserScroll',
  'browser.back': 'chat.toolPart.openchamber.action.browserBack',
  'browser.forward': 'chat.toolPart.openchamber.action.browserForward',
  'browser.inspect': 'chat.toolPart.openchamber.action.browserInspect',
  'browser.capture': 'chat.toolPart.openchamber.action.browserCapture',
  'browser.resize': 'chat.toolPart.openchamber.action.browserResize',
  'browser.close': 'chat.toolPart.openchamber.action.browserClose',
  'image.generate': 'chat.toolPart.openchamber.action.imageGenerate',
  'render.page': 'chat.toolPart.openchamber.action.renderPage',
  'secret.request': 'chat.toolPart.openchamber.action.secretRequest',
  'secret.forget': 'chat.toolPart.openchamber.action.secretForget',
  'workflow.check': 'chat.toolPart.openchamber.action.workflowCheck',
  'workflow.run': 'chat.toolPart.openchamber.action.workflowRun',
  'workflow.status': 'chat.toolPart.openchamber.action.workflowStatus',
  'workflow.result': 'chat.toolPart.openchamber.action.workflowResult',
  'workflow.stop': 'chat.toolPart.openchamber.action.workflowStop',
  'workflow.resume': 'chat.toolPart.openchamber.action.workflowResume',
  'workflow.save': 'chat.toolPart.openchamber.action.workflowSave',
  'workflow.list': 'chat.toolPart.openchamber.action.workflowList',
} as const;

const VERB_KEYS = new Map(Object.entries(OPENCHAMBER_ACTION_VERB_KEYS));

/** The verb key of an action, or `undefined` for one without a verb. */
export const openChamberVerbKey = (action: string | undefined) => (action ? VERB_KEYS.get(action) : undefined);

/** What the views read from a call's input, inside `parameters` or beside `action`, as the plugin reads it. */
const callFields = z.object({
  projectId: text,
  directory: text,
  title: text,
  body: text,
  carry: z.array(z.string()).optional().catch(undefined),
});
const callInputSchema = callFields.extend({ parameters: callFields.optional().catch(undefined) }).catch({});

export type OpenChamberCallInput = z.infer<typeof callFields>;

export const readOpenChamberCallInput = (input: ToolInput | undefined): OpenChamberCallInput => {
  const parsed = callInputSchema.parse(input ?? {});
  return {
    projectId: parsed.parameters?.projectId ?? parsed.projectId,
    directory: parsed.parameters?.directory ?? parsed.directory,
    title: parsed.parameters?.title ?? parsed.title,
    body: parsed.parameters?.body ?? parsed.body,
    carry: parsed.parameters?.carry ?? parsed.carry,
  };
};
