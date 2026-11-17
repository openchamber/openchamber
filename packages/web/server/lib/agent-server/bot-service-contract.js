import { createHash } from 'node:crypto';
import { z } from 'zod';
import { botDefinitionSchema } from '../bots/config.js';
import { botEffectSchema, botItemSchema, botItemSourceSchema, botItemStateSchema } from '../bots/schema.js';
import { branch, discordTarget, effectSchema, githubTarget, jiraTarget, opaqueId, operations, requestSchema,
  revision, sha, snowflake, text } from '../bots/services/contracts.js';
import { projectDirectorySchema } from './fix-loop-contract.js';
import { checkContextsSchema, failedChecksReplySchema, feedbackReplySchema } from './fix-loop-feedback-contract.js';
import { repositoryPolicyFilesSchema } from '../bots/repository-policy.js';
import { botMigrationPathSchema } from '../spaces/transfer-bundle.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

export const BOT_SERVICE_ROUTE = '/api/openchamber/bot-services';
export const BOT_SERVICE_INPUT_BYTES = 4 * 1024 * 1024;
export const BOT_SERVICE_BYTES = 4 * 1024 * 1024;
export const BOT_SERVICE_TIMEOUT_MS = 30_000;
export const botBoundaryError = (code, status = 502, state = 'needs-you') => Object.assign(new Error(code), { code, status, state });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const body = z.string().max(200_000);
const file = z.string().min(1).max(4096).refine((value) => !value.startsWith('/') && !value.includes('\\')
  && !/[\x00-\x1f\x7f]/.test(value) && value.split('/').every((part) => part !== '..' && part !== ''));
const policyFileSchema = z.string().regex(/^(?:\.agents\/areas\/[^/]+\.md|\.openchamber\/people\.json)$/).max(4096);
const botProjectSchema = z.object({ id: text, path: projectDirectorySchema });
const botStageSchema = z.enum(['investigation', 'fixing', 'judge']);
export const botSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/);
const botSelectionSchema = z.object({ providerID: text, modelID: text, variant: text.optional(), agent: text.optional() });
const itemProjection = z.object({ id: opaqueId, botId: opaqueId, source: botItemSourceSchema,
  title: body.optional(), state: botItemStateSchema.optional(), worktree: projectDirectorySchema.optional(),
  branch: branch.optional(), publicationBranch: branch.optional(), sessions: z.object({ investigation: botSessionIdSchema.optional(),
    fixing: botSessionIdSchema.optional(), judge: botSessionIdSchema.optional() }).default({}),
  pr: z.object({ number: revision, url: z.string().max(4096), headSha: sha, baseSha: sha.optional() }).optional(),
  effects: z.array(botEffectSchema.options[0].pick({ kind: true }).extend({ key: opaqueId,
    state: z.enum(['prepared', 'dispatching', 'succeeded', 'refused', 'outcome-unknown']) }).pick({ key: true, kind: true, state: true }).strip()).max(10_000).default([]) });
export const botScopeSchema = z.object({ project: botProjectSchema, bot: botDefinitionSchema,
  item: itemProjection, checkoutKey: opaqueId.optional(), trustedMigrationPath: botMigrationPathSchema.optional() }).strict()
  .refine((value) => value.bot.id === value.item.botId && (!value.trustedMigrationPath
    || value.trustedMigrationPath.projectId === value.project.id && value.trustedMigrationPath.itemId === value.item.id
      && (!value.item.worktree || value.item.worktree === value.trustedMigrationPath.directory)));
const botCheckoutSchema = z.object({ directory: projectDirectorySchema, branch, baseBranch: branch, baseSha: sha });
const botSnapshotSchema = z.object({ baseSha: sha, headSha: sha, baseBranch: branch, remoteSha: sha.nullable(),
  changes: z.array(z.object({ oldPath: file.optional(), newPath: file.optional() }).refine((value) => value.oldPath || value.newPath)).max(100_000),
  diff: z.string().max(3 * 1024 * 1024), testSha: sha.optional(), fixSha: sha.optional(), testFiles: z.array(file).max(2000).optional() });
const commitMap = z.array(z.object({ sourceSha: sha, publishedSha: sha })).min(1).max(100);
const publication = z.object({ sourceHeadSha: sha, headSha: sha, commitMap });
const publicationReply = z.object({ publicationBranch: branch, localBranch: branch, directory: projectDirectorySchema,
  identityId: opaqueId, identityRevision: revision }).nullable();
