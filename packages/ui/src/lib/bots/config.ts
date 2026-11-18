import { z } from 'zod';
import { isDomainName } from '@/lib/spaces/space-access';

const text = z.string().trim().min(1).max(20_000);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tokens = positive.max(100_000_000).nullable();
const modelSchema = z.object({
  useDefaults: z.boolean(), providerID: text.optional(), modelID: text.optional(),
  variant: text.optional(), agent: text.optional(),
}).refine((model) => model.useDefaults || Boolean(model.providerID && model.modelID));
const mcpSchema = z.array(z.object({ server: text, tools: z.record(text, z.enum(['allow', 'ask', 'deny'])) }));

const spaceProvider = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const spaceUpstream = z.url().max(2_000).pipe(z.string().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}));
export const botSpaceSchema = z.object({
  placeId: spaceProvider.optional(),
  network: z.object({ mode: z.enum(['allowlist', 'open']), domains: z.array(z.string().refine(isDomainName)).max(200).default([]) })
    .strict().prefault({ mode: 'allowlist' }),
  grants: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('login'), provider: spaceProvider }).strict(),
    z.object({ kind: z.literal('custom'), provider: spaceProvider }).strict(),
    z.object({ kind: z.literal('model'), provider: spaceProvider, upstream: spaceUpstream,
      secret: z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/) }).strict(),
    }).strict(),
  ])).max(16).default([]),
}).strict().refine((value) => new Set(value.grants.map((grant) => grant.provider)).size === value.grants.length);
const snowflake = z.string().regex(/^[1-9][0-9]{5,24}$/);
const discordSchema = z.object({
  channels: z.array(z.object({ guildId: snowflake, channelId: snowflake }).strict()).max(100).default([]),
}).strict().refine((value) => new Set(value.channels.map((channel) => `${channel.guildId}/${channel.channelId}`)).size === value.channels.length);

export const botDefinitionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: text, enabled: z.boolean(), mission: text,
  schedule: z.object({
    kind: z.enum(['manual', 'daily', 'weekly', 'cron']),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)), cron: text, timezone: text.optional(),
  }).refine((schedule) => schedule.kind !== 'weekly' || schedule.weekdays.length > 0),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('jira'), jql: text, maxItems: positive }),
    z.object({ kind: z.literal('investigation'), prompt: text, maxItems: positive }),
  ]),
  models: z.object({ investigation: modelSchema, fixing: modelSchema, judge: modelSchema }),
  mcp: mcpSchema, correctionMcp: mcpSchema, web: z.boolean(),
  permissionMode: z.enum(['default', 'ask', 'safety', 'auto']),
  goalTokenBudget: tokens, notify: z.enum(['attention', 'finish']), isolated: z.boolean(),
  space: botSpaceSchema.optional(),
  identity: z.object({
    github: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account'), accountId: text }),
      z.object({ kind: z.literal('app'), identityId: text }),
    ]).optional(),
    jira: z.object({ identityId: text }).optional(), discord: z.object({ identityId: text }).optional(),
  }),
  limits: z.object({ dailyTokens: tokens, maxPendingHuman: positive.nullable() }),
  proof: z.object({ command: text, args: z.array(z.string().max(20_000)) }).optional(),
  jira: z.object({ doneTransition: text.optional() }).optional(),
  discord: discordSchema.prefault({}),
});

/** Only editable fields cross back to the server. Machine approvals stay server-owned. */
export const botsConfigSchema = z.object({
  concurrency: positive, retentionDays: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  definitions: z.array(botDefinitionSchema),
}).refine((config) => new Set(config.definitions.map((bot) => bot.id)).size === config.definitions.length);

export type BotDefinition = z.infer<typeof botDefinitionSchema>;
export type BotsConfig = z.infer<typeof botsConfigSchema>;
export type BotModel = BotDefinition['models']['investigation'];

/** Editable draft only. Empty mission/name cannot pass the submission schema. */
export const newBotDraft = (): BotDefinition => ({
  id: crypto.randomUUID(), name: '', mission: '', enabled: true,
  schedule: { kind: 'manual', time: '09:00', weekdays: [1], cron: '0 9 * * 1-5' },
  source: { kind: 'manual' },
  models: { investigation: { useDefaults: true }, fixing: { useDefaults: true }, judge: { useDefaults: true } },
  mcp: [], correctionMcp: [], web: false, permissionMode: 'default',
  goalTokenBudget: null, notify: 'attention', isolated: false, identity: {},
  limits: { dailyTokens: null, maxPendingHuman: null },
  discord: { channels: [] },
});
