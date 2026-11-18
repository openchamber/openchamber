import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isFunction, isPrimitiveString } from '../shared/guards.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { sha } from './services/contracts.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { createBotStageSessions } from './stage-sessions.js';
import { createBotProofRunner } from './proof.js';
import { createBotQuestionBlame } from './questions-blame.js';
import { createBotIsolatedToolInbox } from './isolated-tools.js';
import { createBotAgentGatewayTransport } from './agent-gateway-transport.js';
import { createBotAdapterState } from './adapter-state.js';
import * as repositoryPolicy from './repository-policy.js';
import { botGit } from './production-git.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { readPullFeedback, readFeedbackAuthorPermission, readFailedChecks } from '../github/pr-feedback.js';
import { registeredTransferDirectory } from '../agent-server/space-transfer-routes.js';
import { botMigrationPathSchema, transferSourceSchema } from '../spaces/transfer-bundle.js';
import { fitFeedback } from '../agent-server/fix-loop-feedback-contract.js';
import { BOT_SERVICE_BYTES, BOT_SERVICE_OPERATIONS, assertBotEffectInput, assertBotServiceReply, botBoundaryError,
  botPublicIdentitySchema, botStageRequestSchema, botScopeSchema, botSessionIdSchema } from '../agent-server/bot-service-contract.js';

const fail = (code = 'BOT_EXECUTION_SCOPE_MISMATCH') => { throw botBoundaryError(code, 409); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ok = () => ({ ok: true });
const outcomeUnknown = () => ({ state: 'outcome-unknown' });
const stageRecordSchema = z.object({ scope: botScopeSchema, request: botStageRequestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['allocating', 'created', 'dispatching', 'dispatched']), sessionId: botSessionIdSchema.optional() }).strict();
const sessionInfo = z.object({ id: botSessionIdSchema, location: z.object({ directory: z.string() }),
  time: z.object({ archived: z.number().nullish() }).optional(), metadata: z.object({ openchamber: z.object({
    automation: z.object({ source: z.literal('bot'), projectId: z.string(), botId: z.string(), itemId: z.string(),
      stage: z.enum(['investigation', 'fixing', 'judge']) }) }) }) });
const tailPage = z.object({ data: z.array(z.object({ type: z.string(),
  time: z.object({ completed: z.number().nullish(), created: z.number().optional() }).optional() })).max(100) });

