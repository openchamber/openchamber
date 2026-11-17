import { z } from 'zod';
import { isFunction, isPrimitiveString } from '../shared/guards.js';
import { createOwnerBotGateway } from './bot-owner-gateway.js';
import { readBoundedBody } from './agent-upstream.js';
import { readTrustedBotMigrationPaths } from '../bots/production-worktrees.js';
import { BOT_SERVICE_BYTES, BOT_SERVICE_INPUT_BYTES, BOT_SERVICE_OPERATIONS, BOT_SERVICE_ROUTE, BOT_SERVICE_TIMEOUT_MS,
  assertBotEffectInput, assertBotServiceReply, botBoundaryError, botReplySchema, botRequestAssociation, botScopeSchema, botWatchAuthoritySchema } from './bot-service-contract.js';

const errorReply = z.object({ code: z.string().regex(/^(?:BOT_[A-Z0-9_]+|SOURCE_CONTROL_[A-Z0-9_]+|agent_[a-z0-9_]+|enterprise_mode)$/).max(200),
  state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']).optional() });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Owner-only client. All callbacks execute in this process, never on the wire. */
export function createAgentBotServices(upstream, options = {}) {
  let { dataDir, resolveProject, listProjects, readItem, readBot, resolveScope, listItems } = options;
  if (!isFunction(upstream?.request)) throw new TypeError('Bot services require an authenticated agent upstream');
  const call = async (operation, value, { signal } = {}) => {
    const contract = BOT_SERVICE_OPERATIONS[operation];
    const parsed = contract?.input.safeParse(value);
    if (!parsed?.success) throw botBoundaryError('BOT_EXECUTION_INVALID_REQUEST', 400, 'failed');
    const captured = parsed.data;
    const association = botRequestAssociation(operation, captured);
    const body = JSON.stringify(captured);
    if (Buffer.byteLength(body) > BOT_SERVICE_INPUT_BYTES) throw botBoundaryError('BOT_EXECUTION_REQUEST_TOO_LARGE', 400, 'failed');
    let response;
    try {
      response = await upstream.request({ path: `${BOT_SERVICE_ROUTE}/${operation}`, method: 'POST', body, signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        timeoutMs: ['proof', 'worktree-create', 'worktree-inspect', 'worktree-adopt-isolated', 'worktree-accept-published',
          'worktree-remove', 'service-execute', 'pull-failed-checks'].includes(operation) ? 600_000 : BOT_SERVICE_TIMEOUT_MS });
      let raw;
      try { raw = JSON.parse(await readBoundedBody(response, BOT_SERVICE_BYTES)); }
      catch (error) { throw botBoundaryError(error.code === 'agent_response_too_large' ? 'BOT_EXECUTION_RESPONSE_TOO_LARGE' : 'BOT_EXECUTION_INVALID_RESPONSE'); }
      if (response.statusCode !== 200) {
        const failure = errorReply.safeParse(raw);
        throw botBoundaryError(failure.success ? failure.data.code : 'BOT_EXECUTION_FAILED',
          response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502, failure.success ? failure.data.state : undefined);
      }
      const reply = botReplySchema(operation).safeParse(raw);
      if (!reply.success || !same(reply.data.association, association)) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
      assertBotServiceReply(operation, captured, reply.data.result);
      return reply.data.result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (errorReply.safeParse(error).success) throw error;
      throw botBoundaryError('BOT_EXECUTION_FAILED');
    }
  };
  const projectFor = async (id) => {
    if (!resolveProject) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    const project = await resolveProject(id);
    if (!project || project.id !== id) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return project;
  };
  const identityProject = async () => {
    const project = (await listProjects?.())?.[0];
    if (!project) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return projectFor(project.id);
  };
  const inventoryFor = async (project) => call('identity-list', { project: project ?? await identityProject() });
  const trustedMigrationFor = async (projectId, itemId, directory) => {
    if (!dataDir) throw botBoundaryError('BOT_EXECUTION_OWNER_REQUIRED', 409);
    const captured = (await readTrustedBotMigrationPaths({ dataDir })).find((entry) => entry.projectId === projectId && entry.itemId === itemId);
    if (captured && directory && captured.directory !== directory) throw botBoundaryError('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH', 409);
    return captured;
  };
  const scopedMigration = async (raw) => {
    const scope = botScopeSchema.parse(raw);
    const trustedMigrationPath = await trustedMigrationFor(scope.project.id, scope.item.id, scope.item.worktree);
    if (scope.trustedMigrationPath && !same(scope.trustedMigrationPath, trustedMigrationPath)) throw botBoundaryError('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH', 409);
    const { trustedMigrationPath: _ignored, ...captured } = scope;
    if (trustedMigrationPath) captured.trustedMigrationPath = trustedMigrationPath;
    return captured;
  };
  const scopeFor = async (input, { allowMissingBot = false } = {}) => {
    if (input.scope) return scopedMigration(input.scope);
    if (input.project && input.bot && input.item) {
      const current = await readItem?.(input.project.id, input.item.id);
      if (current && (current.id !== input.item.id || current.botId !== input.bot.id)) throw botBoundaryError('BOT_EXECUTION_SCOPE_MISMATCH', 409);
      const item = { ...current, ...input.item };
      if (current) item.effects = current.effects;
      return scopedMigration({ project: input.project, bot: input.bot, item,
        checkoutKey: input.checkoutKey ?? `${input.item.id}:worktree` });
    }
    const explicit = await resolveScope?.(input);
    if (explicit) return scopedMigration(explicit);
    const botId = input.botId ?? input.bot?.id ?? input.item?.botId;
    const itemId = input.itemId ?? input.item?.id;
    if (!itemId || !readItem) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    const projects = input.projectId ? [await projectFor(input.projectId)] : await listProjects?.();
    let found = null;
    for (const project of projects ?? []) {
      const item = input.item ?? await readItem(project.id, itemId);
      if (!item || item.id !== itemId || botId && item.botId !== botId) continue;
      const bot = input.bot ?? await readBot?.(project.id, item.botId)
        ?? (allowMissingBot ? { id: item.botId, name: 'Bot', mission: 'Read captured Bot execution.' } : null);
      if (!bot) continue;
      if (found) throw botBoundaryError('BOT_EXECUTION_SCOPE_AMBIGUOUS', 409);
      found = botScopeSchema.parse({ project, bot, item, checkoutKey: `${itemId}:worktree` });
    }
    if (!found) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration(found);
  };
  const entryScope = async (entry) => {
    if (entry.scope || entry.project && entry.bot && entry.item) return scopeFor(entry);
    const project = await projectFor(entry.projectId);
    const item = await readItem?.(entry.projectId, entry.itemId);
    if (item && (item.id !== entry.itemId || item.botId !== entry.botId || item.worktree !== entry.directory)) {
      throw botBoundaryError('BOT_EXECUTION_SCOPE_MISMATCH', 409);
    }
    return scopedMigration({ project, bot: { id: entry.botId, name: 'Bot', mission: 'Execute the captured Bot stage.' },
      item: item ?? { id: entry.itemId, botId: entry.botId, source: { kind: 'manual', id: entry.itemId }, worktree: entry.directory,
        branch: `bot/${entry.itemId}`, sessions: { [entry.stage]: entry.sessionId } }, checkoutKey: `${entry.itemId}:worktree` });
  };
  const sessionCall = async (operation, entry, extra = {}) => call(operation, { scope: await entryScope(entry), sessionId: entry.sessionId, ...extra });
  const stageScope = async (request) => {
    const project = request.project ?? await projectFor(request.projectId);
    const stored = await readItem?.(project.id, request.itemId);
    if (stored) return scopeFor({ project, bot: request.bot, item: stored });
    if (!request.itemId.startsWith('discovery_') || request.directory !== project.path) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration({ project, bot: request.bot,
      item: { id: request.itemId, botId: request.bot.id, source: { kind: 'investigation', id: request.itemId }, sessions: {} } });
  };
  const stageCall = async (operation, request, extra = {}) => call(operation, { scope: await stageScope(request), request, ...extra });
  const directoryScope = async (directory) => {
    const matches = [];
    for (const project of await listProjects?.() ?? []) {
      if (project.path === directory) matches.push({ project, bot: { id: 'knowledge', name: 'Bot', mission: 'Collect registered project knowledge.' },
        item: { id: 'knowledge', botId: 'knowledge', source: { kind: 'manual', id: 'knowledge' } } });
      for (const item of await listItems?.(project.id) ?? []) if (item.worktree === directory) {
        matches.push({ project, item, bot: await readBot?.(project.id, item.botId)
          ?? { id: item.botId, name: 'Bot', mission: 'Collect captured checkout knowledge.' }, checkoutKey: `${item.id}:worktree` });
      }
    }
    if (matches.length !== 1) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration(matches[0]);
  };
  const effectCall = async (operation, effect, input, options) => {
    const captured = structuredClone({ effect, input });
    assertBotEffectInput(captured.effect, captured.input);
    const scope = await scopeFor({ ...captured.effect, scope: options?.scope ?? effect.scope });
    const { scope: _scope, ...descriptor } = captured.effect;
    return call(operation, { scope, operation: descriptor.operation, effect: descriptor, input: captured.input });
  };
  const hostSessions = {
    readSession: (entry) => sessionCall('session', entry),
    isWorking: (entry) => sessionCall('activity', entry),
    readTokens: (entry, options = {}) => sessionCall('tokens', entry, { since: options.since }),
    syncKnowledge: (entry, options = {}) => sessionCall('knowledge-sync', entry, { includeMemorySaveRule: options.includeMemorySaveRule !== false }),
    deliverNotice: (entry) => sessionCall('synthetic-deliver', entry, { eventId: entry.notice.eventId, messageId: entry.id,
      text: entry.text, description: entry.description ?? entry.text }),
    pullTools: (entry) => sessionCall('tools-pull', entry),
    settleTool: (entry, settlement) => sessionCall('tools-settle', entry, { settlement }),
  };
  const watchAuthority = (value) => botWatchAuthoritySchema.parse(value.botAuthority ?? value.authority ?? value);
  const selectedWatchAuthority = (input) => {
    const authority = watchAuthority(input.octokit ?? input.authority);
    if (input.owner && input.owner.toLowerCase() !== authority.target.owner.toLowerCase()
      || input.repo && input.repo.toLowerCase() !== authority.target.repo.toLowerCase()) throw botBoundaryError('BOT_GITHUB_PULL_CHANGED', 409);
    return authority;
  };
  const watchInput = (input) => {
    const authority = selectedWatchAuthority(input);
    return { authority, number: input.number, branch: input.branch ?? authority.publicationBranch ?? `bot/${authority.itemId}`, headSha: input.headSha };
  };
  const watchMigration = async (authority) => {
    const item = await readItem?.(authority.project.id, authority.itemId);
    if (!item || item.botId !== authority.botId || !item.worktree) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return { authority, expectedDirectory: item.worktree,
      trustedMigrationPath: await trustedMigrationFor(authority.project.id, authority.itemId, item.worktree) };
  };
  const botWatch = {
    getOctokit: async (authority) => {
      const captured = structuredClone(watchAuthority(authority)); await watchMigration(captured);
      return { botAuthority: captured };
    },
    readFeedback: async (input) => {
      const captured = watchInput(input);
      return call('pull-feedback', { ...captured, ...await watchMigration(captured.authority), mentionText: input.mentionText });
    },
    readAuthorPermission: async (input) => (await call('pull-author-permission', {
      ...await watchMigration(selectedWatchAuthority(input)), username: input.username })).permitted,
    readFailedChecks: async (input) => call('pull-failed-checks', { ...await watchMigration(selectedWatchAuthority(input)), contexts: input.contexts }),
    authorizeApp: async (authority, author, selectedApprovedApp) => (await call('pull-review-app', {
      ...await watchMigration(watchAuthority(authority)), author, selectedApprovedApp })).authorized,
  };
  const worktrees = {
    create: async (request) => call('worktree-create', { scope: await scopeFor(request), key: request.key }),
    reconcile: async (request) => call('worktree-reconcile', { scope: await scopeFor(request), key: request.key ?? `${request.item.id}:worktree`, operation: request.operation === 'remove' ? 'remove' : 'create' }),
    inspect: async (request) => call('worktree-inspect', { scope: await scopeFor(request) }),
    bindPublication: async (request) => call('worktree-bind-publication', { scope: await scopeFor(request), branch: request.branch }),
    readPublication: async (request) => call('worktree-read-publication', { scope: await scopeFor(request, { allowMissingBot: true }), repositoryId: request.repositoryId }),
    adoptIsolated: async (request) => call('worktree-adopt-isolated', { scope: await scopeFor(request), resultSha: request.resultSha, spaceId: request.spaceId }),
    acceptPublished: async (request) => call('worktree-accept-published', { scope: await scopeFor(request), snapshot: request.snapshot, result: request.result }),
    remove: async (request) => call('worktree-remove', { scope: await scopeFor(request), key: request.key, checkout: request.checkout }),
    sameTree: async (request) => (await call('worktree-same-tree', { scope: await scopeFor(request), left: request.left, right: request.right })).same,
  };
  const services = {
    prepare: async (request) => {
      const scope = await scopeFor(request); const { scope: _scope, ...value } = request;
      const identity = (await inventoryFor(scope.project)).find((entry) => entry.id === request.identityId && entry.revision === request.identityRevision);
      if (!identity) throw botBoundaryError('BOT_IDENTITY_CHANGED', 409);
      const result = await call('service-prepare', { scope, request: value });
      const credentialId = identity.kind === 'github-account' ? identity.accountId : identity.id;
      const credentialRevision = identity.kind === 'github-account' ? identity.credentialRevision : identity.revision;
      if (result.authority.credentialId !== credentialId || result.authority.credentialRevision !== credentialRevision) throw botBoundaryError('BOT_EXECUTION_UNRELATED_REPLY');
      return result;
    },
    read: async (request) => {
      const scope = await scopeFor(request); const { scope: _scope, ...value } = request;
      return (await call('service-read', { scope, request: value })).value;
    },
    preflight: (effect, input, options) => effectCall('service-preflight', effect, input, options),
    async execute(effect, input, options = {}) {
      // Capture before any await: a callback cannot swap the descriptor or input
      // that was preflighted, journaled and then sent to the executor.
      const captured = structuredClone({ effect, input });
      assertBotEffectInput(captured.effect, captured.input);
      const scope = await scopeFor({ ...captured.effect, scope: options.scope ?? effect.scope });
      const { scope: _scope, ...descriptor } = captured.effect;
      const wire = { scope, operation: descriptor.operation, effect: descriptor, input: captured.input };
      await call('service-preflight', wire);
      await options.beforeAdmission?.();
      await options.beforeDispatch?.();
      return call('service-execute', wire);
    },
    reconcile: (effect, input, options) => effectCall('service-reconcile', effect, input, options).then(({ operation: _operation, ...result }) => result),
  };
  const selectIdentity = (inventory, bot, service) => {
    const selected = bot.identity?.[service];
    if (!selected) return null;
    const matches = service === 'github' && selected.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
      : inventory.filter((entry) => entry.id === selected.identityId);
    if (matches.length !== 1 || !matches[0].kind.startsWith(`${service}-`)
      || service === 'github' && (selected.kind === 'app') !== (matches[0].kind === 'github-app')) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
    return matches[0];
  };
  const publicBinding = ({ identityId, identityRevision, target, expectedStatusId }) => {
    const binding = { identityId, identityRevision, target };
    if (expectedStatusId !== undefined) binding.expectedStatusId = expectedStatusId;
    return binding;
  };
  const context = {
    repository: (project) => call('repository', { project }),
    async serviceContext(request) {
      const scope = await scopeFor(request);
      const expectedIdentity = selectIdentity(await inventoryFor(scope.project), scope.bot, request.service);
      let expectedTarget;
      if (expectedIdentity) {
        if (request.service === 'github') expectedTarget = (await context.repository(scope.project)).target;
        if (request.service === 'jira' && scope.item.source.kind === 'jira') expectedTarget = {
          issueKey: scope.item.source.id, projectKey: scope.item.source.id.replace(/-[1-9][0-9]*$/, '') };
        if (request.service === 'discord') expectedTarget = request.target ?? (scope.bot.discord.channels.length === 1 ? scope.bot.discord.channels[0] : undefined);
      }
      const result = await call('context', { scope, service: request.service, operation: request.operation, target: request.target,
        expectedIdentity, expectedTarget });
      return result[request.service] ? { [request.service]: publicBinding(result[request.service]) } : {};
    },
    // Deliberately returns a binding only. The owner receives no credential API.
    async github(request) {
      const inventory = await inventoryFor(request.project);
      const expectedIdentity = request.binding ? inventory.find((entry) => entry.id === request.binding.identityId && entry.revision === request.binding.identityRevision)
        : selectIdentity(inventory, request.bot, 'github');
      if (!expectedIdentity) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
      const expectedTarget = request.binding?.target ?? (await context.repository(request.project)).target;
      const result = await call('github-binding', { project: request.project, bot: request.bot, binding: request.binding, expectedIdentity, expectedTarget });
      return { binding: publicBinding(result.binding) };
    },
    async identityFor(bot, service) {
      const identity = selectIdentity(await inventoryFor(), bot, service);
      if (!identity) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
      return { identityId: identity.id, identityRevision: identity.revision };
    },
  };
  const readPullStatus = async (request) => {
    const scope = await scopeFor(request);
    let authority = request.authority;
    if (authority === null || authority === undefined) {
      authority = { project: scope.project, botId: scope.bot.id, itemId: scope.item.id,
        ...(await context.github({ project: scope.project, bot: scope.bot })).binding };
      if (scope.item.publicationBranch) authority.publicationBranch = scope.item.publicationBranch;
    }
    return call('pull-status', { scope, authority });
  };
  return {
    bindOwner(owners) {
      dataDir = owners.dataDir;
      resolveProject = owners.resolveProject; listProjects = owners.listProjects;
      readItem = async (projectId, itemId) => (await owners.store.read(projectId)).items.find((item) => item.id === itemId) ?? null;
      readBot = async (projectId, botId) => (await owners.config.read(projectId)).definitions.find((bot) => bot.id === botId) ?? null;
      listItems = async (projectId) => (await owners.store.read(projectId)).items;
    },
    identities: { list: () => inventoryFor(), create: async (definition) => call('identity-create', { project: await identityProject(), definition }),
      update: async (id, expectedRevision, definition) => call('identity-update', { project: await identityProject(), id, expectedRevision, definition }),
      remove: async (id, expectedRevision) => call('identity-remove', { project: await identityProject(), id, expectedRevision }) },
    context, worktrees, services, hostSessions, botWatch,
    createGateway(input) {
      if (!input.project || !input.bot) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
      const scope = botScopeSchema.parse({ project: input.project, bot: input.bot,
        item: { id: `discovery_gateway_${input.bot.id}`, botId: input.bot.id, source: { kind: 'investigation', id: 'discord-gateway' } } });
      return createOwnerBotGateway({ ...input, call, scope });
    },
    stages: {
      select: async (projectId, bot, stage) => bot.models[stage].useDefaults
        ? call('defaults', { project: await projectFor(projectId) }) : structuredClone(bot.models[stage]),
      async create(request, onCreated) { const result = await stageCall('stage-create', request); await onCreated(result); return result; },
      dispatch: (request) => stageCall('stage-dispatch', request),
      outcome: (request) => stageCall('stage-outcome', request),
      reconcile: (kind, request, sessionId) => stageCall('stage-reconcile', request, { kind, sessionId }),
      stop: async (request) => sessionCall('stage-stop', { ...request, botId: request.bot?.id ?? request.botId }),
      resume: async (request) => sessionCall('stage-resume', { ...request, botId: request.bot?.id ?? request.botId }),
    },
    readSessionDefaults: async (projectId) => call('defaults', { project: await projectFor(projectId) }),
    sessionKnowledgeRuntime: {
      collect: async (request) => call('knowledge', { scope: isPrimitiveString(request) ? await directoryScope(request) : await scopeFor(request) }),
      sync: hostSessions.syncKnowledge,
    },
    readSession: async (request) => call('session', { scope: await scopeFor(request), sessionId: request.sessionId }),
    readTokens: hostSessions.readTokens, isWorking: hostSessions.isWorking,
    async runProof(input, { signal } = {}) {
      const scope = await scopeFor(input);
      if (input.command !== scope.bot.proof?.command || !same(input.args, scope.bot.proof.args) || input.directory !== scope.item.worktree) {
        throw botBoundaryError('BOT_EXECUTION_PROOF_MISMATCH', 409);
      }
      try { return await call('proof', { scope, testSha: input.testSha, fixSha: input.fixSha }, { signal }); }
      catch (error) {
        if (!signal?.aborted) throw error;
        return { status: 'inconclusive', testSha: input.testSha, fixSha: input.fixSha, command: input.command, args: input.args,
          testExitCode: null, fixExitCode: null, reason: 'Proof was interrupted.' };
      }
    },
    readPolicyFiles: async (project, { files = [] } = {}) => call('policy-files', { project: isPrimitiveString(project)
      ? (await listProjects()).find((entry) => entry.path === project) : project, files }),
    blame: async (request) => call('blame', { scope: await scopeFor(request), snapshot: request.snapshot }),
    readPullStatus,
    pullRequests: { readStatus: readPullStatus,
      getOctokit: botWatch.getOctokit, authorizeApp: botWatch.authorizeApp },
    readFeedback: botWatch.readFeedback, readAuthorPermission: botWatch.readAuthorPermission, readFailedChecks: botWatch.readFailedChecks,
    tools: { pull: hostSessions.pullTools, settle: hostSessions.settleTool },
    deliverSynthetic: hostSessions.deliverNotice,
  };
}