const success = z.object({ ok: z.literal(true) });
const empty = z.object({}).strict();
const scoped = z.object({ scope: botScopeSchema }).strict();
const keyed = scoped.extend({ key: opaqueId }).strict();
const unknownOutcome = z.object({ state: z.literal('outcome-unknown') });
const stageReceipt = z.object({ id: botSessionIdSchema, sessionId: botSessionIdSchema });
export const botStageRequestSchema = z.object({ projectId: text, itemId: opaqueId, bot: botDefinitionSchema,
  stage: botStageSchema, directory: projectDirectorySchema, selection: botSelectionSchema,
  prompt: body, dispatchedAt: count, afterIdleId: text.nullable().optional(), sessionId: botSessionIdSchema.optional() });
const stageInput = scoped.extend({ request: botStageRequestSchema }).strict();
const sessionInput = scoped.extend({ sessionId: botSessionIdSchema }).strict();
const stageOutcome = z.discriminatedUnion('state', [
  z.object({ state: z.literal('completed'), text: z.string().max(100_000), errorMessage: body.optional(), tokens: count }),
  z.object({ state: z.enum(['error', 'cancelled']), text: z.string().max(100_000), errorMessage: body.optional(), tokens: count.optional() }),
]);
const botProofReplySchema = z.object({ status: z.enum(['passed', 'failed', 'inconclusive']), testSha: sha, fixSha: sha,
  command: z.string().max(4096), args: z.array(z.string().max(20_000)).max(1000),
  testExitCode: z.number().int().nullable(), fixExitCode: z.number().int().nullable(), reason: body.optional() });
const identityKind = z.enum(['github-account', 'github-app', 'jira-account', 'jira-service', 'jira-oauth', 'discord-app']);
export const botPublicIdentitySchema = z.object({ id: opaqueId, revision, label: text, kind: identityKind, configured: z.literal(true),
  accountId: text.optional(), credentialRevision: revision.optional(), appId: text.optional(), installationId: text.optional(),
  site: text.optional(), email: z.string().max(320).optional(), cloudId: z.string().uuid().optional(),
  clientId: z.string().max(1024).optional(), applicationId: snowflake.optional() });
const secret = z.string().min(1).max(32_768);
const identityDefinition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-account'), label: text, accountId: text, credentialRevision: revision }).strict(),
  z.object({ kind: z.literal('github-app'), label: text, appId: text, installationId: text, privateKey: secret }).strict(),
  z.object({ kind: z.enum(['jira-account', 'jira-service']), label: text, site: text, email: z.string().email().max(320), apiToken: secret }).strict(),
  z.object({ kind: z.literal('jira-oauth'), label: text, site: text, cloudId: z.string().uuid(), clientId: z.string().max(1024), clientSecret: secret }).strict(),
  z.object({ kind: z.literal('discord-app'), label: text, applicationId: snowflake, botToken: secret }).strict(),
]);
const binding = (target) => z.object({ identityId: opaqueId, identityRevision: revision, target });
const githubBinding = binding(githubTarget).extend({ accountId: text.optional(), credentialRevision: revision.optional() });
const botContextReplySchema = z.object({ github: githubBinding.optional(),
  jira: binding(jiraTarget).extend({ expectedStatusId: text.optional() }).optional(), discord: binding(discordTarget).optional() });
export const botWatchAuthoritySchema = z.object({ project: botProjectSchema, botId: opaqueId, itemId: opaqueId,
  identityId: opaqueId, identityRevision: revision, target: githubTarget, publicationBranch: branch.optional() }).strict();
const watch = z.object({ authority: botWatchAuthoritySchema, number: revision, branch,
  headSha: sha.optional(), expectedDirectory: projectDirectorySchema, trustedMigrationPath: botMigrationPathSchema.optional() }).strict();
const stateName = z.object({ id: text, name: text });
const issue = z.object({ id: text, key: text, summary: z.string().max(60_000), status: stateName,
  description: z.string().max(60_000), issueType: stateName.extend({ subtask: z.boolean().optional() }).optional() });

// Provider-owned rule parameters have bounded JSON structure. Everything else has
// a named schema; this is the sole extensible provider field on the wire.
const boundedJson = (depth) => depth === 0 ? z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()])
  : z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null(), z.array(boundedJson(depth - 1)).max(100),
    z.record(z.string().max(256), boundedJson(depth - 1)).refine((value) => Object.keys(value).length <= 100)]);
const rule = z.object({ type: text, parameters: z.record(z.string().max(256), boundedJson(3)).refine((value) => Object.keys(value).length <= 100).optional(),
  ruleset_id: revision.optional(), ruleset_source: text.optional(), ruleset_source_type: z.enum(['Repository', 'Organization', 'Enterprise']).optional(),
  ruleset_enforcement_mode: z.literal('active').optional() });
