import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { isWorkItem, threadInstance, trackedItemKey } from './items.js';
import { joinProjectPath } from '../source-control/project-path.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const OPEN_CHANGE_INTERVAL_MS = MINUTE;
const PENDING_CHECKS_INTERVAL_MS = 30 * SECOND;
const SETTLED_INTERVAL_MS = 5 * MINUTE;
const WORK_ITEM_OPEN_INTERVAL_MS = 2 * MINUTE;
const UNKNOWN_INTERVAL_MS = MINUTE;
const RETURN_FLOOR_MS = 15 * SECOND;
const TURN_SETTLE_MS = 3 * SECOND;
const BACKOFF_BASE_MS = 30 * SECOND;
const BACKOFF_MAX_MS = 15 * MINUTE;
const DISCONNECTED_RETRY_MS = 2 * MINUTE;

const PERSIST_DEBOUNCE_MS = 2 * SECOND;
const RETENTION_MS = 12 * 60 * MINUTE;
const MAX_ENTRIES = 500;

const WORK_ITEM_BATCH_LIMIT = 50;
const SETTLED_WORK_ITEM_CATEGORIES = new Set(['done', 'canceled']);

const groupOf = (item) => {
  if (isWorkItem(item)) return item.provider;
  const account = item.accountId ? `@${item.accountId}` : '';
  return `${item.provider}|${threadInstance(item)}${account}`;
};
const batchLimitOf = (item) => (isWorkItem(item)
  ? WORK_ITEM_BATCH_LIMIT
  : sourceControlProviderDescriptors.get(item.provider)?.trackedItems.batchLimit ?? WORK_ITEM_BATCH_LIMIT);
const isSettledWorkItem = (state) => SETTLED_WORK_ITEM_CATEGORIES.has(state.state?.category);
const threadRef = (item) => ({ owner: item.owner, repo: item.repo, number: item.number });
const threadAnswerKey = (ref) => `${joinProjectPath(ref.owner, ref.repo)}#${ref.number}`.toLowerCase();

const refreshIntervalMs = (entry) => {
  const { item, state } = entry;
  if (!state) return UNKNOWN_INTERVAL_MS;
  if (isWorkItem(item)) return isSettledWorkItem(state) ? SETTLED_INTERVAL_MS : WORK_ITEM_OPEN_INTERVAL_MS;
  if (item.kind === 'pull') {
    if (state.state === 'merged') return Number.POSITIVE_INFINITY;
    if (state.state === 'closed') return SETTLED_INTERVAL_MS;
    return state.checks?.state === 'pending' ? PENDING_CHECKS_INTERVAL_MS : OPEN_CHANGE_INTERVAL_MS;
  }
  return SETTLED_INTERVAL_MS;
};

const isLive = (entry) => {
  const { item, state } = entry;
  if (!state) return true;
  if (isWorkItem(item)) return !isSettledWorkItem(state);
  return state.state === 'open';
};

const publicState = (key, entry) => ({ key, item: entry.item, state: entry.state, fetchedAt: entry.fetchedAt });