/** Agent account execution only. The owner drives every operation and lifecycle. */
export function createBotExecutionServices(deps) {
  const { agentServer, dataDir, readSettings, clientFor, sessionService = deps.openChamberSessionService, readOnlySessionService = sessionService,
    permissionAutoAcceptRuntime, sessionKnowledgeRuntime, readSessionDefaults, updateMetadata,
    buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, policyOptions, disposeInstance, reviewApps = [] } = deps;
  if (agentServer !== true) throw new TypeError('Bot execution requires separated authenticated agent-server mode');
  if (!dataDir || !isFunction(readSettings)) throw new TypeError('Bot execution requires its private data directory and project registry');
  const identities = deps.identities ?? createBotIdentityStore({ dataDir });
  const serviceOptions = { dataDir, identities, fetchImpl, policyOptions, ownerAuthorityChecked: true,
    runtimeIdentity: deps.runtimeIdentity ?? { id: `bot-agent-${randomUUID()}`, platform: process.platform } };
  const createServices = deps.createServices ?? createBotServices;
  // This owner supplies provider reads used by context resolution only. Content
  // execution receives a separate publication resolver captured per request.
  const contextServices = deps.services ?? createServices({ ...serviceOptions,
    resolvePublication: async () => fail('BOT_EXECUTION_SCOPE_REQUIRED') });
  const context = deps.context ?? createBotServiceContext({ identities, services: contextServices, fetchImpl, policyOptions });
  const activity = deps.activity ?? createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const readTokens = deps.readTokens ?? createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const proof = deps.proof ?? createBotProofRunner({ root: path.join(dataDir, 'bots', 'proof') });
  const gateway = deps.gateway ?? createBotAgentGatewayTransport({ identities, fetchImpl, policyOptions });
  const blame = deps.blame ?? createBotQuestionBlame({ context });
  const runs = createBotAdapterState({ dataDir, name: 'agent-stage-executions', schema: stageRecordSchema });
  const inbox = deps.inbox ?? createBotIsolatedToolInbox({ dataDir, onPending: async ({ sessionId, requestId }) => {
    if (!updateMetadata) fail('BOT_EXECUTION_METADATA_UNAVAILABLE');
    await updateMetadata(sessionId, { openchamber: { botToolPending: requestId } });
  } });
  // Per-request owners receive the captured item. They never read a second Bot
  // coordinator store on the agent or call back into the owner account.
  const worktreesFor = (scope) => deps.worktrees ?? createProductionBotWorktrees({ dataDir, context, disposeInstance,
    readItem: async (projectId, itemId) => projectId === scope.project.id && itemId === scope.item.id ? scope.item : null });
  const resolvePublicationFor = (scope) => async (query) => {
    if (query.botId !== scope.bot.id || query.itemId !== scope.item.id) fail('BOT_EXECUTION_SCOPE_MISMATCH');
    const request = { ...query };
    if (scope.trustedMigrationPath) request.trustedMigrationPath = scope.trustedMigrationPath;
    const result = await worktreesFor(scope).readPublication(request);
    if (result && scope.item.worktree && result.directory !== scope.item.worktree) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return result;
  };
  const servicesFor = (scope) => deps.services ?? createServices({ ...serviceOptions, resolvePublication: resolvePublicationFor(scope) });
  const prFor = (scope, selectedApps = reviewApps) => deps.pullRequests && selectedApps === reviewApps ? deps.pullRequests
    : (deps.createPullRequests ?? createProductionBotPullRequests)({ context, services: servicesFor(scope), reviewApps: selectedApps,
      resolvePublication: resolvePublicationFor(scope), getFixLoopRuntime: () => ({ createBotWatch: async () => null }),
      receiveFeedback: async () => fail('BOT_EXECUTION_OWNER_REQUIRED') });
  const isolated = Object.fromEntries(['create', 'dispatch', 'outcome', 'reconcile', 'stop'].map((operation) =>
    [operation, async () => fail('BOT_EXECUTION_HOST_STAGE_REQUIRED')]));
  const stageOwners = Object.fromEntries(['investigation', 'fixing', 'judge'].map((stage) => [stage, deps.stages ?? createBotStageSessions({ sessionService: {
    create: (...args) => sessionService.create(...args),
    send: (sessionId, payload) => (stage === 'fixing' ? sessionService : readOnlySessionService).send(sessionId, payload),
  }, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe: activity,
  readSessionDefaults, readTokenSnapshot: readTokens, isolated })]));
  const registeredProject = async (project) => {
    const settings = await readSettings();
    const directory = await registeredTransferDirectory(project.path, async () => settings);
    const projects = deps.listProjects ? await deps.listProjects() : settings.projects ?? [];
    const matches = projects.filter((entry) => entry.id === project.id);
    if (matches.length !== 1 || await registeredTransferDirectory(matches[0].path, async () => settings) !== directory) {
      throw botBoundaryError('agent_project_unregistered', 403);
    }
    // Registration establishes equality; captured descriptor paths remain intact.
    return project;
  };
  const trustRetainedCheckout = async (scope, allowMissingCheckout = false) => {
    if (scope.trustedMigrationPath && deps.trustMigrationPath) await deps.trustMigrationPath(scope.trustedMigrationPath,
      { allowMissingCheckout });
    return scope;
  };
  const registeredScope = async (scope, allowMissingCheckout) => trustRetainedCheckout({ ...scope, project: await registeredProject(scope.project) }, allowMissingCheckout);
  const requestFor = (scope) => {
    const request = { project: scope.project, bot: scope.bot, item: scope.item, key: scope.checkoutKey };
    if (scope.trustedMigrationPath) request.trustedMigrationPath = scope.trustedMigrationPath;
    return request;
  };
  const checkout = async (scope) => {
    if (!scope.checkoutKey || scope.checkoutKey !== `${scope.item.id}:worktree`) fail('BOT_EXECUTION_CHECKOUT_KEY_REQUIRED');
    const directory = await worktreesFor(scope).resolveTransferSource({ kind: 'bot-checkout', projectDirectory: scope.project.path,
      projectId: scope.project.id, botId: scope.bot.id, itemId: scope.item.id, checkoutKey: scope.checkoutKey },
    { trustedMigrationPath: scope.trustedMigrationPath });
    if (!isPrimitiveString(directory) || scope.item.worktree && directory !== scope.item.worktree
      || scope.item.branch && scope.item.branch !== `bot/${scope.item.id}`) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return { directory, branch: `bot/${scope.item.id}` };
  };
  const stageDirectory = async (scope, request) => {
    if (request.projectId !== scope.project.id || request.itemId !== scope.item.id || request.bot.id !== scope.bot.id
      || request.bot.isolated || !same(request.bot, scope.bot)) fail('BOT_EXECUTION_HOST_STAGE_REQUIRED');
    const directory = scope.item.id.startsWith('discovery_') ? scope.project.path : (await checkout(scope)).directory;
    if (request.directory !== directory && request.directory !== scope.project.path
      || !scope.item.id.startsWith('discovery_') && request.directory !== directory) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return directory;
  };
  const verifySession = async (scope, sessionId, expectedStage) => {
    const directory = scope.item.id.startsWith('discovery_') ? scope.project.path : (await checkout(scope)).directory;
    if (!scope.item.id.startsWith('discovery_') && !Object.values(scope.item.sessions).includes(sessionId)) fail('BOT_EXECUTION_SESSION_MISMATCH');
    const info = sessionInfo.parse(unwrapOpenCodeResponse(await clientFor(directory).session.get({ sessionID: sessionId })));
    const marker = info.metadata.openchamber.automation;
    if (info.id !== sessionId || info.location.directory !== directory || marker.projectId !== scope.project.id
      || marker.botId !== scope.bot.id || marker.itemId !== scope.item.id || expectedStage && marker.stage !== expectedStage) fail('BOT_EXECUTION_SESSION_MISMATCH');
    return { info, directory, marker };
  };
  const runIdentity = (scope, request) => ({ projectId: scope.project.id, botId: scope.bot.id,
    itemId: scope.item.id, stage: request.stage, dispatchedAt: request.dispatchedAt });
  const runDigest = (request) => {
    const { sessionId: _sessionId, ...capture } = request;
    return digestMutationInput(capture);
  };
  const assertRun = (record, request) => {
    if (!record || record.digest !== runDigest(request) || request.sessionId && record.sessionId !== request.sessionId) fail('BOT_EXECUTION_STAGE_CHANGED');
  };
  const verifySelectedService = async (scope, value, operation, input) => {
    const service = operation.split('.')[0] === 'git' || operation.startsWith('pr.') ? 'github' : operation.split('.')[0];
    if (value.botId !== undefined && (value.botId !== scope.bot.id || value.itemId !== scope.item.id)) fail();
    const identity = value.authority ?? value;
    const selected = scope.bot.identity[service];
    if (!selected && !value.authority) fail('BOT_IDENTITY_REQUIRED');
    const inventory = await identities.list();
    // Prepared effects retain their originally selected identity even when a
    // later Bot edit changes defaults. Preparation and ordinary reads still
    // resolve the current explicit selection supplied by the owner.
    const matches = value.authority ? inventory.filter((entry) => entry.id === identity.identityId)
      : service === 'github' && selected.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
      : inventory.filter((entry) => entry.id === selected.identityId);
    if (matches.length !== 1 || matches[0].id !== identity.identityId || matches[0].revision !== identity.identityRevision
      || !matches[0].kind.startsWith(`${service}-`)
      || value.authority && (value.authority.credentialId !== (matches[0].kind === 'github-account' ? matches[0].accountId : matches[0].id)
        || value.authority.credentialRevision !== (matches[0].kind === 'github-account' ? matches[0].credentialRevision : matches[0].revision))) fail('BOT_IDENTITY_CHANGED');
    if (service === 'github') {
      if (!same((await context.repository(scope.project)).target, value.target)) fail('BOT_DESTINATION_CHANGED');
      if (operation === 'git.push' && input.directory !== (await checkout(scope)).directory) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    }
    if (service === 'jira' && operation !== 'jira.search' && (scope.item.source.kind !== 'jira' || value.target.issueKey !== scope.item.source.id)) fail('BOT_DESTINATION_CHANGED');
    // The owner validates current approved people and question selection. The
    // agent still checks the captured Discord identity and exact channel via
    // the existing provider adapter on each operation.
  };
  const watchScope = (authority, trustedMigrationPath, expectedDirectory) => {
    if (trustedMigrationPath && (trustedMigrationPath.projectId !== authority.project.id || trustedMigrationPath.itemId !== authority.itemId
      || expectedDirectory && trustedMigrationPath.directory !== expectedDirectory)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    const item = { id: authority.itemId, botId: authority.botId };
    if (expectedDirectory) item.worktree = expectedDirectory;
    return { project: authority.project, bot: { id: authority.botId }, checkoutKey: `${authority.itemId}:worktree`,
      item, trustedMigrationPath };
  };
  const watchReader = async (authority, trustedMigrationPath, expectedDirectory) => {
    await registeredProject(authority.project);
    const scope = await trustRetainedCheckout(watchScope(authority, trustedMigrationPath, expectedDirectory));
    await checkout(scope);
    return prFor(scope).botWatch.getOctokit(authority);
  };
  const expectedIdentity = async (expected, bot, service) => {
    if (!expected) {
      if (bot?.identity?.[service]) fail('BOT_IDENTITY_CHANGED');
      return null;
    }
    const inventory = (await identities.list()).map((entry) => botPublicIdentitySchema.parse(entry));
    const selected = bot?.identity?.[service];
    const matches = bot ? service === 'github' && selected?.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
      : inventory.filter((entry) => entry.id === selected?.identityId)
      : inventory.filter((entry) => entry.id === expected.id);
    if (matches.length !== 1 || !same(matches[0], expected) || !matches[0].kind.startsWith(`${service}-`)
      || bot && service === 'github' && (selected?.kind === 'app') !== (matches[0].kind === 'github-app')) fail('BOT_IDENTITY_CHANGED');
    return matches[0];
  };
  const withAccountRevision = (binding, identity) => {
    const result = { ...binding };
    if (identity?.kind === 'github-account') {
      result.accountId = identity.accountId;
      result.credentialRevision = identity.credentialRevision;
    }
    return result;
  };
  let stopping = false;
  let shutdown = null;
  const activeProofs = new Map();
  const cleanupTimeoutMs = deps.proofCleanupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) throw new TypeError('Proof cleanup needs a bounded deadline');
  const isWorking = async (scope, sessionId) => {
    const { directory } = await verifySession(scope, sessionId);
    const statuses = await activity.fetchActiveSessionStatuses();
    if (statuses === null) return null;
    if (statuses[sessionId]) return true;
    const descendants = await activity.hasWorkingDescendants(sessionId, statuses);
    if (descendants !== false) return descendants;
    const tail = tailPage.safeParse(await clientFor(directory).message.list({ sessionID: sessionId, limit: 10, order: 'desc' }));
    if (!tail.success) return null;
    return tail.data.data[0]?.type === 'assistant' && tail.data.data[0].time?.completed == null;
  };
  const perform = async (operation, raw, { signal } = {}) => {
    const contract = BOT_SERVICE_OPERATIONS[operation];
    const parsed = contract?.input.safeParse(raw);
    if (!parsed?.success) throw botBoundaryError('BOT_EXECUTION_INVALID_REQUEST', 400, 'failed');
    const captured = parsed.data;
    const allowMissingCheckout = operation === 'worktree-remove' || operation === 'worktree-read-publication'
      || operation === 'worktree-reconcile' && captured.operation === 'remove';
    const input = captured.scope ? { ...captured, scope: await registeredScope(captured.scope, allowMissingCheckout) }
      : captured.project ? { ...captured, project: await registeredProject(captured.project) } : captured;
    if (captured.authority) {
      await registeredProject(captured.authority.project);
      watchScope(captured.authority, captured.trustedMigrationPath, captured.expectedDirectory);
    }
    const scope = input.scope;
    const request = scope && requestFor(scope);
    let result;
    switch (operation) {
      case 'identity-list': result = await identities.list(); break;
      case 'identity-create': result = await identities.create(input.definition); break;
      case 'identity-update': result = await identities.update(input.id, input.expectedRevision, input.definition); break;
      case 'identity-remove': result = await identities.remove(input.id, input.expectedRevision); break;
      case 'gateway-open': result = await gateway.open(input, { signal }); break;
      case 'gateway-pull': result = await gateway.pull(input, { signal }); break;
      case 'gateway-send': result = await gateway.send(input); break;
      case 'gateway-close': result = await gateway.close(input); break;
      case 'repository': result = await context.repository(await registeredProject(input.project)); break;
      case 'github-binding': {
        const identity = await expectedIdentity(input.expectedIdentity, input.bot, 'github');
        const { binding } = await context.github({ project: input.project, bot: input.bot, binding: input.binding });
        result = { binding: withAccountRevision(binding, identity) }; break;
      }
      case 'context': {
        const operationService = input.operation.startsWith('git.') || input.operation.startsWith('pr.') ? 'github' : input.operation.split('.')[0];
        if (operationService !== input.service) fail('BOT_SERVICE_UNSUPPORTED');
        const identity = await expectedIdentity(input.expectedIdentity, scope.bot, input.service);
        if (input.service !== 'discord') {
          const resolved = await context.serviceContext({ ...request, service: input.service, operation: input.operation });
          result = resolved[input.service] ? { [input.service]: withAccountRevision(resolved[input.service], identity) } : {};
        }
        else {
          const target = input.target ?? (scope.bot.discord.channels.length === 1 ? scope.bot.discord.channels[0] : null);
          if (!target) fail('BOT_DISCORD_DESTINATION_REQUIRED');
          if (!identity) fail('BOT_IDENTITY_REQUIRED');
          const binding = { identityId: identity.id, identityRevision: identity.revision, target };
          await servicesFor(scope).read({ ...binding, operation: 'discord.channel' }); result = { discord: binding };
        }
        break;
      }
      case 'policy-files': result = await (deps.readPolicyFiles ?? repositoryPolicy.readRepositoryPolicyFiles)((await registeredProject(input.project)).path, { files: input.files }); break;
      case 'defaults': result = await readSessionDefaults((await registeredProject(input.project)).id); break;
      case 'knowledge': result = await sessionKnowledgeRuntime.collect(scope.item.worktree ? (await checkout(scope)).directory : scope.project.path); break;
      case 'knowledge-sync': {
        const { directory } = await verifySession(scope, input.sessionId);
        await sessionKnowledgeRuntime.sync(input.sessionId, directory, { includeMemorySaveRule: input.includeMemorySaveRule }); result = ok(); break;
      }
      case 'worktree-create':
        if (input.key !== scope.checkoutKey) fail('BOT_EXECUTION_CHECKOUT_KEY_REQUIRED');
        result = await worktreesFor(scope).create({ ...request, key: input.key }); break;
      case 'worktree-reconcile': result = await worktreesFor(scope).reconcile({ ...request, key: scope.checkoutKey, operation: input.operation }); break;
      case 'worktree-inspect': await checkout(scope); result = await worktreesFor(scope).inspect(request); break;
      case 'worktree-bind-publication': await checkout(scope); result = await worktreesFor(scope).bindPublication({ ...request, branch: input.branch }); break;
      case 'worktree-read-publication': {
        if ((await context.repository(scope.project)).target.repositoryId !== input.repositoryId) fail('BOT_DESTINATION_CHANGED');
        result = await resolvePublicationFor(scope)({ repositoryId: input.repositoryId, botId: scope.bot.id, itemId: scope.item.id }); break;
      }
      case 'worktree-adopt-isolated': {
        // The checkout owner validates the exact source/Space metadata and also
        // resumes an already journaled adoption. Requiring ready here would
        // prevent that recovery or reject a retained migrated checkout path.
        result = await worktreesFor(scope).adoptIsolated({ ...request, resultSha: input.resultSha, spaceId: input.spaceId }); break;
      }
      case 'worktree-accept-published': await checkout(scope); result = await worktreesFor(scope).acceptPublished({ ...request, snapshot: input.snapshot, result: input.result }); break;
      case 'worktree-remove': result = await worktreesFor(scope).remove({ ...request, key: scope.checkoutKey, checkout: input.checkout }); break;
      case 'worktree-same-tree': {
        const owned = await checkout(scope);
        const tree = async (commit) => sha.parse((await botGit(owned.directory, ['rev-parse', `${commit}^{tree}`])).trim());
        result = { same: await tree(input.left) === await tree(input.right) }; break;
      }
      case 'stage-create': {
        await stageDirectory(scope, input.request);
        const key = runIdentity(scope, input.request);
        result = await runs.own(key, async () => {
          const previous = await runs.read(key);
          if (previous) {
            assertRun(previous, input.request);
            if (!previous.sessionId) fail('BOT_EXECUTION_ALLOCATION_UNKNOWN');
            return { sessionId: previous.sessionId, directory: input.request.directory };
          }
          const record = { scope, request: input.request, digest: runDigest(input.request), state: 'allocating' };
          await runs.write(key, record);
          return stageOwners[input.request.stage].create(input.request, async (created) => {
            if (created.directory !== input.request.directory) fail('BOT_EXECUTION_SESSION_MISMATCH');
            await runs.write(key, { ...record, state: 'created', sessionId: created.sessionId });
          });
        }); break;
      }
      case 'stage-dispatch': {
        await stageDirectory(scope, input.request);
        await verifySession(scope, input.request.sessionId, input.request.stage);
        const key = runIdentity(scope, input.request);
        result = await runs.own(key, async () => {
          const record = await runs.read(key); assertRun(record, input.request);
          if (record.state === 'dispatched') return { id: record.sessionId, sessionId: record.sessionId };
          if (record.state !== 'created') fail('BOT_EXECUTION_DISPATCH_UNKNOWN');
          await runs.write(key, { ...record, state: 'dispatching' });
          const receipt = await stageOwners[input.request.stage].dispatch(input.request);
          await runs.write(key, { ...record, state: 'dispatched' });
          return receipt;
        }); break;
      }
      case 'stage-outcome':
        await stageDirectory(scope, input.request); await verifySession(scope, input.request.sessionId, input.request.stage);
        {
          const record = await runs.read(runIdentity(scope, input.request));
          if (record) assertRun(record, input.request);
        }
        result = await stageOwners[input.request.stage].outcome(input.request); break;
      case 'stage-reconcile': {
        await stageDirectory(scope, input.request);
        const record = await runs.read(runIdentity(scope, input.request));
        if (record) assertRun(record, input.request);
        const sessionId = input.sessionId ?? record?.sessionId ?? input.request.sessionId;
        if (!sessionId) { result = outcomeUnknown(); break; }
        // Owner journal is the session authority when an allocation reply was
        // lost. Its immutable metadata proves the exact project/item/stage.
        const sessionScope = { ...scope, item: { ...scope.item, sessions: { ...scope.item.sessions, [input.request.stage]: sessionId } } };
        await verifySession(sessionScope, sessionId, input.request.stage);
        if (input.kind === 'session.create' && (!record || !record.sessionId)) {
          const key = runIdentity(scope, input.request);
          await runs.own(key, async () => {
            const current = await runs.read(key);
            if (current) assertRun(current, input.request);
            if (!current?.sessionId) await runs.write(key, { scope, request: input.request, digest: runDigest(input.request), state: 'created', sessionId });
          });
        }
        result = input.kind === 'session.create' ? { state: 'succeeded', result: { id: sessionId, sessionId } }
          : await stageOwners[input.request.stage].reconcile(input.kind, { ...input.request, sessionId }, sessionId); break;
      }
      case 'stage-stop': {
        const { directory } = await verifySession(scope, input.sessionId);
        await clientFor(directory).session.interrupt({ sessionID: input.sessionId });
        const statuses = await activity.fetchActiveSessionStatuses();
        if (statuses === null || statuses[input.sessionId]
          || await activity.hasWorkingDescendants(input.sessionId, statuses) !== false) fail('BOT_EXECUTION_SESSION_NOT_STOPPED');
        result = ok(); break;
      }
      case 'stage-resume': await verifySession(scope, input.sessionId); result = ok(); break;
      case 'session': {
        const { info, directory } = await verifySession(scope, input.sessionId);
        result = { id: info.id, directory, isolated: false, archived: Boolean(info.time?.archived)
          || Boolean(await deps.isSessionArchived?.(info.id)), metadata: info.metadata }; break;
      }
      case 'tokens': {
        const { directory } = await verifySession(scope, input.sessionId);
        result = await readTokens(input.sessionId, directory, { since: input.since ?? 0 }); break;
      }
      case 'activity': result = await isWorking(scope, input.sessionId); break;
      case 'proof': {
        const owned = await checkout(scope);
        if (!scope.bot.proof || scope.bot.isolated) fail('BOT_EXECUTION_HOST_PROOF_REQUIRED');
        if (!scope.item.sessions.fixing) fail('BOT_EXECUTION_SESSION_MISMATCH');
        await verifySession(scope, scope.item.sessions.fixing, 'fixing');
        result = await proof.run({ directory: owned.directory, testSha: input.testSha, fixSha: input.fixSha,
          command: scope.bot.proof.command, args: scope.bot.proof.args, isolated: false }, { signal }); break;
      }
      case 'service-prepare':
        await verifySelectedService(scope, input.request, input.request.operation, input.request.input);
        result = await servicesFor(scope).prepare(input.request); break;
      case 'service-read':
        await verifySelectedService(scope, input.request, input.request.operation, input.request.input);
        result = { operation: input.request.operation, value: await servicesFor(scope).read(input.request) }; break;
      case 'service-preflight': case 'service-execute': case 'service-reconcile': {
        if (input.operation !== input.effect.operation) fail('BOT_EFFECT_CHANGED');
        assertBotEffectInput(input.effect, input.input);
        await verifySelectedService(scope, input.effect, input.operation, input.input);
        const services = servicesFor(scope);
        if (operation === 'service-preflight') { await services.preflight(input.effect, input.input); result = ok(); }
        else if (operation === 'service-execute') result = await services.execute(input.effect, input.input);
        else {
          result = await services.reconcile(input.effect, input.input);
          if (result.state === 'succeeded') result = { ...result, operation: input.operation };
        }
        break;
      }
      case 'blame': await checkout(scope); result = await blame({ ...request, snapshot: input.snapshot }); break;
      case 'pull-status': {
        await checkout(scope);
        const binding = (await context.github(request)).binding;
        if (input.authority.project.id !== scope.project.id || input.authority.botId !== scope.bot.id || input.authority.itemId !== scope.item.id
          || !same(binding, { identityId: input.authority.identityId, identityRevision: input.authority.identityRevision, target: input.authority.target })
          || input.authority.publicationBranch !== scope.item.publicationBranch) fail('BOT_GITHUB_PULL_CHANGED');
        const status = await prFor(scope).pullRequests.read(request);
        const pull = await servicesFor(scope).read({ ...binding, operation: 'github.pull', input: { number: scope.item.pr.number, headSha: status.headSha } });
        result = { open: pull.state === 'open', status }; break;
      }
      case 'pull-feedback': {
        const snapshot = await (deps.readFeedback ?? readPullFeedback)({ octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory),
          owner: input.authority.target.owner, repo: input.authority.target.repo, number: input.number });
        result = fitFeedback(snapshot, { mentionText: input.mentionText, cap: BOT_SERVICE_BYTES - 1024 });
        if (!result) throw botBoundaryError('BOT_EXECUTION_RESPONSE_TOO_LARGE'); break;
      }
      case 'pull-author-permission': result = { permitted: await (deps.readAuthorPermission ?? readFeedbackAuthorPermission)({
        octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory), owner: input.authority.target.owner, repo: input.authority.target.repo, username: input.username }) }; break;
      case 'pull-failed-checks': result = await (deps.readFailedChecks ?? readFailedChecks)({ octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory),
        owner: input.authority.target.owner, repo: input.authority.target.repo, contexts: input.contexts }); break;
      case 'pull-review-app': {
        const scope = await trustRetainedCheckout(watchScope(input.authority, input.trustedMigrationPath, input.expectedDirectory)); await checkout(scope);
        const verifier = prFor(scope, input.selectedApprovedApp ? [input.selectedApprovedApp] : reviewApps).botWatch;
        result = { authorized: await verifier.authorizeApp(input.authority, input.author) }; break;
      }
      case 'tools-pull': await verifySession(scope, input.sessionId, 'fixing'); result = await inbox.pending(input.sessionId); break;
      case 'tools-settle':
        await verifySession(scope, input.sessionId, 'fixing');
        if (input.settlement.request.sessionId !== input.sessionId) fail('BOT_EXECUTION_SESSION_MISMATCH');
        result = await inbox.settle(input.settlement); break;
      case 'synthetic-deliver': {
        const { directory, info } = await verifySession(scope, input.sessionId);
        if (info.time?.archived || await deps.isSessionArchived?.(info.id)) fail('BOT_EXECUTION_SESSION_ARCHIVED');
        const notice = { source: 'openchamber-notice', kind: 'bot', projectId: scope.project.id, itemId: scope.item.id, eventId: input.eventId };
        if (botNoticeIds(notice).messageId !== input.messageId) fail('BOT_NOTICE_TARGET_CHANGED');
        try { await clientFor(directory).session.synthetic({ sessionID: input.sessionId, id: input.messageId, text: input.text,
          description: input.description ?? input.text, metadata: notice, delivery: 'steer', resume: true }); }
        catch (error) { if (error?.status !== 409) throw error; }
        result = { messageId: input.messageId, sessionId: input.sessionId }; break;
      }
      default: throw botBoundaryError('BOT_EXECUTION_INVALID_REQUEST', 400, 'failed');
    }
    const reply = contract.reply.safeParse(result);
    if (!reply.success) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
    assertBotServiceReply(operation, captured, reply.data);
    return reply.data;
  };
  const execute = (operation, raw, { signal } = {}) => {
    if (stopping) return Promise.reject(botBoundaryError('BOT_EXECUTION_STOPPED', 503));
    if (operation !== 'proof') return perform(operation, raw, { signal });
    const controller = new AbortController();
    const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const running = perform(operation, raw, { signal: cancellation });
    activeProofs.set(controller, running);
    void running.then(() => activeProofs.delete(controller), () => activeProofs.delete(controller));
    return running;
  };
  const resolveTransferSource = async (value, { trustedMigrationPath } = {}) => {
    if (stopping) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    const source = transferSourceSchema.parse(value);
    if (source.kind !== 'bot-checkout') fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    const project = await registeredProject({ id: source.projectId, path: source.projectDirectory });
    const captured = trustedMigrationPath === undefined ? undefined : botMigrationPathSchema.parse(trustedMigrationPath);
    if (captured && (captured.projectId !== source.projectId || captured.itemId !== source.itemId)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    // A transfer has the owner's immutable source tuple, never its coordinator
    // journal. The private checkout record supplies path, inode and ref authority.
    const scope = await trustRetainedCheckout({ project, bot: { id: source.botId }, item: { id: source.itemId, botId: source.botId },
      checkoutKey: source.checkoutKey, trustedMigrationPath: captured });
    return worktreesFor(scope).resolveTransferSource(source, { trustedMigrationPath: captured });
  };
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true;
    for (const controller of activeProofs.keys()) controller.abort();
    const pending = [...activeProofs.values(), Promise.resolve().then(() => gateway.stop())];
    shutdown = (async () => {
      const deadline = AbortSignal.timeout(cleanupTimeoutMs);
      let expire;
      const expired = new Promise((_resolve, reject) => {
        expire = () => reject(botBoundaryError('BOT_PROOF_CLEANUP_TIMEOUT', 503));
        deadline.addEventListener('abort', expire, { once: true });
      });
      try {
        const settled = await Promise.race([Promise.allSettled(pending), expired]);
        const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Bot execution cleanup failed');
      } finally { deadline.removeEventListener('abort', expire); }
    })();
    return shutdown;
  };
  return Object.freeze({ agentServer: true, execute, worktrees: Object.freeze({ resolveTransferSource }),
    handleTool: (request, options) => stopping ? Promise.reject(botBoundaryError('BOT_EXECUTION_STOPPED', 503)) : inbox.request(request, options), stop });
}
