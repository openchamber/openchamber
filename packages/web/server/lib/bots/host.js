import path from 'node:path';
import { z } from 'zod';
import { createBotsConfig } from './config.js';
import { createBotStore } from './store.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices, BotServiceError } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { createBotIsolatedStages } from './isolated-stages.js';
import { readBotSpaceOptions } from './space-options.js';
import { createBotStageSessions } from './stage-sessions.js';
import { createBotDiscovery } from './discovery.js';
import { createBotProviderRuntime } from './provider-runtime.js';
import { createBotSources } from './sources.js';
import { createBotProofRunner } from './proof.js';
import { createBotNotices } from './notices.js';
import { createBotAttention } from './attention.js';
import { createBotScheduler } from './scheduler.js';
import { createBotEvents } from './events.js';
import { createBotsRuntime } from './runtime.js';
import { createBotHostSessions } from './host-sessions.js';
import { registerBotRoutes } from './routes.js';
import { createBotIsolatedToolInbox, registerBotIsolatedToolRoutes } from './isolated-tools.js';
import { createBotAdapterState } from './adapter-state.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotPlacement } from './placement.js';
import { createBotQuestions } from './questions.js';
import { botGit } from './production-git.js';
import { readRepositoryPolicy } from './repository-policy.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';

const failureCode = (error) => error?.code?.startsWith('BOT_') ? error.code : 'BOT_HOST_OPERATION_FAILED';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const publicationSchema = z.object({ sourceHeadSha: sha, headSha: sha,
  commitMap: z.array(z.object({ sourceSha: sha, publishedSha: sha }).strict()).min(1).max(100) }).strict();

/** The child has no identity store, service executor, scheduler or host coordinator. */
export function createBotChildServer({ dataDir, updateMetadata }) {
  const inbox = createBotIsolatedToolInbox({ dataDir, onPending: async ({ sessionId, requestId }) => {
    await updateMetadata(sessionId, { openchamber: { botToolPending: requestId } });
  } });
  return { handleTool: (request, options) => inbox.request(request, options),
    registerRoutes: (app) => {
      registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace: () => true });
      app.use('/api/projects/:projectId/bots', (_req, res) => res.status(501).json({ code: 'BOT_HOST_REQUIRED' }));
    } };
}

