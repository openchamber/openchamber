// Per-project configuration of Suggested tasks: whether scans run, when, what
// they look at, how much they may cost, and the lenses they run.
//
// Stored under the `suggestedTasks` key of the per-user project config file
// (`projects/project-config.js` owns the file and its lock). Every read goes
// through `readSuggestedTasksConfig`, so a missing key, a key written by an
// older build, or one edited by hand all come out as a complete config.

import { z } from 'zod';

export const LENS_ACTIONS = ['suggest', 'todo', 'session', 'worktree', 'draft-pr'];
export const LEVELS = ['low', 'medium', 'high'];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SCHEDULE_KINDS = ['manual', 'daily', 'weekly', 'cron'];

const MAX_LENSES = 20;
export const MAX_LENS_PROMPT_LENGTH = 20_000;
export const MAX_LENS_NAME_LENGTH = 80;
const MAX_SUGGESTIONS_PER_RUN = 50;
const MIN_TOKEN_BUDGET = 10_000;
const MAX_TOKEN_BUDGET = 100_000_000;
const MAX_GLOBS = 50;
const MAX_GLOB_LENGTH = 300;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

const glob = z.string().trim().min(1).max(MAX_GLOB_LENGTH);

const lensModelSchema = z.object({
  useDefaults: z.boolean().default(true),
  providerID: z.string().trim().min(1).max(200).optional(),
  modelID: z.string().trim().min(1).max(200).optional(),
  variant: z.string().trim().min(1).max(100).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
}).refine((model) => model.useDefaults || (model.providerID && model.modelID), {
  message: 'a lens that does not follow the session defaults needs a model',
});

export const lensMcpSchema = z.array(z.object({
  server: z.string().trim().min(1).max(200),
  tools: z.record(z.string().trim().min(1).max(200), z.enum(['allow', 'ask', 'deny'])),
})).max(10).default([]);

export const lensPermissionModeSchema = z.enum(['default', 'ask', 'safety', 'auto']).default('default');

const lensSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(MAX_LENS_NAME_LENGTH),
  enabled: z.boolean().default(true),
  preset: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  prompt: z.string().trim().min(1).max(MAX_LENS_PROMPT_LENGTH),
  model: lensModelSchema.default({ useDefaults: true }),
  web: z.boolean().default(false),
  mcp: lensMcpSchema,
  permissionMode: lensPermissionModeSchema,
  action: z.enum(LENS_ACTIONS).default('suggest'),
});

const scheduleSchema = z.object({
  kind: z.enum(SCHEDULE_KINDS).default('manual'),
  time: timeOfDay.default('09:00'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([1]),
  cron: z.string().trim().max(200).default('0 9 * * 1-5'),
  timezone: z.string().trim().min(1).max(100).optional(),
}).refine((schedule) => schedule.kind !== 'weekly' || schedule.weekdays.length > 0, {
  message: 'a weekly schedule needs at least one weekday',
});

const quietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  start: timeOfDay.default('22:00'),
  end: timeOfDay.default('07:00'),
});

const scopeSchema = z.object({
  include: z.array(glob).max(MAX_GLOBS).default([]),
  exclude: z.array(glob).max(MAX_GLOBS).default([]),
  // Empty: the project's checkout as it is. A branch name: a temporary
  // worktree of that branch, removed when the scan ends.
  baseBranch: z.string().trim().max(250).default(''),
  incremental: z.boolean().default(false),
});

const limitsSchema = z.object({
  maxSuggestions: z.number().int().min(1).max(MAX_SUGGESTIONS_PER_RUN).default(10),
  tokenBudget: z.number().int().min(MIN_TOKEN_BUDGET).max(MAX_TOKEN_BUDGET).nullable().default(null),
  minConfidence: z.enum(LEVELS).default('low'),
  minSeverity: z.enum(SEVERITIES).default('low'),
});

const dedupeSchema = z.object({
  dismissed: z.boolean().default(true),
  todos: z.boolean().default(true),
});

/** What the user edits. `lensApprovals` is not part of it: only the approval route writes those. */
const editableConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: scheduleSchema.prefault({}),
  quietHours: quietHoursSchema.prefault({}),
  scope: scopeSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  dedupe: dedupeSchema.prefault({}),
  notify: z.boolean().default(true),
  archiveScanSessions: z.boolean().default(true),
  lenses: z.array(lensSchema).max(MAX_LENSES).default([]),
}).refine((config) => new Set(config.lenses.map((lens) => lens.id)).size === config.lenses.length, {
  message: 'lens ids must be unique',
});

const storedConfigSchema = z.object({
  // Repository lens file path -> fingerprint of the version enabled on this machine.
  lensApprovals: z.record(z.string(), z.string()).prefault({}),
});

export const DEFAULT_CONFIG = Object.freeze({
  ...editableConfigSchema.parse({}),
  lensApprovals: {},
});

/**
 * The stored value as a complete config. A missing key is the default; a
 * key whose content no longer validates is reported, never replaced by the
 * default, so a broken file cannot pass for "turned off".
 */
export const readSuggestedTasksConfig = (raw) => {
  if (raw === undefined || raw === null) return { ok: true, config: DEFAULT_CONFIG };
  const editable = editableConfigSchema.safeParse(raw);
  const stored = storedConfigSchema.safeParse(raw);
  if (!editable.success || !stored.success) {
    const issue = (editable.error ?? stored.error)?.issues[0];
    return { ok: false, error: issue ? `${issue.path.join('.') || 'config'}: ${issue.message}` : 'invalid config' };
  }
  return { ok: true, config: { ...editable.data, lensApprovals: stored.data.lensApprovals } };
};

/** A user edit, validated; throws a message the route returns as 400. */
export const parseConfigEdit = (input) => {
  const parsed = editableConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`${issue.path.join('.') || 'config'}: ${issue.message}`), { statusCode: 400 });
  }
  return parsed.data;
};

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export const levelRank = (level) => LEVEL_RANK[level] ?? 0;
export const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;
