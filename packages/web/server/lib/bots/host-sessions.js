import path from 'node:path';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { BotServiceError } from './services/contracts.js';
import { TERMINAL_ITEM_STATES } from './schema.js';

const refuse = () => { throw new BotServiceError('BOT_ISOLATED_SESSION_MISMATCH', 'The recorded bot session runtime is unavailable.'); };

/** Host-owned session index and isolated queues. Transport is resolved on each call. */
export function createBotHostSessions({ dataDir, isolated, clientFor, hostQueue,
  readHostTokens, assertDispatch, broadcast, sessionKnowledgeRuntime, isSessionArchived, resolvePlacement }) {
  const sessions = new Map();
  const queues = new Map();
  const transfers = new Set();
  let started = false;
  let stopped = false;
  const track = (request) => sessions.set(request.sessionId, request);
  const trackItem = async (projectId, item, bot) => {
    for (const [sessionId, entry] of sessions) {
      if (entry.projectId === projectId && entry.itemId === item.id && (TERMINAL_ITEM_STATES.includes(item.state) || !Object.values(item.sessions).includes(sessionId))) sessions.delete(sessionId);
    }
    if (TERMINAL_ITEM_STATES.includes(item.state)) return;
    if (!Object.keys(item.sessions).length) return;
    const placement = await resolvePlacement({ projectId, itemId: item.id, bot, directory: item.worktree, sessions: item.sessions });
    for (const [stage, sessionId] of Object.entries(item.sessions)) track({ projectId, itemId: item.id, botId: item.botId,
      sessionId, stage, directory: item.worktree, isolated: placement.isolated });
  };
  const owner = async (sessionId) => {
    const entry = sessions.get(sessionId);
    if (!entry?.isolated) refuse();
    const result = await isolated.sessionOwner({ sessionId });
    const { binding } = result;
    if (binding.projectId !== entry.projectId || binding.itemId !== entry.itemId || binding.botId !== entry.botId
      || binding.hostDirectory !== entry.directory) refuse();
    return result;
  };
  const normalize = (info, isolated, archived = false) => ({ id: info.id, directory: info.location?.directory,
    isolated, archived: archived || Boolean(info.time?.archived), metadata: info.metadata });
  const readSession = async ({ projectId, item, bot, sessionId }) => {
    await trackItem(projectId, item, bot);
    if (sessions.get(sessionId)?.isolated) return normalize((await owner(sessionId)).info, true);
    const info = unwrapOpenCodeResponse(await clientFor(item.worktree).session.get({ sessionID: sessionId }));
    return normalize(info, false, await isSessionArchived(sessionId));
  };
  const queueFor = async (target) => {
    if (!target.isolated) return hostQueue;
    const recorded = await owner(target.sessionId);
    const { spaceId } = recorded.binding;
    if (recorded.binding.directory !== target.directory) refuse();
    const existing = queues.get(target.sessionId);
    if (existing) {
      if (started && !existing.release) existing.release = existing.queue.start();
      return existing.queue;
    }
    const listeners = new Set();
    const requestInside = async (input, init) => {
      if (stopped) refuse();
      // A dedicated queue can address only sessions in its captured space.
      const scoped = [...sessions.values()].find((entry) => entry.isolated && entry.sessionId === target.sessionId);
      if (!scoped) refuse();
      const current = await owner(scoped.sessionId);
      if (current.binding.spaceId !== spaceId) refuse();
      return current.fetchImpl(input, init);
    };
    const fetchImpl = (input, init) => {
      const transfer = requestInside(input, init);
      transfers.add(transfer);
      void transfer.then(() => transfers.delete(transfer), () => transfers.delete(transfer));
      return transfer;
    };
    const queue = createMessageQueueRuntime({
      dataDir: path.join(dataDir, 'bots', 'isolated-queues', spaceId, target.sessionId),
      globalEventHub: { subscribeEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (route) => `http://space.invalid${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl,
      botDispatchIsolated: true, assertBotDispatch: assertDispatch,
      // Knowledge is collected on the host and written inside through the stage owner.
      sessionKnowledgeRuntime: { sync: async (sessionId, _directory, options) => {
        const current = await owner(sessionId);
        const { buildKnowledgeEntries } = await import('../session-knowledge/runtime.js');
        const entries = buildKnowledgeEntries(await sessionKnowledgeRuntime.collect(current.binding.hostDirectory), options);
        for (const [key, value] of Object.entries(entries)) if (value) await current.client.session.instructions.entry.put({ sessionID: sessionId, key, value });
      } },
      broadcastGlobalUiEvent: (event) => broadcast({ ...event, properties: { ...event.properties, spaceId } }),
    });
    queues.set(target.sessionId, { queue, listeners, spaceId });
    await queue.load();
    if (started) queues.get(target.sessionId).release = queue.start();
    return queue;
  };
  const queueForSession = async (sessionId) => {
    const entry = sessions.get(sessionId);
    if (!entry?.isolated) return hostQueue;
    const { binding } = await owner(sessionId);
    return queueFor({ ...entry, directory: binding.directory });
  };
  const restore = async (onFailure) => {
    started = true;
    stopped = false;
    for (const entry of sessions.values()) if (entry.isolated && !entry.itemId.startsWith('discovery_')) {
      try {
        const { binding } = await owner(entry.sessionId);
        await queueFor({ ...entry, directory: binding.directory });
      } catch (error) { await onFailure(entry, error); }
    }
  };
  return {
    track, trackItem, get: (sessionId) => sessions.get(sessionId), entries: () => [...sessions.values()],
    readSession, queueFor, queueForSession, owner,
    processPayload(payload, { spaceId }) {
      if (!spaceId) return;
      const sessionId = payload.properties?.sessionID ?? payload.properties?.info?.id;
      if (!sessions.get(sessionId)?.isolated) return;
      const recorded = queues.get(sessionId);
      if (recorded?.spaceId !== spaceId) return;
      for (const listener of recorded.listeners) listener({ spaceId, translated: () => [payload] });
    },
    async isWorking(sessionId) {
      if (!sessions.get(sessionId)?.isolated) return undefined;
      const { probe } = await owner(sessionId);
      const statuses = await probe.fetchActiveSessionStatuses();
      if (statuses === null) return null;
      return Boolean(statuses[sessionId]) || probe.hasWorkingDescendants(sessionId, statuses);
    },
    async tokenSnapshot(sessionId, directory, options) {
      if (!sessions.get(sessionId)?.isolated) return readHostTokens(sessionId, directory, options);
      const current = await owner(sessionId);
      return current.tokens(sessionId, current.binding.directory, options);
    },
    restore,
    async stop() {
      started = false; stopped = true;
      for (const { queue, release } of queues.values()) { release?.(); queue.stop(); }
      await Promise.allSettled([...transfers]);
      for (const { queue } of queues.values()) await queue.flush();
      queues.clear();
    },
  };
}