export function createTrackedItemsService({
  readers,
  send,
  isConnectionOpen,
  persistence = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
}) {
  const entries = new Map();
  const connections = new Map();
  const serverInterests = new Map();
  const serverListeners = new Set();
  const forced = new Set();
  const backoff = new Map();
  let timer = null;
  let timerAt = Number.POSITIVE_INFINITY;
  let running = null;
  let rerun = false;
  let turnTimer = null;
  let persistTimer = null;
  let disposed = false;

  const sweepConnections = () => {
    for (const id of connections.keys()) {
      if (!isConnectionOpen(id)) connections.delete(id);
    }
  };

  const addServerKeys = (keys) => {
    for (const items of serverInterests.values()) for (const key of items.keys()) keys.add(key);
    return keys;
  };

  const watchedKeys = () => {
    const keys = new Set();
    for (const connection of connections.values()) {
      if (!connection.visible) continue;
      for (const key of connection.keys) keys.add(key);
    }
    return addServerKeys(keys);
  };

  const interestedKeys = () => {
    const keys = new Set();
    for (const connection of connections.values()) for (const key of connection.keys) keys.add(key);
    return addServerKeys(keys);
  };

  const notifyServerListeners = (changedKeys) => {
    if (changedKeys.size === 0 || serverListeners.size === 0) return;
    const states = [...changedKeys].map((key) => ({ ...publicState(key, entries.get(key)), requestedAt: entries.get(key).requestedAt ?? 0 }));
    for (const listener of serverListeners) {
      try {
        listener(states);
      } catch (error) {
        log.warn?.('[tracked-items] a server listener failed', error?.message ?? error);
      }
    }
  };

  const dueAt = (key, entry) => {
    const backoffUntil = backoff.get(groupOf(entry.item))?.until ?? 0;
    const base = forced.has(key) || entry.checkedAt === 0 ? 0 : entry.checkedAt + refreshIntervalMs(entry);
    return Math.max(base, backoffUntil);
  };

  const schedule = (atMs) => {
    if (disposed || atMs >= timerAt) return;
    if (timer) clearTimer(timer);
    timerAt = atMs;
    timer = setTimer(() => {
      timer = null;
      timerAt = Number.POSITIVE_INFINITY;
      void runTick();
    }, Math.max(0, atMs - now()));
  };

  const scheduleNext = () => {
    let next = Number.POSITIVE_INFINITY;
    for (const key of watchedKeys()) {
      const entry = entries.get(key);
      if (entry) next = Math.min(next, dueAt(key, entry));
    }
    if (Number.isFinite(next)) schedule(next);
  };

  const schedulePersist = () => {
    if (!persistence || persistTimer || disposed) return;
    persistTimer = setTimer(() => {
      persistTimer = null;
      const cutoff = now() - RETENTION_MS;
      const snapshot = [...entries.entries()]
        .filter(([, entry]) => entry.fetchedAt > cutoff)
        .map(([key, entry]) => publicState(key, entry));
      persistence.save(snapshot).catch((error) => log.warn?.('[tracked-items] could not persist state', error));
    }, PERSIST_DEBOUNCE_MS);
  };

  const trim = () => {
    if (entries.size <= MAX_ENTRIES) return;
    const interested = interestedKeys();
    const idle = [...entries.entries()]
      .filter(([key]) => !interested.has(key))
      .sort(([, left], [, right]) => left.fetchedAt - right.fetchedAt);
    for (const [key] of idle) {
      if (entries.size <= MAX_ENTRIES) return;
      entries.delete(key);
    }
  };

  const broadcast = (changedKeys) => {
    if (changedKeys.size === 0) return;
    for (const [id, connection] of connections) {
      const states = [];
      for (const key of changedKeys) {
        if (connection.keys.has(key)) states.push(publicState(key, entries.get(key)));
      }
      if (states.length === 0) continue;
      if (!send(id, { type: 'openchamber:tracked-items.changed', properties: { states } })) connections.delete(id);
    }
  };

  const noteFailure = (group, retryAfterMs) => {
    const failures = (backoff.get(group)?.failures ?? 0) + 1;
    const delay = retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    backoff.set(group, { failures, until: now() + delay });
  };

  const applyAnswers = (batch, answers, changed, requestedAt) => {
    const checkedAt = now();
    for (const [key, entry] of batch) {
      forced.delete(key);
      entry.checkedAt = checkedAt;
      entry.requestedAt = requestedAt;
      const answer = answers.get(key) ?? null;
      if (answer) entry.fetchedAt = checkedAt;
      if (JSON.stringify(answer) === JSON.stringify(entry.state)) continue;
      entry.state = answer;
      changed.add(key);
    }
  };

  const answersFor = (batch, result) => {
    const answers = new Map();
    if (isWorkItem(batch[0][1].item)) {
      const byIdentifier = new Map(batch.map(([key, entry]) => [entry.item.identifier, key]));
      for (const summary of result.items ?? []) {
        const key = byIdentifier.get(String(summary?.identifier ?? '').toUpperCase());
        if (key) answers.set(key, summary);
      }
      return answers;
    }
    const byThread = new Map(batch.map(([key, entry]) => [`${entry.item.kind}:${threadAnswerKey(entry.item)}`, key]));
    for (const [kind, summaries] of [['pull', result.pulls], ['issue', result.issues], ['discussion', result.discussions]]) {
      for (const summary of summaries ?? []) {
        const key = byThread.get(`${kind}:${threadAnswerKey(summary)}`);
        if (key) answers.set(key, summary);
      }
    }
    return answers;
  };

  const readBatch = async (batch) => {
    const first = batch[0][1].item;
    if (isWorkItem(first)) {
      return readers.workItems({ provider: first.provider, identifiers: batch.map(([, entry]) => entry.item.identifier) });
    }
    const refsOf = (kind) => batch.filter(([, entry]) => entry.item.kind === kind).map(([, entry]) => threadRef(entry.item));
    return readers.sourceControl({
      provider: first.provider,
      instance: threadInstance(first),
      accountId: first.accountId ?? null,
      pulls: refsOf('pull'),
      issues: refsOf('issue'),
      discussions: refsOf('discussion'),
    });
  };

  const refreshGroup = async (group, groupEntries, changed) => {
    const limit = batchLimitOf(groupEntries[0][1].item);
    for (let start = 0; start < groupEntries.length; start += limit) {
      const batch = groupEntries.slice(start, start + limit);
      const requestedAt = now();
      let result;
      try {
        result = await readBatch(batch);
      } catch (error) {
        log.warn?.(`[tracked-items] ${group} read failed`, error?.message ?? error);
        result = { status: 'unavailable' };
      }
      if (result?.status === 'ok') {
        backoff.delete(group);
        applyAnswers(batch, answersFor(batch, result), changed, requestedAt);
        continue;
      }
      for (const [key] of batch) forced.delete(key);
      if (result?.status === 'disconnected') backoff.set(group, { failures: 0, until: now() + DISCONNECTED_RETRY_MS });
      else noteFailure(group, Number.isFinite(result?.retryAfterMs) ? result.retryAfterMs : undefined);
      return;
    }
  };

  const tick = async () => {
    sweepConnections();
    const at = now();
    const groups = new Map();
    for (const key of watchedKeys()) {
      const entry = entries.get(key);
      if (!entry || dueAt(key, entry) > at) continue;
      const group = groupOf(entry.item);
      groups.set(group, [...(groups.get(group) ?? []), [key, entry]]);
    }
    if (groups.size === 0) return;
    const changed = new Set();
    await Promise.all([...groups].map(([group, groupEntries]) => refreshGroup(group, groupEntries, changed)));
    if (disposed) return;
    broadcast(changed);
    notifyServerListeners(changed);
    if (changed.size > 0) schedulePersist();
  };

  const runTick = async () => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await tick();
        } while (rerun && !disposed);
      } finally {
        running = null;
        if (!disposed) scheduleNext();
      }
    })();
    return running;
  };

  const restored = (async () => {
    if (!persistence) return;
    try {
      const saved = await persistence.load();
      const cutoff = now() - RETENTION_MS;
      for (const record of saved ?? []) {
        if (!record?.item || !(record.fetchedAt > cutoff)) continue;
        const key = trackedItemKey(record.item);
        if (entries.has(key)) continue;
        entries.set(key, { item: record.item, state: record.state ?? null, fetchedAt: record.fetchedAt, checkedAt: 0 });
      }
    } catch (error) {
      log.warn?.('[tracked-items] could not restore state', error?.message ?? error);
    }
  })();

  return {
    ready: () => restored,

    setInterest(connectionId, items, { visible = true } = {}) {
      if (!isConnectionOpen(connectionId)) {
        throw Object.assign(new Error('The event stream connection is not open'), { code: 'unknown-connection' });
      }
      const keys = new Set(items.keys());
      connections.set(connectionId, { keys, visible });
      const known = [];
      for (const [key, item] of items) {
        const entry = entries.get(key);
        if (!entry) {
          entries.set(key, { item, state: null, fetchedAt: 0, checkedAt: 0 });
          continue;
        }
        if (entry.fetchedAt > 0) known.push(publicState(key, entry));
      }
      trim();
      if (visible) scheduleNext();
      return known;
    },

    setServerInterest(owner, items) {
      if (items.size === 0) {
        serverInterests.delete(owner);
        return;
      }
      serverInterests.set(owner, new Map(items));
      for (const [key, item] of items) {
        if (!entries.has(key)) entries.set(key, { item, state: null, fetchedAt: 0, checkedAt: 0 });
      }
      trim();
      scheduleNext();
    },

    subscribe(listener) {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },

    setPresence(connectionId, visible) {
      const connection = connections.get(connectionId);
      if (!connection || connection.visible === visible) return;
      connection.visible = visible;
      if (!visible) return;
      const floor = now() - RETURN_FLOOR_MS;
      for (const key of connection.keys) {
        const entry = entries.get(key);
        if (entry && entry.checkedAt < floor && Number.isFinite(refreshIntervalMs(entry))) forced.add(key);
      }
      scheduleNext();
    },

    refresh(items) {
      for (const item of items) {
        const key = trackedItemKey(item);
        if (entries.has(key)) forced.add(key);
      }
      scheduleNext();
    },

    refreshItem(provider, { owner, repo, number, identifier }) {
      const same = (left, right) => !left || String(left).toLowerCase() === String(right ?? '').toLowerCase();
      const wanted = String(identifier ?? '').toUpperCase();
      for (const [key, entry] of entries) {
        const item = entry.item;
        if (item.provider !== provider) continue;
        const named = isWorkItem(item)
          ? Boolean(wanted) && item.identifier === wanted
          : item.number === number && same(owner, item.owner) && same(repo, item.repo);
        if (named) forced.add(key);
      }
      scheduleNext();
    },

    refreshProvider(provider) {
      for (const key of watchedKeys()) {
        const entry = entries.get(key);
        if (entry && entry.item.provider === provider && isLive(entry)) forced.add(key);
      }
      scheduleNext();
    },

    noteTurnFinished() {
      if (turnTimer || disposed) return;
      turnTimer = setTimer(() => {
        turnTimer = null;
        const watched = watchedKeys();
        for (const key of watched) {
          const entry = entries.get(key);
          if (entry && isLive(entry)) forced.add(key);
        }
        scheduleNext();
      }, TURN_SETTLE_MS);
    },

    dispose() {
      disposed = true;
      for (const handle of [timer, turnTimer, persistTimer]) if (handle) clearTimer(handle);
      timer = null;
      turnTimer = null;
      persistTimer = null;
    },
  };
}