export const BOT_PROVIDER_READS = {
  'github.branch': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.object({ headSha: sha.nullable() }) },
  'github.rules': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.object({ branch, headSha: sha,
    requiredSignatures: z.boolean(), mergeQueue: z.boolean(), autoMergeAllowed: z.boolean(), ruleTypes: z.array(text).max(100),
    legacyProtection: z.object({ requiresCommitSignatures: z.boolean(), requiresApprovingReviews: z.boolean(),
      requiredApprovingReviewCount: count.nullable(), requiresStatusChecks: z.boolean() }).nullable() }) },
  'github.branch-rules': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.array(rule).max(1000) },
  'github.pull': { target: githubTarget, input: z.object({ number: revision, headSha: sha.optional() }).strict(),
    reply: z.object({ number: revision, head: branch, base: branch, headSha: sha, state: z.enum(['open', 'closed']) }) },
  'github.authorization': { target: githubTarget, input: z.object({ number: revision, branch }).strict(),
    reply: z.object({ number: revision, headSha: sha, baseSha: sha, merged: z.boolean(), autoMerge: z.boolean(), queued: z.boolean() }) },
  'jira.issue': { target: jiraTarget, input: empty, reply: issue },
  'jira.transitions': { target: jiraTarget, input: empty, reply: z.array(z.object({ id: text, name: text, to: stateName })).max(200) },
  'jira.comments': { target: jiraTarget, input: z.object({ startAt: count.optional() }).strict(), reply: z.object({
    comments: z.array(z.object({ id: text, authorId: text, human: z.boolean(), body: z.string().max(60_000), createdAt: text })).max(100),
    total: count, nextStartAt: count.nullable() }) },
  'jira.search': { target: empty, input: z.object({ jql: z.string().min(1).max(4000), nextPageToken: text.optional(),
    maxResults: z.number().int().min(1).max(100).default(50) }).strict(), reply: z.object({ issues: z.array(issue).max(100), nextPageToken: text.nullable() }) },
  'discord.channel': { target: discordTarget, input: empty, reply: z.object({ guildId: z.union([snowflake, z.literal('dm')]), channelId: snowflake }) },
};
const botReadRequestSchema = z.discriminatedUnion('operation', Object.entries(BOT_PROVIDER_READS).map(([operation, contract]) =>
  z.object({ operation: z.literal(operation), identityId: opaqueId, identityRevision: revision, target: contract.target,
    input: contract.input.default({}) }).strict()));
const botPrepareRequestSchema = z.discriminatedUnion('operation', Object.entries(operations).map(([operation, contract]) =>
  requestSchema.extend({ operation: z.literal(operation), target: contract.target, input: contract.input }).strict()));
const effectRequests = Object.fromEntries(Object.entries(operations).map(([operation, contract]) =>
  [operation, effectSchema.extend({ operation: z.literal(operation), target: contract.target }).strict()]));
const botEffectRequestSchema = z.discriminatedUnion('operation', Object.values(effectRequests));
const receipts = {
  'git.push': z.object({ headSha: sha, sourceHeadSha: sha, commitMap: commitMap.optional() }),
  'pr.open': z.object({ number: revision, head: branch, base: branch, headSha: sha }),
  'pr.comment': z.object({ number: revision, headSha: sha, commented: z.literal(true), commentId: revision }),
  'pr.auto-merge': z.object({ number: revision, headSha: sha, status: z.enum(['enqueued', 'pending', 'merged']) }),
  'pr.disable-auto-merge': z.object({ number: revision, headSha: sha, merged: z.boolean() }),
  'pr.dequeue': z.object({ number: revision, headSha: sha, merged: z.boolean() }),
  'jira.comment': z.object({ commentId: text, issueKey: text }),
  'jira.question': z.object({ commentId: text, issueKey: text }),
  'jira.transition': z.object({ issueKey: text, previousStatusId: text.optional(), statusId: text }),
  'discord.send': z.object({ messageId: snowflake, channelId: snowflake }),
  'discord.question': z.object({ messageId: snowflake, channelId: snowflake }),
};
const serviceEffectInput = z.discriminatedUnion('operation', Object.entries(operations).map(([operation, contract]) =>
  z.object({ scope: botScopeSchema, operation: z.literal(operation), effect: effectRequests[operation],
    input: contract.input }).strict()));
const providerReadInput = scoped.extend({ request: botReadRequestSchema }).strict();
const providerReadReply = z.discriminatedUnion('operation', Object.entries(BOT_PROVIDER_READS).map(([operation, contract]) =>
  z.object({ operation: z.literal(operation), value: contract.reply })));
