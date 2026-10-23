import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const text = z.string().min(1).max(100_000);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = time;
export const BOT_ITEM_STATES = ['queued', 'investigating', 'waiting-answer', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done', 'needs-you', 'failed', 'stopped'];
export const TERMINAL_ITEM_STATES = ['done', 'failed', 'stopped'];
const state = z.enum(BOT_ITEM_STATES);
export const botOwnerSchema = z.object({ pid: z.number().int().positive(), host: text }).strict();
const source = z.object({ kind: z.enum(['manual', 'jira', 'suggestion', 'alert', 'investigation']), id: text, url: text.optional() }).strict();
const evidence = z.object({ source: text, summary: text, url: text.optional() }).strict();
const receipt = z.object({ id: text, url: text.optional(), sha: text.optional(), sessionId: text.optional() }).strict();

// References only. The executor resolves credentials against this captured revision.
export const botEffectAuthoritySchema = z.object({
  service: z.enum(['local', 'opencode', 'git', 'github', 'jira', 'discord']),
  identityId: text, revision: z.union([text, revision]), target: text,
}).strict();
const effectFields = {
  key: text,
  kind: z.enum(['session.create', 'session.prompt', 'worktree.create', 'worktree.remove', 'git.push', 'pr.open', 'pr.comment', 'pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue', 'pr.merge', 'jira.comment', 'jira.question', 'jira.transition', 'discord.send', 'discord.question']),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), authority: botEffectAuthoritySchema,
  createdAt: time, updatedAt: time,
};
export const botEffectSchema = z.discriminatedUnion('state', [
  z.object({ ...effectFields, state: z.literal('prepared') }).strict(),
  z.object({ ...effectFields, state: z.literal('dispatching'), owner: botOwnerSchema }).strict(),
  z.object({ ...effectFields, state: z.literal('succeeded'), receipt }).strict(),
  z.object({ ...effectFields, state: z.literal('refused'), code: text }).strict(),
  z.object({ ...effectFields, state: z.literal('outcome-unknown'), code: text }).strict(),
]);

export const botItemSchema = z.object({
  id: text, botId: text, source, title: text, description: z.string().max(100_000).default(''),
  state, revision, createdAt: time, updatedAt: time, finishedAt: time.optional(),
  owner: botOwnerSchema.nullable().default(null),
  worktree: text.optional(), branch: text.optional(),
  sessions: z.object({ investigation: text.optional(), fixing: text.optional(), judge: text.optional() }).strict().default({}),
  pr: z.object({ number: z.number().int().positive(), url: text, headSha: text, baseSha: text.optional() }).strict().optional(),
  evidence: z.array(evidence).default([]),
  proof: z.discriminatedUnion('status', [
    z.object({ status: z.literal('absent'), reason: text }).strict(),
    z.object({ status: z.enum(['passed', 'failed', 'inconclusive']), testSha: text, fixSha: text,
      command: text, args: z.array(z.string()), testExitCode: z.number().int().nullable(), fixExitCode: z.number().int().nullable(), reason: text.optional() }).strict(),
  ]).default({ status: 'absent', reason: 'Not run' }),
  judgment: z.object({ decision: z.enum(['auto', 'review', 'ask']), reason: text, headSha: text, baseSha: text,
    policyFingerprint: text, reviewers: z.array(text).default([]), questions: z.array(text).default([]) }).strict().optional(),
  wait: z.object({ reason: text, since: time, channel: z.enum(['ui', 'jira', 'discord', 'github']), people: z.array(text).default([]) }).strict().optional(),
  tokens: z.object({ total: time, byStage: z.object({ investigation: time, fixing: time, judge: time }).strict(), byDay: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time) }).strict()
    .default({ total: 0, byStage: { investigation: 0, fixing: 0, judge: 0 }, byDay: {} }),
  transitions: z.array(z.object({ from: state.nullable(), to: state, at: time, revision, owner: botOwnerSchema, reason: text }).strict()).default([]),
  effects: z.array(botEffectSchema).default([]),
}).strict().superRefine((item, ctx) => {
  if (new Set(item.effects.map((effect) => effect.key)).size !== item.effects.length) ctx.addIssue({ code: 'custom', message: 'effect keys must be unique' });
  if (TERMINAL_ITEM_STATES.includes(item.state) && item.finishedAt === undefined) ctx.addIssue({ code: 'custom', message: 'terminal items need finishedAt' });
});

export const createBotItem = ({ id = randomUUID(), botId, source: origin, title, description = '', now = Date.now() }) => botItemSchema.parse({
  id, botId, source: origin, title, description, state: 'queued', revision: 0, createdAt: now, updatedAt: now,
});

const nextStates = {
  queued: ['investigating'], investigating: ['fixing', 'waiting-answer'], 'waiting-answer': ['investigating', 'fixing', 'judging'],
  fixing: ['proving', 'judging', 'in-review', 'waiting-answer'], proving: ['fixing', 'judging', 'in-review'],
  judging: ['fixing', 'in-review', 'merging', 'waiting-answer'], 'in-review': ['fixing', 'judging', 'merging'],
  merging: ['judging', 'in-review', 'closing'], closing: ['done'], 'needs-you': ['queued', 'investigating', 'waiting-answer', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing'],
  failed: [], stopped: [], done: [],
};

export const assertItemTransition = (from, to) => {
  if (from === to) return;
  if (!TERMINAL_ITEM_STATES.includes(from) && ['needs-you', 'failed', 'stopped'].includes(to)) return;
  if (!nextStates[from]?.includes(to)) throw new Error(`Invalid bot item transition ${from} -> ${to}`);
};

export const assertEffectTransition = (previous, next) => {
  if (previous.key !== next.key || previous.kind !== next.kind || previous.inputDigest !== next.inputDigest
    || JSON.stringify(previous.authority) !== JSON.stringify(next.authority) || previous.createdAt !== next.createdAt) throw new Error('Effect authority and input are immutable');
  const allowed = { prepared: ['dispatching', 'refused'], dispatching: ['succeeded', 'refused', 'outcome-unknown'], 'outcome-unknown': ['succeeded', 'refused'], succeeded: [], refused: [] };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  if (!allowed[previous.state].includes(next.state)) throw new Error(`Invalid bot effect transition ${previous.state} -> ${next.state}`);
};
