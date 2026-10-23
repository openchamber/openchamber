import { z } from 'zod';

const text = z.string().min(1);
const time = z.number().int().nonnegative();
const BOT_STATES = ['queued', 'investigating', 'waiting-answer', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done', 'needs-you', 'failed', 'stopped'] as const;
const state = z.enum(BOT_STATES);
const owner = z.object({ pid: z.number().int().positive(), host: text });
const botSourceSchema = z.object({ kind: z.enum(['manual', 'jira', 'suggestion', 'alert', 'investigation']), id: text, url: text.optional() });
const botEvidenceSchema = z.object({ source: text, summary: text, url: text.optional() });
const authority = z.object({
  service: z.enum(['local', 'opencode', 'git', 'github', 'jira', 'discord']),
  identityId: text, revision: z.union([text, time]), target: text,
});
const effectFields = {
  key: text, kind: text, inputDigest: text, authority, createdAt: time, updatedAt: time,
};
const effectSchema = z.discriminatedUnion('state', [
  z.object({ ...effectFields, state: z.literal('prepared') }),
  z.object({ ...effectFields, state: z.literal('dispatching'), owner }),
  z.object({ ...effectFields, state: z.literal('succeeded'), receipt: z.object({ id: text, url: text.optional(), sha: text.optional(), sessionId: text.optional() }) }),
  z.object({ ...effectFields, state: z.literal('refused'), code: text }),
  z.object({ ...effectFields, state: z.literal('outcome-unknown'), code: text }),
]);

export const botItemSchema = z.object({
  id: text, botId: text, source: botSourceSchema, title: text, description: z.string(),
  state, revision: time, createdAt: time, updatedAt: time, finishedAt: time.optional(), owner: owner.nullable(),
  worktree: text.optional(), branch: text.optional(),
  sessions: z.object({ investigation: text.optional(), fixing: text.optional(), judge: text.optional() }),
  pr: z.object({ number: z.number().int().positive(), url: text, headSha: text, baseSha: text.optional() }).optional(),
  evidence: z.array(botEvidenceSchema),
  proof: z.discriminatedUnion('status', [
    z.object({ status: z.literal('absent'), reason: text }),
    z.object({ status: z.enum(['passed', 'failed', 'inconclusive']), testSha: text, fixSha: text,
      command: text, args: z.array(z.string()), testExitCode: z.number().int().nullable(), fixExitCode: z.number().int().nullable(), reason: text.optional() }),
  ]),
  judgment: z.object({
    decision: z.enum(['auto', 'review', 'ask']), reason: text, headSha: text, baseSha: text, policyFingerprint: text,
    reviewers: z.array(text), questions: z.array(text),
  }).optional(),
  wait: z.object({ reason: text, since: time, channel: z.enum(['ui', 'jira', 'discord', 'github']), people: z.array(text) }).optional(),
  tokens: z.object({ total: time, byStage: z.object({ investigation: time, fixing: time, judge: time }), byDay: z.record(z.string(), time) }),
  transitions: z.array(z.object({ from: state.nullable(), to: state, at: time, revision: time, owner, reason: text })),
  effects: z.array(effectSchema),
});

export type BotItem = z.infer<typeof botItemSchema>;
export type BotState = BotItem['state'];
export type BotEvidence = z.infer<typeof botEvidenceSchema>;
export type BotSource = z.infer<typeof botSourceSchema>;
export const isTerminalBotItem = (item: BotItem): boolean => ['done', 'failed', 'stopped'].includes(item.state);