const serviceResult = z.discriminatedUnion('operation', Object.entries(receipts).map(([operation, result]) =>
  effectSchema.pick({ authority: true }).extend({ operation: z.literal(operation), status: z.literal('succeeded'),
    target: operations[operation].target, result, replayed: z.boolean() })
    .pick({ operation: true, status: true, authority: true, target: true, result: true, replayed: true }).strip()));
const reconcileReply = z.union([unknownOutcome, z.object({ state: z.literal('refused'), code: text }),
  ...Object.entries(receipts).map(([operation, result]) => z.object({ state: z.literal('succeeded'), operation: z.literal(operation), result }))]);
const toolInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('item.report'), input: z.object({ evidence: z.array(z.object({ source: text, summary: body, url: z.string().max(4096).optional() })).max(100), critical: z.boolean().optional() }).strict() }),
  z.object({ action: z.literal('item.ask'), input: z.object({ operationId: opaqueId, question: body, people: z.array(text).max(20).optional(), requestedRole: text.optional() }).strict() }),
  ...['git.push', 'pr.open', 'pr.comment', 'jira.comment', 'jira.transition', 'discord.send'].map((action) =>
    z.object({ action: z.literal(action), input: z.object({ operationId: opaqueId, body: body.optional() }).strict() })),
]);
const botToolRequestSchema = z.intersection(z.object({ sessionId: botSessionIdSchema, callId: opaqueId }), toolInput);
const toolReceipt = z.object({ id: text, sha: sha.optional(), url: z.string().max(4096).optional(), sessionId: botSessionIdSchema.optional() }).strict();
const toolItem = botItemSchema.refine((item) => item.effects.length <= 10_000 && item.transitions.length <= 10_000
  && item.evidence.length <= 1000 && Object.keys(item.tokens.byDay).length <= 3660
  && (!item.wait || item.wait.people.length <= 1000)
  && (!item.judgment || item.judgment.reviewers.length <= 100 && item.judgment.questions.length <= 100)
  && (item.proof.status === 'absent' || item.proof.args.length <= 1000 && item.proof.args.every((argument) => argument.length <= 20_000)));
const toolQuestion = z.object({ version: z.literal(1), key: opaqueId, digest: text, since: count, code: text.nullable(),
  input: z.object({ eventId: text, questions: z.array(z.string().min(1).max(20_000)).min(1).max(20),
    people: z.array(text).max(20), requestedRole: text.optional(), resumeState: z.enum(['investigating', 'fixing', 'judging']) }).strict(),
  route: z.object({ service: z.enum(['jira', 'discord']), selection: z.enum(['owners', 'requested', 'role', 'blame']),
    baseSha: sha, headSha: sha, recipients: z.array(z.object({ personId: text, serviceId: text }).strict()).min(1).max(20),
    policyFingerprint: text, binding: z.object({ identityId: opaqueId, identityRevision: revision,
      target: z.union([jiraTarget, discordTarget]), expectedStatusId: text.optional() }).strict(),
    operation: z.enum(['jira.comment', 'discord.send', 'jira.question', 'discord.question']),
    input: z.union([operations['jira.question'].input, operations['discord.question'].input, operations['jira.comment'].input]),
    attribution: z.array(z.object({ sha, github: text, githubId: revision, committedAt: z.iso.datetime(), files: z.array(file).max(20) }).strict()).max(100),
  }).strict().nullable(),
}).strict();
const toolResult = z.union([
  z.object({ receipt: toolReceipt }).strict(),
  z.object({ item: toolItem, question: toolQuestion.optional(), receipt: toolReceipt.optional(), answered: z.boolean().optional() }).strict(),
]);
// Preserve the actual coordinator result contracts, including long item text.
// Only provider rule parameters use bounded extensible JSON on this boundary.
export const botToolReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: toolResult }),
  z.object({ ok: z.literal(false), error: z.object({ code: text, status: z.number().int().min(400).max(599),
    state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']) }) }),
]);
const toolRecord = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), request: botToolRequestSchema });
const memoryTitle = z.object({ title: z.string().max(4096), createdAt: count, updatedAt: count.optional() });
const knowledge = z.object({ notes: z.array(z.object({ body, createdAt: count })).max(256),
  plans: z.array(z.object({ id: text, title: text, body })).max(256),
  memory: z.object({ global: z.array(memoryTitle).max(2000), project: z.array(memoryTitle).max(2000), enabled: z.boolean(), complete: z.boolean() }),
  linking: z.boolean(), naming: z.boolean(), rendering: z.boolean(), secrets: z.boolean(), workflows: z.boolean(),
  directTools: z.boolean(), readAloud: z.boolean(), checkout: z.object({ directory: projectDirectorySchema, branch: z.string().max(1024), placeholder: z.boolean() }).nullable() });
