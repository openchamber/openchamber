import { z } from 'zod';

export class BotServiceError extends Error {
  constructor(code, message, state = 'needs-you', status = 409) {
    super(message);
    this.name = 'BotServiceError';
    this.code = code;
    this.state = state;
    this.status = status;
  }
}

export const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'Bot service input is invalid.', 'failed', 400);
  return result.data;
};

export const providerResult = (schema, value, written = false) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The provider returned an invalid response.',
    written ? 'outcome-unknown' : 'needs-you', 502);
  return result.data;
};

export const text = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/);
export const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const revision = z.number().int().positive();
export const snowflake = z.string().regex(/^[1-9][0-9]{5,24}$/);
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const branch = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
  .refine((value) => !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')));
const body = z.string().min(1).max(60_000);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const questionFields = { body, policyFingerprint: fingerprint, recipients: z.array(z.object({ personId: text, serviceId: text }).strict()).min(1).max(20)
  .refine((people) => new Set(people.map((person) => person.personId)).size === people.length
    && new Set(people.map((person) => person.serviceId)).size === people.length, 'Question recipients must be distinct') };
const repositoryPart = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
  .refine((value) => value !== '.' && value !== '..' && !value.endsWith('.git'));
export const githubTarget = z.object({ repositoryId: opaqueId, owner: repositoryPart, repo: repositoryPart }).strict();
const jiraProjectKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const jiraTarget = z.object({
  projectKey: jiraProjectKey,
  issueKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*$/),
}).strict().refine((value) => value.issueKey.startsWith(`${value.projectKey}-`));
export const discordTarget = z.object({
  guildId: z.union([snowflake, z.literal('dm')]), channelId: snowflake,
  recipientId: snowflake.optional(),
}).strict().refine((value) => value.guildId === 'dm' ? Boolean(value.recipientId) : !value.recipientId);

export const operations = {
  'git.push': { service: 'github', target: githubTarget, input: z.object({
    directory: text, branch: branch.refine((value) => value.startsWith('bot/')), headSha: sha,
    baseSha: sha, expectedRemoteSha: sha.nullable(), base: branch,
  }).strict() },
  'pr.open': { service: 'github', target: githubTarget, input: z.object({
    branch: branch.refine((value) => value.startsWith('bot/')), base: branch,
    headSha: sha, title: z.string().min(1).max(256), body, draft: z.boolean().default(false),
  }).strict() },
  'pr.comment': { service: 'github', target: githubTarget, input: z.object({
    number: revision, headSha: sha, body,
  }).strict() },
  'pr.auto-merge': { service: 'github', target: githubTarget, input: z.object({
    number: revision, headSha: sha, baseSha: sha.optional(), branch: branch.optional(),
    mode: z.enum(['auto-merge', 'queue']),
    mergeMethod: z.enum(['MERGE', 'SQUASH', 'REBASE']).default('SQUASH'),
  }).strict() },
  'pr.disable-auto-merge': { service: 'github', target: githubTarget, input: z.object({ number: revision, branch }).strict() },
  'pr.dequeue': { service: 'github', target: githubTarget, input: z.object({ number: revision, branch }).strict() },
  'jira.comment': { service: 'jira', target: jiraTarget, input: z.object({ body }).strict() },
  'jira.question': { service: 'jira', target: jiraTarget, input: z.object(questionFields).strict() },
  'jira.transition': { service: 'jira', target: jiraTarget, input: z.object({
    transitionId: z.string().regex(/^[1-9][0-9]*$/), expectedStatusId: z.string().regex(/^[1-9][0-9]*$/),
  }).strict() },
  'discord.send': { service: 'discord', target: discordTarget, input: z.object({
    body: z.string().min(1).max(2_000),
  }).strict() },
  'discord.question': { service: 'discord', target: discordTarget, input: z.object(questionFields).strict()
    .refine(({ recipients }) => recipients.every((person) => snowflake.safeParse(person.serviceId).success), 'Discord users need exact IDs')
    .refine(({ recipients, body }) => recipients.map((person) => `<@${person.serviceId}>`).join(' ').length + 2 + body.length <= 2_000,
      'Question and generated mentions exceed Discord message length') },
};

// The callback reads the current machine policy and the owner's selected route.
// Directory membership alone cannot authorize selecting a different recipient.
export const questionAuthoritySchema = z.object({
  policy: z.object({ fingerprint, people: z.object({ status: z.literal('approved'),
    people: z.array(z.object({ id: text, jira: text.optional(), discord: text.optional() })) }) }),
  question: z.object({ key: opaqueId, route: z.object({ service: z.enum(['jira', 'discord']),
    operation: z.enum(['jira.question', 'discord.question']), policyFingerprint: fingerprint,
    recipients: questionFields.recipients, input: z.object(questionFields).strict(),
    binding: z.object({ identityId: opaqueId, identityRevision: revision, target: z.union([jiraTarget, discordTarget]) }),
  }) }),
});

const operationSchema = z.enum(Object.keys(operations));
export const requestSchema = z.object({
  key: opaqueId, operation: operationSchema, botId: opaqueId, itemId: opaqueId,
  identityId: opaqueId, identityRevision: revision,
  target: z.unknown(), input: z.unknown(),
}).strict();

const authoritySchema = z.object({
  identityId: opaqueId, identityRevision: revision,
  credentialId: text, credentialRevision: revision, providerAccountId: text,
  service: z.enum(['github', 'jira', 'discord']), origin: z.url(),
}).strict();
export const effectSchema = z.object({
  key: opaqueId, operation: operationSchema, botId: opaqueId, itemId: opaqueId,
  authority: authoritySchema, target: z.unknown(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function jiraOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'A Jira Cloud site is required.', 'failed', 400); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname)) {
    throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'A Jira Cloud site is required.', 'failed', 400);
  }
  return url.origin;
}