/** Production composition. Construction is inert; start follows OpenCode readiness. */
export function createBotsHost({ dataDir, projectsDir, projectConfigRuntime, scheduledTasksRuntime,
  listProjects, resolveProject, sessionService, readOnlySessionService, clientFor,
  permissionAutoAcceptRuntime, sessionKnowledgeRuntime, readSessionDefaults,
  buildOpenCodeUrl, getOpenCodeAuthHeaders, getSpacesHost, getSpaceArchive, messageQueueRuntime,
  notificationCenter, notify, broadcast, getFixLoopRuntime, disposeInstance,
  reviewApps = [], logger = console, fetchImpl, policyOptions }) {
  const config = createBotsConfig({ projectConfigRuntime });
  const store = createBotStore({ projectsDirPath: projectsDir });
  const identities = createBotIdentityStore({ dataDir });
  const events = createBotEvents();
  const attention = createBotAttention({ center: notificationCenter, notify });
  const activity = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const readTokens = createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  let runtime; let providers; let notices; let started = false; let stopping = false; let startup = null;
  const work = new Set();
  const observe = (promise) => {
    const operation = Promise.resolve(promise).catch((error) => logger.warn('[bots]', failureCode(error)));
    work.add(operation); void operation.finally(() => work.delete(operation)); return operation;
  };
  const isolated = createBotIsolatedStages({ dataDir, getSpacesHost, resolveProject, sessionKnowledgeRuntime,
    resolveSpaceOptions: ({ bot, selection }) => readBotSpaceOptions(bot.space, selection),
    handleTool: (request) => api.handleTool(request) });
  const journal = createBotExecutionStore({ store });
  const placement = createBotPlacement({ dataDir, journal, isolated, getSpaceArchive });
  const sessions = createBotHostSessions({ dataDir, isolated, clientFor, hostQueue: messageQueueRuntime,
    resolvePlacement: placement.resolve,
    readHostTokens: readTokens, assertDispatch: (input) => { assertStarted(); return notices.assertDispatch(input); }, broadcast, sessionKnowledgeRuntime,
    isSessionArchived: (sessionId) => sessionService.archiveStore.isArchived(sessionId) });
  const services = createBotServices({ dataDir, identities, fetchImpl, policyOptions,
    resolveQuestionAuthority: async ({ botId, itemId, key }) => {
      for (const project of await listProjects()) {
        const item = (await store.read(project.id)).items.find((entry) => entry.id === itemId && entry.botId === botId);
        if (!item) continue;
        if (item.state !== 'waiting-answer') return null;
        const execution = await journal.read(project.id, itemId);
        if (execution.data.pendingQuestion !== key) return null;
        const question = execution.data.questions?.[key];
        const settings = await config.read(project.id);
        const bot = settings.definitions.find((entry) => entry.id === botId && entry.enabled);
        if (!question?.route || !bot || bot.identity[question.route.service]?.identityId !== question.route.binding.identityId) return null;
        return { policy: await readRepositoryPolicy(project.path, settings.approvals), question };
      }
      return null;
    }, approvedDiscordPeople: async (effect) => {
    for (const project of await listProjects()) {
      const item = (await store.read(project.id)).items.find((entry) => entry.id === effect.itemId && entry.botId === effect.botId);
      if (!item) continue;
      const policy = await readRepositoryPolicy(project.path, (await config.read(project.id)).approvals);
      return policy.people.status === 'approved' ? policy.people.people.flatMap((person) => person.discord ? [person.discord] : []) : [];
    }
    return [];
  } });
  const context = createBotServiceContext({ identities, services, fetchImpl, policyOptions,
    resolveDiscordTarget: (request) => providers.resolveDiscordTarget(request) });
  const productionWorktrees = createProductionBotWorktrees({ dataDir, context, disposeInstance,
    readItem: async (projectId, itemId) => (await store.read(projectId)).items.find((item) => item.id === itemId) });
  const publications = createBotAdapterState({ dataDir, name: 'published-snapshots', schema: publicationSchema });
  const keyFor = ({ project, item }) => ({ projectId: project.id, itemId: item.id });
  const itemPlacement = ({ project, item, bot }) => placement.resolve({ projectId: project.id, itemId: item.id, bot, directory: item.worktree, sessions: item.sessions });
  const sameTree = async (directory, left, right) => (await botGit(directory, ['rev-parse', `${left}^{tree}`])).trim()
    === (await botGit(directory, ['rev-parse', `${right}^{tree}`])).trim();
  const remove = async (request) => {
    await isolated.remove(request);
    return productionWorktrees.remove(request);
  };
  const worktrees = { ...productionWorktrees, remove,
    reconcile: async (request) => {
      // Removal is an idempotent, locally verified operation. A space can be
      // gone while its checkout still needs the original cleanup to finish.
      if (request.operation === 'remove') await remove(request);
      return productionWorktrees.reconcile(request);
    },
    inspect: async (request) => {
      if (!(await itemPlacement(request)).isolated) return productionWorktrees.inspect(request);
      request = { ...request, bot: { ...request.bot, isolated: true } };
      const exported = await isolated.exportSnapshot({ projectId: request.project.id, itemId: request.item.id });
      if (exported.repository !== request.item.worktree) throw new BotServiceError('BOT_ISOLATED_DIRECTORY_MISMATCH', 'The exported result belongs to another checkout.');
      const current = await productionWorktrees.inspect(request);
      // Signed publication rewrites commit IDs while retaining immutable trees.
      if (current.headSha !== exported.resultSha && current.headSha === current.remoteSha
        && await sameTree(request.item.worktree, current.headSha, exported.resultSha)) return current;
      await productionWorktrees.adoptIsolated({ ...request, resultSha: exported.resultSha });
      return productionWorktrees.inspect(request);
    },
    acceptPublished: async (request) => {
      await publications.own(keyFor(request), () => publications.write(keyFor(request), publicationSchema.parse(request.result)));
      return productionWorktrees.acceptPublished(request);
    },
  };
  const proof = createBotProofRunner({ root: path.join(dataDir, 'bots', 'proof'), executeIsolatedProof: async (input, options) => {
    const binding = await isolated.bindingFor(input);
    const published = await publications.read({ projectId: binding.projectId, itemId: binding.itemId });
    if (!published) return isolated.executeIsolatedProof(input, options);
    const map = async (commit) => {
      const source = published.commitMap.find((entry) => entry.publishedSha === commit)?.sourceSha ?? commit;
      if (!await sameTree(input.directory, source, commit)) throw new BotServiceError('BOT_GIT_COMMIT_MAP_INVALID', 'The published proof tree changed.');
      return source;
    };
    const result = await isolated.executeIsolatedProof({ ...input, testSha: await map(input.testSha), fixSha: await map(input.fixSha) }, options);
    return { ...result, testSha: input.testSha, fixSha: input.fixSha };
  } });
  const baseStages = createBotStageSessions({ sessionService: { create: sessionService.create,
    send: (sessionId, payload) => (sessions.get(sessionId)?.stage === 'fixing' ? sessionService : readOnlySessionService).send(sessionId, payload) },
    clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe: activity, readSessionDefaults, readTokenSnapshot: readTokens, isolated });
  const trackRun = (request, sessionId) => sessions.track({ projectId: request.projectId, itemId: request.itemId,
    botId: request.bot.id, directory: request.directory, stage: request.stage, sessionId, isolated: request.bot.isolated });
  const stageRequest = async (request) => {
    if (!request.projectId || !request.itemId) {
      const entry = sessions.get(request.sessionId);
      if (!entry) throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The session has no recorded execution placement.');
      request = { ...request, projectId: entry.projectId, itemId: entry.itemId };
    }
    const recorded = await placement.resolve(request.itemId.startsWith('discovery_') ? { ...request, capturedRun: request } : request);
    return { ...request, bot: { ...request.bot, isolated: recorded.isolated } };
  };
  const stages = { ...baseStages,
    create: async (input, onCreated) => {
      const request = await stageRequest(input);
      return baseStages.create(request, async (created) => { trackRun(request, created.sessionId); await onCreated(created); });
    },
    dispatch: async (request) => baseStages.dispatch(await stageRequest(request)),
    reconcile: async (kind, request, sessionId) => baseStages.reconcile(kind, await stageRequest(request), sessionId),
    stop: async (request) => baseStages.stop(await stageRequest(request)),
    resume: async (request) => baseStages.resume(await stageRequest(request)),
    outcome: async (input) => { const request = await stageRequest(input); trackRun(request, request.sessionId); return baseStages.outcome(request); },
  };
  const reportAttention = async ({ projectId, botId, itemId, occurrence, reason }) => {
    if (!projectId) return;
    if (itemId) return runtime.reportAttention({ projectId, itemId, reason });
    const definitions = (await config.read(projectId)).definitions.filter((bot) => bot.enabled && (!botId || bot.id === botId));
    for (const bot of definitions) {
      const item = await runtime.admit(projectId, bot.id, { source: { kind: 'investigation', id: `attention:${bot.id}:${occurrence ?? 'provider'}` },
        title: bot.name, description: reason, evidence: [] });
      await runtime.reportAttention({ projectId, itemId: item.id, reason });
    }
  };
  const assertStarted = () => {
    if (!started || stopping) throw new BotServiceError('BOT_HOST_NOT_READY', 'The bot host is waiting for OpenCode readiness.', 'needs-you', 503);
  };
  const runScheduled = async (projectId, botId, occurrence) => {
    assertStarted();
    try { return await runtime.runScheduled(projectId, botId, occurrence); }
    catch (error) {
      if (error?.code !== 'BOT_DISCOVERY_PENDING') await reportAttention({ projectId, botId, occurrence, reason: failureCode(error) });
      throw error;
    }
  };
  const discovery = createBotDiscovery({ dataDir, stages,
    onReady: async ({ projectId, botId, occurrence }) => {
      try { await runScheduled(projectId, botId, occurrence); }
      catch (error) { if (error?.code !== 'BOT_DISCOVERY_PENDING') throw error; }
    }, onAttention: reportAttention });
  const sources = { ...createBotSources({ services, resolveJiraContext: (request) => providers.resolveJiraContext(request), discover: discovery.discover }), usage: discovery.usage };
  notices = createBotNotices({ store, config, readSession: sessions.readSession, queueFor: sessions.queueFor });
  const { pullRequests, botWatch: productionBotWatch } = createProductionBotPullRequests({ context, services, getFixLoopRuntime, reviewApps,
    receiveFeedback: (projectId, itemId, event) => runtime.receiveFeedback(projectId, itemId, event) });
  const botWatch = { ...productionBotWatch, getOctokit: async (authority) => {
    // Existing PR watch ticks also reconcile head/base/policy and merged items.
    // The wake is not awaited by the loop whose task cleanup may need to drain.
    events.publish({ type: 'bot.wake', projectId: authority.project.id });
    return productionBotWatch.getOctokit(authority);
  } };
  const scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime });
  const questions = createBotQuestions({ config, store, worktrees, context, services, attention, events });
  runtime = createBotsRuntime({ config, store, resolveProject, listProjects, stages, worktrees, services,
    serviceContext: context.serviceContext, runProof: async (input, options) => {
      const session = sessions.get(input.item.sessions.fixing);
      if (!session || session.itemId !== input.item.id || session.botId !== input.item.botId) {
        throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The proof requires its recorded correction session.');
      }
      const recorded = await placement.read({ projectId: session.projectId, itemId: input.item.id });
      if (!recorded || recorded.botId !== input.item.botId || recorded.hostDirectory !== input.directory) {
        throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The proof must use its recorded execution placement.');
      }
      return proof.run({ ...input, isolated: recorded.isolated }, options);
    }, pullRequests, sources, attention, notices, scheduler, events, questions });
  providers = createBotProviderRuntime({ dataDir, config, store, identities, services, runtime, listProjects, resolveProject,
    serviceContext: context.serviceContext, onNeedsYou: reportAttention });
  const refreshIndex = async (projectId) => {
    const settings = await config.read(projectId);
    for (const item of (await store.read(projectId)).items) {
      const bot = settings.definitions.find((entry) => entry.id === item.botId);
      if (bot) await sessions.trackItem(projectId, item, bot);
    }
  };
  const release = events.subscribe((event) => {
    if (event.projectId) broadcast({ type: 'openchamber:bots-changed', properties: { projectId: event.projectId } });
    if (event.item) observe(refreshIndex(event.projectId));
  });
  const usageReads = new Map();
  const accountUsage = (entry) => {
    if (usageReads.has(entry.sessionId)) { usageReads.get(entry.sessionId).again = true; return usageReads.get(entry.sessionId).promise; }
    const state = { again: false };
    state.promise = (async () => {
      do {
        state.again = false;
        const total = await sessions.tokenSnapshot(entry.sessionId, entry.directory);
        if (total === null) throw new BotServiceError('BOT_TOKEN_USAGE_UNAVAILABLE', 'Complete bot token usage is unavailable.');
        if (entry.itemId.startsWith('discovery_')) await discovery.recordUsage({ sessionId: entry.sessionId, total });
        else await runtime.recordUsage({ sessionId: entry.sessionId, total });
      } while (state.again && !stopping);
    })().finally(() => usageReads.delete(entry.sessionId));
    usageReads.set(entry.sessionId, state); return state.promise;
  };
  const processPayload = async (payload, { spaceId = null } = {}) => {
    if (!started || stopping) return;
    const properties = payload.properties ?? {};
    const info = properties.info;
    const completed = payload.type === 'message.updated' && info?.role === 'assistant' && info.time?.completed !== undefined;
    const wake = payload.type === 'session.updated' && info?.metadata?.openchamber?.botToolPending;
    const reason = payload.type === 'session.idle' || payload.type === 'session.status' && properties.status?.type === 'idle' ? 'idle'
      : payload.type === 'session.error' ? 'BOT_SESSION_ERROR' : null;
    // No disk, SDK or provider work for token deltas or unrelated session events.
    if (!completed && !wake && !reason) return;
    const sessionId = properties.sessionID ?? properties.info?.sessionID ?? properties.info?.id;
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.isolated) {
      const binding = await isolated.bindingFor({ sessionId });
      if (binding.spaceId !== spaceId) return;
    } else if (spaceId) return;
    sessions.processPayload(payload, { spaceId });
    if (entry.isolated && entry.stage === 'fixing' && wake) {
      // Never hold a project execution lock while servicing a tool call.
      observe(isolated.forwardTools({ spaceId, sessionId }).catch((error) => reportAttention({ ...entry, reason: failureCode(error) })));
    }
    // Pending permission/form requests already belong to live central attention.
    // Keeping the stage active lets the matching reply resume it naturally.
    if (completed || reason === 'idle') {
      try { await accountUsage(entry); }
      catch (error) {
        if (!entry.itemId.startsWith('discovery_') && (await runtime.detail(entry.projectId, entry.itemId)).item.state === 'needs-you') return;
        const failure = { sessionId, reason: failureCode(error) };
        return entry.itemId.startsWith('discovery_') ? discovery.onSessionEvent(failure) : runtime.onSessionEvent(failure);
      }
    }
    if (!reason) return;
    return entry.itemId.startsWith('discovery_') ? discovery.onSessionEvent({ sessionId, reason }) : runtime.onSessionEvent({ sessionId, reason });
  };
  const api = { ...runtime, runScheduled,
    async detail(projectId, itemId) {
      const detail = await runtime.detail(projectId, itemId);
      return { ...detail, sessionDirectories: await placement.sessionDirectories({ projectId, item: detail.item }) };
    },
    async saveConfig(...args) { assertStarted(); const result = await runtime.saveConfig(...args); await refreshIndex(args[0]); await providers.reconfigure(); await discovery.reconfigure(); broadcast({ type: 'openchamber:bots-changed', properties: { projectId: args[0] } }); return result; },
    async approvePolicy(...args) { const result = await runtime.approvePolicy(...args); await providers.reconfigure(); await runtime.pump(args[0]); return result; },
  };
  for (const method of ['admit', 'pump']) api[method] = (...args) => {
    assertStarted(); return runtime[method](...args);
  };
  for (const method of ['answer', 'resume', 'stopItem']) api[method] = async (...args) => {
    assertStarted(); await runtime[method](...args); return api.detail(args[0], args[1]);
  };
  api.handleTool = async (request) => {
    assertStarted();
    try { return await runtime.handleTool(request); }
    catch (error) {
      const entry = sessions.get(request.sessionId);
      if (entry && error?.status !== 400) await reportAttention({ ...entry, reason: failureCode(error) });
      throw error;
    }
  };
  const publicIdentities = { list: identities.list };
  for (const method of ['create', 'update', 'remove']) publicIdentities[method] = async (...args) => {
    const result = await identities[method](...args); await providers.reconfigure(); return result;
  };
  return {
    runtime: api, botWatch, assertDispatch: (input) => { assertStarted(); return notices.assertDispatch(input); }, handleTool: api.handleTool,
    processPayload: (...args) => observe(processPayload(...args)),
    isSessionWorking: (sessionId) => sessions.isWorking(sessionId), readTokenSnapshot: sessions.tokenSnapshot,
    queueForSession: sessions.queueForSession,
    onPullRequestSettled(loop) {
      if (stopping) return;
      const authority = loop.botAuthority;
      observe((async () => {
        const item = (await store.read(authority.project.id)).items.find((entry) => entry.id === authority.itemId);
        if (!item || item.botId !== authority.botId || item.sessions.fixing !== loop.sessionId || item.pr?.number !== loop.number) return;
        if (loop.status === 'closed' && loop.statusReason === 'merged' || loop.status === 'watching' || loop.status === 'ready') {
          await runtime.pump(authority.project.id);
        } else await runtime.reportAttention({ projectId: authority.project.id, itemId: item.id,
          reason: loop.status === 'closed' ? 'BOT_PULL_REQUEST_CLOSED' : 'BOT_PULL_REQUEST_WATCH_STOPPED' });
      })());
    },
    registerRoutes: (app) => {
      app.use('/api/openchamber/bots/isolated-tools', (_req, res) => res.status(403).json({ code: 'BOT_ISOLATED_CHILD_REQUIRED' }));
      registerBotRoutes(app, { botsRuntime: api, identities: publicIdentities });
    },
    async runScheduled(projectId, botId, occurrence) {
      try { return await runScheduled(projectId, botId, occurrence); }
      catch (error) { if (error?.code === 'BOT_DISCOVERY_PENDING') return { items: [], skipped: false, pending: error.pending }; throw error; }
    },
    async deliverSuggestion({ projectId, botId, suggestion }) {
      assertStarted();
      const files = suggestion.files.map((file) => `${file.path}${file.startLine ? `:${file.startLine}${file.endLine ? `-${file.endLine}` : ''}` : ''}`);
      const description = [suggestion.body, files.length ? `Files:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
      const item = await runtime.admit(projectId, botId, { source: { kind: 'suggestion', id: suggestion.id }, title: suggestion.title, description, evidence: suggestion.evidence ?? [] });
      await runtime.pump(projectId); return { itemId: item.id };
    },
    start() {
      if (startup) return startup;
      if (stopping) return Promise.resolve({ failures: [] });
      startup = (async () => {
      const failures = [];
      for (const binding of await isolated.bindings()) {
        if (binding.state === 'removed') continue;
        for (const session of Object.values(binding.sessions)) sessions.track({ projectId: binding.projectId, botId: binding.botId,
          itemId: binding.itemId, sessionId: session.id, directory: binding.hostDirectory, stage: session.stage, isolated: true });
      }
      for (const project of await listProjects()) {
        try { await refreshIndex(project.id); }
        catch (error) { failures.push({ projectId: project.id, code: failureCode(error) }); }
      }
      if (stopping) return { failures };
      started = true;
      const recovered = await runtime.start();
      if (stopping) return { failures: [...failures, ...recovered.failures] };
      await sessions.restore((entry, error) => reportAttention({ ...entry, reason: failureCode(error) }));
      for (const entry of sessions.entries()) if (entry.isolated && entry.stage === 'fixing') observe((async () => {
        const binding = await isolated.bindingFor({ sessionId: entry.sessionId });
        await isolated.forwardTools({ spaceId: binding.spaceId, sessionId: entry.sessionId })
          .catch((error) => reportAttention({ ...entry, reason: failureCode(error) }));
      })());
      if (!stopping) await providers.start();
      if (!stopping) await discovery.start();
      return { failures: [...failures, ...recovered.failures] };
      })();
      return startup;
    },
    async stop() {
      stopping = true;
      const failures = [];
      // Recovery pumps can hold startup open while proof runs. Cancel them
      // before joining startup; its guards prevent reactivating the owners.
      const cancellation = runtime.stop().catch((error) => { failures.push(error); });
      try { await startup; } catch (error) { failures.push(error); }
      await cancellation;
      const drain = async () => { while (work.size) await Promise.all([...work]); };
      for (const stop of [providers.stop, discovery.stop, drain, sessions.stop]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      release(); started = false;
      if (failures.length) throw new AggregateError(failures, 'Bot host shutdown could not fully drain');
    },
  };
}