const policyReply = repositoryPolicyFilesSchema;
const association = z.object({ operation: text, digest: z.string().regex(/^[a-f0-9]{64}$/) });
const author = z.object({ login: text, bot: z.boolean() });
export const botGatewayUrlSchema = z.string().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && !url.username && !url.password && !url.port && !url.hash && url.pathname === '/'
      && /^(?:gateway(?:-[a-z0-9-]+)?|[a-z0-9-]+\.gateway)\.discord\.gg$/.test(url.hostname)
      && [...url.searchParams.keys()].every((key) => ['v', 'encoding'].includes(key));
  } catch { return false; }
});
export const botGatewayReadySchema = z.object({ session_id: text, resume_gateway_url: botGatewayUrlSchema,
  user: z.object({ id: snowflake, bot: z.literal(true) }), application: z.object({ id: snowflake }) });
export const botGatewayMessageSchema = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }), content: z.string().max(60_000),
  mentions: z.array(z.object({ id: snowflake })).max(100), message_reference: z.object({ message_id: snowflake.optional() }).optional() });
const gatewayFrameBase = { s: count.nullable().optional(), t: z.string().max(64).nullable().optional() };
export const botDiscordFrameSchema = z.union([
  z.object({ op: z.literal(0), s: count, t: z.literal('READY'), d: botGatewayReadySchema }),
  z.object({ op: z.literal(0), s: count, t: z.literal('MESSAGE_CREATE'), d: botGatewayMessageSchema }),
  z.object({ op: z.literal(0), s: count, t: z.string().max(64).refine((value) => !['READY', 'MESSAGE_CREATE'].includes(value)), d: z.null() }),
  z.object({ ...gatewayFrameBase, op: z.literal(10), d: z.object({ heartbeat_interval: z.number().int().min(100).max(120_000) }) }),
  z.object({ ...gatewayFrameBase, op: z.literal(1), d: count.nullable() }),
  z.object({ ...gatewayFrameBase, op: z.literal(7), d: z.null() }),
  z.object({ ...gatewayFrameBase, op: z.literal(9), d: z.boolean() }),
  z.object({ ...gatewayFrameBase, op: z.literal(11), d: z.null() }),
]);
const gatewayScope = scoped.extend({ connectionId: opaqueId }).strict();
const gatewayCursor = z.object({ sessionId: text, sequence: count, resumeUrl: botGatewayUrlSchema });
const gatewayIdentity = { identityId: opaqueId, identityRevision: revision };
const projectInput = z.object({ project: botProjectSchema }).strict();
export const BOT_SERVICE_OPERATIONS = {
  'identity-list': { input: projectInput, reply: z.array(botPublicIdentitySchema).max(200) },
  'identity-create': { input: projectInput.extend({ definition: identityDefinition }).strict(), reply: botPublicIdentitySchema },
  'identity-update': { input: projectInput.extend({ id: opaqueId, expectedRevision: revision, definition: identityDefinition }).strict(), reply: botPublicIdentitySchema },
  'identity-remove': { input: projectInput.extend({ id: opaqueId, expectedRevision: revision }).strict(), reply: z.object({ removed: z.literal(true) }) },
  repository: { input: z.object({ project: botProjectSchema }).strict(), reply: z.object({ target: githubTarget, remote: text }) },
  'github-binding': { input: z.object({ project: botProjectSchema, bot: botDefinitionSchema.optional(), binding: binding(githubTarget).optional(),
    expectedIdentity: botPublicIdentitySchema, expectedTarget: githubTarget }).strict()
    .refine((value) => value.bot || value.binding), reply: z.object({ binding: githubBinding }) },
  context: { input: scoped.extend({ service: z.enum(['github', 'jira', 'discord']),
    operation: z.enum([...new Set([...Object.keys(operations), ...Object.keys(BOT_PROVIDER_READS), 'github.checkout'])]),
    expectedIdentity: botPublicIdentitySchema.nullable(), expectedTarget: z.union([githubTarget, jiraTarget, discordTarget]).optional(),
    target: discordTarget.optional() }).strict(), reply: botContextReplySchema },
  'policy-files': { input: z.object({ project: botProjectSchema, files: z.array(policyFileSchema).max(256) }).strict(), reply: policyReply },
  defaults: { input: z.object({ project: botProjectSchema }).strict(), reply: botSelectionSchema },
  knowledge: { input: scoped, reply: knowledge },
  'knowledge-sync': { input: sessionInput.extend({ includeMemorySaveRule: z.boolean() }).strict(), reply: success },
  'worktree-create': { input: keyed, reply: botCheckoutSchema },
  'worktree-reconcile': { input: keyed.extend({ operation: z.enum(['create', 'remove']) }).strict(), reply: z.union([unknownOutcome,
    z.object({ state: z.literal('succeeded'), result: z.union([botCheckoutSchema, z.object({ id: opaqueId })]) })]) },
  'worktree-inspect': { input: scoped, reply: botSnapshotSchema },
  'worktree-bind-publication': { input: scoped.extend({ branch }).strict(), reply: z.object({ publicationBranch: branch }) },
  'worktree-read-publication': { input: scoped.extend({ repositoryId: opaqueId }).strict(), reply: publicationReply },
  'worktree-adopt-isolated': { input: scoped.extend({ resultSha: sha, spaceId: z.string().regex(/^[a-f0-9]{12}$/) }).strict(), reply: z.object({ headSha: sha }) },
  'worktree-accept-published': { input: scoped.extend({ snapshot: botSnapshotSchema, result: publication }).strict(), reply: z.object({ headSha: sha }) },
  'worktree-remove': { input: scoped.extend({ key: opaqueId.optional(), checkout: botCheckoutSchema.optional() }).strict(), reply: z.object({ id: opaqueId }) },
  'worktree-same-tree': { input: scoped.extend({ left: sha, right: sha }).strict(), reply: z.object({ same: z.boolean() }) },
  'stage-create': { input: stageInput, reply: z.object({ sessionId: botSessionIdSchema, directory: projectDirectorySchema }) },
  'stage-dispatch': { input: stageInput, reply: stageReceipt },
  'stage-outcome': { input: stageInput, reply: stageOutcome.nullable() },
  'stage-reconcile': { input: stageInput.extend({ kind: z.enum(['session.create', 'session.prompt']), sessionId: botSessionIdSchema.optional() }).strict(),
    reply: z.union([unknownOutcome, z.object({ state: z.literal('succeeded'), result: stageReceipt })]) },
  'stage-stop': { input: sessionInput, reply: success },
  'stage-resume': { input: sessionInput, reply: success },
  session: { input: sessionInput, reply: z.object({ id: botSessionIdSchema, directory: projectDirectorySchema, isolated: z.literal(false),
    archived: z.boolean(), metadata: z.object({ openchamber: z.object({ automation: z.object({ source: z.literal('bot'), projectId: text,
      botId: opaqueId, itemId: opaqueId, stage: botStageSchema }) }) }) }) },
  tokens: { input: sessionInput.extend({ since: count.optional() }).strict(), reply: count.nullable() },
  activity: { input: sessionInput, reply: z.boolean().nullable() },
  proof: { input: scoped.extend({ testSha: sha, fixSha: sha }).strict(), reply: botProofReplySchema },
  'service-prepare': { input: scoped.extend({ request: botPrepareRequestSchema }).strict(), reply: botEffectRequestSchema },
  'service-read': { input: providerReadInput, reply: providerReadReply },
  'service-preflight': { input: serviceEffectInput, reply: success },
  'service-execute': { input: serviceEffectInput, reply: serviceResult },
  'service-reconcile': { input: serviceEffectInput, reply: reconcileReply },
  blame: { input: scoped.extend({ snapshot: botSnapshotSchema }).strict(), reply: z.array(z.object({ sha, github: text, githubId: revision,
    committedAt: text, files: z.array(file).max(20) })).max(100) },
  'pull-status': { input: scoped.extend({ authority: botWatchAuthoritySchema }).strict(), reply: z.object({ open: z.boolean(), status: z.object({ headSha: sha, baseSha: sha, merged: z.boolean(),
    approved: z.boolean(), mergeMode: z.enum(['queue', 'auto-merge']) }) }) },
  'pull-feedback': { input: watch.extend({ mentionText: z.string().min(1).max(100).optional() }).strict(), reply: feedbackReplySchema },
  'pull-author-permission': { input: watch.omit({ number: true, branch: true, headSha: true }).extend({ username: text }).strict(), reply: z.object({ permitted: z.boolean() }) },
  'pull-failed-checks': { input: watch.omit({ number: true, branch: true, headSha: true }).extend({ contexts: checkContextsSchema }).strict(), reply: failedChecksReplySchema },
  'pull-review-app': { input: z.object({ authority: botWatchAuthoritySchema, author,
    selectedApprovedApp: z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), appId: revision }).optional(),
    expectedDirectory: projectDirectorySchema, trustedMigrationPath: botMigrationPathSchema.optional() }).strict(), reply: z.object({ authorized: z.boolean() }) },
  'tools-pull': { input: sessionInput, reply: z.object({ requests: z.array(toolRecord).max(100) }) },
  'tools-settle': { input: sessionInput.extend({ settlement: toolRecord.extend({ reply: botToolReplySchema }) }).strict(), reply: z.object({ settled: z.literal(true) }) },
  'synthetic-deliver': { input: sessionInput.extend({ eventId: opaqueId, messageId: z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/),
    text: body.refine((value) => value.trim().length > 0), description: body.optional() }).strict(), reply: z.object({ messageId: text, sessionId: botSessionIdSchema }) },
  'gateway-open': { input: gatewayScope.extend({ ...gatewayIdentity, cursor: gatewayCursor.nullable() }).strict(),
    reply: z.object({ connectionId: opaqueId, botUserId: snowflake, applicationId: snowflake }) },
  'gateway-pull': { input: gatewayScope.extend({ after: count, observed: count.optional() }).strict()
    .refine((value) => value.observed === undefined || value.observed >= value.after), reply: z.object({ connectionId: opaqueId,
    frames: z.array(z.object({ id: count, frame: botDiscordFrameSchema })).max(16), state: z.enum(['connecting', 'open', 'closed']),
    closeCode: count.nullable(), errorCode: text.optional() }) },
  'gateway-send': { input: gatewayScope.extend({ frame: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('identify') }).strict(),
    z.object({ kind: z.literal('resume'), sessionId: text, sequence: count }).strict(),
    z.object({ kind: z.literal('heartbeat'), sequence: count.nullable() }).strict(),
  ]) }).strict(), reply: success },
  'gateway-close': { input: gatewayScope, reply: success },
};

