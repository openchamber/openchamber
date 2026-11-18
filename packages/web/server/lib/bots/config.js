import { z } from 'zod';
import { botSpaceSchema } from './space-options.js';

const text = z.string().trim().min(1).max(20_000);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tokens = positive.max(100_000_000).nullable().default(null);
const model = z.object({
  useDefaults: z.boolean().default(true),
  providerID: text.optional(), modelID: text.optional(), variant: text.optional(), agent: text.optional(),
}).refine((value) => value.useDefaults || Boolean(value.providerID && value.modelID), 'an explicit model needs providerID and modelID');
const mcp = z.array(z.object({ server: text, tools: z.record(text, z.enum(['allow', 'ask', 'deny'])) })).default([]);
const snowflake = z.string().regex(/^[1-9][0-9]{5,24}$/);
export const botDiscordConfigSchema = z.object({
  channels: z.array(z.object({ guildId: snowflake, channelId: snowflake }).strict()).max(100).default([]),
}).strict().refine((value) => new Set(value.channels.map((channel) => `${channel.guildId}/${channel.channelId}`)).size === value.channels.length, 'Discord channels must be unique');
const schedule = z.object({
  kind: z.enum(['manual', 'daily', 'weekly', 'cron']).default('manual'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  weekdays: z.array(z.number().int().min(0).max(6)).default([1]),
  cron: text.default('0 9 * * 1-5'), timezone: text.optional(),
}).refine((value) => value.kind !== 'weekly' || value.weekdays.length > 0, 'weekly schedules need weekdays');

export const botDefinitionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: text, enabled: z.boolean().default(true), mission: text,
  schedule: schedule.prefault({}),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('jira'), jql: text, maxItems: positive }),
    z.object({ kind: z.literal('investigation'), prompt: text, maxItems: positive }),
  ]).default({ kind: 'manual' }),
  models: z.object({ investigation: model.prefault({}), fixing: model.prefault({}), judge: model.prefault({}) }).prefault({}),
  mcp, correctionMcp: mcp, web: z.boolean().default(false),
  permissionMode: z.enum(['default', 'ask', 'safety', 'auto']).default('default'),
  goalTokenBudget: tokens, notify: z.enum(['attention', 'finish']).default('attention'), isolated: z.boolean().default(false),
  space: botSpaceSchema.optional(),
  identity: z.object({
    github: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account'), accountId: text }),
      z.object({ kind: z.literal('app'), identityId: text }),
    ]).optional(),
    jira: z.object({ identityId: text }).optional(), discord: z.object({ identityId: text }).optional(),
  }).prefault({}),
  limits: z.object({ dailyTokens: tokens, maxPendingHuman: positive.nullable().default(null) }).prefault({}),
  proof: z.object({ command: text, args: z.array(z.string().max(20_000)) }).optional(),
  jira: z.object({ doneTransition: text.optional() }).optional(),
  discord: botDiscordConfigSchema.prefault({}),
});

const editableSchema = z.object({
  concurrency: positive.default(2), retentionDays: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(90),
  definitions: z.array(botDefinitionSchema).default([]),
}).refine((value) => new Set(value.definitions.map((bot) => bot.id)).size === value.definitions.length, 'bot ids must be unique');
const approvalsSchema = z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/));
const storedSchema = editableSchema.and(z.object({ approvals: approvalsSchema.default({}) }));

export const parseConfigEdit = (raw) => editableSchema.parse(raw);
export const readBotsConfig = (raw) => {
  const result = storedSchema.safeParse(raw === undefined ? {} : raw);
  return result.success ? { ok: true, config: result.data } : { ok: false, error: result.error.message };
};

const requireConfig = (raw) => {
  const result = readBotsConfig(raw);
  if (!result.ok) throw new Error(`Invalid bots config: ${result.error}`);
  return result.config;
};

/** Personal config only. Edits cannot supply or erase machine approvals. */
export const createBotsConfig = ({ projectConfigRuntime }) => ({
  read: async (projectId) => requireConfig(await projectConfigRuntime.readBotsSection(projectId)),
  update: async (projectId, input) => {
    const edit = parseConfigEdit(input);
    return projectConfigRuntime.updateBotsSection(projectId, (raw) => ({ ...edit, approvals: requireConfig(raw).approvals }));
  },
  setApproval: async (projectId, file, fingerprint) => {
    z.string().regex(/^(?:\.agents\/areas\/[^/]+\.md|\.openchamber\/people\.json)$/).parse(file);
    if (fingerprint !== null) z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint);
    return projectConfigRuntime.updateBotsSection(projectId, (raw) => {
      const config = requireConfig(raw);
      const approvals = { ...config.approvals };
      if (fingerprint === null) delete approvals[file];
      else approvals[file] = fingerprint;
      return { ...config, approvals };
    });
  },
});