export const botRequestAssociation = (operation, input) => ({ operation,
  digest: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
export const botReplySchema = (operation) => z.object({ association, result: BOT_SERVICE_OPERATIONS[operation].reply });

/** Matches services.js payloadDigest without changing the persisted descriptor. */
export function botEffectInputDigest(effect, rawInput) {
  const contract = operations[effect.operation];
  const value = { key: effect.key, operation: effect.operation, botId: effect.botId, itemId: effect.itemId,
    authority: effect.authority, target: contract.target.parse(effect.target), input: contract.input.parse(rawInput) };
  if (effect.publicationBranch !== undefined) value.publicationBranch = effect.publicationBranch;
  return digestMutationInput(value);
}

export function assertBotEffectInput(effect, input) {
  if (!Object.hasOwn(operations, effect.operation) || operations[effect.operation].service !== effect.authority.service
    || effect.inputDigest !== botEffectInputDigest(effect, input)) {
    throw botBoundaryError('BOT_EFFECT_CHANGED', 409);
  }
}

/** Both authorities check semantic identity after reconstructing a typed reply. */
export function assertBotServiceReply(operation, input, result) {
  const refuse = () => { throw botBoundaryError('BOT_EXECUTION_UNRELATED_REPLY'); };
  const item = input.scope?.item;
  if (operation === 'identity-update' && (result.id !== input.id || result.revision !== input.expectedRevision + 1)) refuse();
  if (operation === 'identity-create' && result.revision !== 1) refuse();
  const assertBinding = (returned, expectedIdentity, expectedTarget) => {
    if (!returned || !expectedIdentity || returned.identityId !== expectedIdentity.id || returned.identityRevision !== expectedIdentity.revision
      || JSON.stringify(returned.target) !== JSON.stringify(expectedTarget)
      || expectedIdentity.kind === 'github-account' && (returned.accountId !== expectedIdentity.accountId
        || returned.credentialRevision !== expectedIdentity.credentialRevision)) refuse();
  };
  if (operation === 'github-binding') {
    assertBinding(result.binding, input.expectedIdentity, input.expectedTarget);
    if (input.binding && (result.binding.identityId !== input.binding.identityId || result.binding.identityRevision !== input.binding.identityRevision
      || JSON.stringify(result.binding.target) !== JSON.stringify(input.binding.target))) refuse();
  }
  if (operation === 'github-binding' && input.bot?.identity.github?.kind === 'app'
    && result.binding.identityId !== input.bot.identity.github.identityId) refuse();
  if (operation === 'context') {
    if (Object.keys(result).some((key) => key !== input.service)) refuse();
    if (input.expectedTarget) assertBinding(result[input.service], input.expectedIdentity, input.expectedTarget);
    else if (Object.keys(result).length) refuse();
  }
  if (operation === 'worktree-create' && (result.branch !== `bot/${item.id}` || item.worktree && result.directory !== item.worktree)) refuse();
  if (operation === 'worktree-reconcile' && result.state === 'succeeded') {
    if (input.operation === 'remove' ? result.result.id !== item.id
      : result.result.branch !== `bot/${item.id}` || item.worktree && result.result.directory !== item.worktree) refuse();
  }
  if (operation === 'worktree-inspect' && result.fixSha && result.fixSha !== result.headSha) refuse();
  if (operation === 'worktree-bind-publication' && result.publicationBranch !== input.branch) refuse();
  if (operation === 'worktree-adopt-isolated' && result.headSha !== input.resultSha) refuse();
  if (operation === 'worktree-accept-published' && result.headSha !== input.result.headSha) refuse();
  if (operation === 'worktree-remove' && result.id !== item.id) refuse();
  if (operation === 'worktree-read-publication' && result && (result.localBranch !== `bot/${item.id}`
    || item.worktree && result.directory !== item.worktree || item.publicationBranch && result.publicationBranch !== item.publicationBranch)) refuse();
  if (operation === 'stage-create' && result.directory !== input.request.directory) refuse();
  if (['stage-dispatch', 'session', 'synthetic-deliver'].includes(operation)
    && (result.sessionId ?? result.id) !== (input.request?.sessionId ?? input.sessionId)) refuse();
  if (operation === 'session' && (result.directory !== item.worktree || result.metadata.openchamber.automation.projectId !== input.scope.project.id
    || result.metadata.openchamber.automation.botId !== input.scope.bot.id || result.metadata.openchamber.automation.itemId !== item.id)) refuse();
  if (operation === 'proof' && (result.testSha !== input.testSha || result.fixSha !== input.fixSha)) refuse();
  if (operation === 'service-prepare') {
    const requested = input.request;
    if (result.key !== requested.key || result.operation !== requested.operation || result.botId !== requested.botId || result.itemId !== requested.itemId
      || result.authority.identityId !== requested.identityId || result.authority.identityRevision !== requested.identityRevision
      || JSON.stringify(result.target) !== JSON.stringify(requested.target)) refuse();
    assertBotEffectInput(result, requested.input);
  }
  if (operation === 'service-read') {
    if (result.operation !== input.request.operation) refuse();
    const value = result.value; const requested = input.request;
    if (requested.input.number && value.number !== requested.input.number || requested.input.headSha && value.headSha !== requested.input.headSha
      || requested.operation === 'github.rules' && value.branch !== requested.input.branch
      || requested.operation === 'jira.issue' && value.key !== requested.target.issueKey
      || requested.operation === 'discord.channel' && (value.channelId !== requested.target.channelId || value.guildId !== requested.target.guildId)) refuse();
  }
  if (['service-execute', 'service-reconcile'].includes(operation)) {
    const effect = input.effect;
    if (result.operation && result.operation !== effect.operation) refuse();
    if (result.authority && (JSON.stringify(result.authority) !== JSON.stringify(effect.authority)
      || JSON.stringify(result.target) !== JSON.stringify(effect.target))) refuse();
    const receipt = result.result;
    if (receipt) {
      if (input.input.number && receipt.number !== input.input.number || receipt.issueKey && receipt.issueKey !== effect.target.issueKey
        || receipt.channelId && receipt.channelId !== effect.target.channelId) refuse();
      if (effect.operation === 'git.push') {
        if (receipt.sourceHeadSha !== input.input.headSha || receipt.commitMap && (receipt.commitMap.at(-1).sourceSha !== receipt.sourceHeadSha
          || receipt.commitMap.at(-1).publishedSha !== receipt.headSha
          || new Set(receipt.commitMap.map((entry) => entry.sourceSha)).size !== receipt.commitMap.length
          || new Set(receipt.commitMap.map((entry) => entry.publishedSha)).size !== receipt.commitMap.length)
          || receipt.headSha !== receipt.sourceHeadSha && !receipt.commitMap) refuse();
      } else if (input.input.headSha && receipt.headSha !== input.input.headSha) refuse();
      if (effect.operation === 'pr.open' && (receipt.head !== input.input.branch || receipt.base !== input.input.base)) refuse();
    }
  }
  if (operation === 'tools-pull' && result.requests.some((entry) => entry.request.sessionId !== input.sessionId)) refuse();
  if (operation === 'blame' && result.some((entry) => entry.files.some((file) => !input.snapshot.changes.some((change) => change.oldPath === file)))) refuse();
  if (operation === 'pull-feedback' && (result.branch !== input.branch || input.headSha && result.headSha !== input.headSha
    || result.headRepo && (result.headRepo.owner.toLowerCase() !== input.authority.target.owner.toLowerCase()
      || result.headRepo.repo.toLowerCase() !== input.authority.target.repo.toLowerCase()))) refuse();
  if (['gateway-open', 'gateway-pull'].includes(operation) && result.connectionId !== input.connectionId) refuse();
  if (operation === 'gateway-pull' && result.frames.some((entry, index) => entry.id <= (input.observed ?? input.after)
    || index > 0 && entry.id <= result.frames[index - 1].id)) refuse();
}
