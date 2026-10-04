// Server-owned live state of the pull requests, merge requests and issues the
// connected clients show (sidebar badges, a session's Context sources).
//
// Clients say what they show and whether their window is visible; they never
// poll. This service asks the providers on a cadence that follows each item's
// state, only while some interested client is visible, batched per provider,
// and pushes a change to the clients that show the item only when its state
// actually moved. The last known state survives failures, rate limits and
// restarts (persisted), so a client starts from it instead of an unknown.

import { trackedItemKey } from './items.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// How often an item is asked again, by what it is now.
const OPEN_CHANGE_INTERVAL_MS = MINUTE;
const PENDING_CHECKS_INTERVAL_MS = 30 * SECOND;
const SETTLED_INTERVAL_MS = 5 * MINUTE;
const LINEAR_OPEN_INTERVAL_MS = 2 * MINUTE;
const UNKNOWN_INTERVAL_MS = MINUTE;
// Coming back to the window refreshes what is older than this.
const RETURN_FLOOR_MS = 15 * SECOND;
// A finished agent turn may have opened, merged or closed something; the
// burst of idle events around a turn boundary is coalesced first.
const TURN_SETTLE_MS = 3 * SECOND;
// A provider that failed is left alone for a while, doubling up to the cap.
const BACKOFF_BASE_MS = 30 * SECOND;
const BACKOFF_MAX_MS = 15 * MINUTE;
// No account on that host: nothing will answer until one is connected.
const DISCONNECTED_RETRY_MS = 2 * MINUTE;

const PERSIST_DEBOUNCE_MS = 2 * SECOND;
const RETENTION_MS = 12 * 60 * MINUTE;
const MAX_ENTRIES = 500;

const BATCH_LIMIT = { github: 100, gitlab: 50, linear: 50 };
const LINEAR_SETTLED_TYPES = new Set(['completed', 'canceled']);

// One batch per provider, instance and reading account.
const groupOf = (item) => {
  const account = item.accountId ? `@${item.accountId}` : '';
  return item.provider === 'gitlab' ? `gitlab|${item.instance}${account}` : `${item.provider}${account}`;
};
const threadRef = (item) => ({ owner: item.owner, repo: item.repo, number: item.number });
const threadAnswerKey = (ref) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

const refreshIntervalMs = (entry) => {
  const { item, state } = entry;
  if (!state) return UNKNOWN_INTERVAL_MS;
  if (item.provider === 'linear') {
    return LINEAR_SETTLED_TYPES.has(state.state?.type) ? SETTLED_INTERVAL_MS : LINEAR_OPEN_INTERVAL_MS;
  }
  if (item.kind === 'pull') {
    if (state.state === 'merged') return Number.POSITIVE_INFINITY;
    if (state.state === 'closed') return SETTLED_INTERVAL_MS;
    return state.checks?.state === 'pending' ? PENDING_CHECKS_INTERVAL_MS : OPEN_CHANGE_INTERVAL_MS;
  }
  return SETTLED_INTERVAL_MS;
};

// Whether a finished agent turn could have changed the item.
const isLive = (entry) => {
  const { item, state } = entry;
  if (!state) return true;
  if (item.provider === 'linear') return !LINEAR_SETTLED_TYPES.has(state.state?.type);
  return state.state === 'open';
};

const publicState = (key, entry) => ({ key, item: entry.item, state: entry.state, fetchedAt: entry.fetchedAt });

/**
 * `readers` answer one provider batch each and never see other providers:
 * - `github({ accountId, pulls, issues })`, `gitlab({ instance, accountId, pulls, issues })` with
 *   `{ owner, repo, number }` refs, answering `{ status: 'ok', pulls, issues }`
 *   in GitHub's summary shape;
 * - `linear({ identifiers })` answering `{ status: 'ok', issues }`;
 * - or `{ status: 'disconnected' }` (no account there) /
 *   `{ status: 'unavailable', retryAfterMs? }` (rate limit, outage). A throw
 *   counts as unavailable.
 * `send(connectionId, event)` returns false when the connection is gone.
 */
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

  const watchedKeys = () => {
    const keys = new Set();
    for (const connection of connections.values()) {
      if (!connection.visible) continue;
      for (const key of connection.keys) keys.add(key);
    }
    return keys;
  };

  const interestedKeys = () => {
    const keys = new Set();
    for (const connection of connections.values()) for (const key of connection.keys) keys.add(key);
    return keys;
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

  // Keeps the map bounded without dropping what anyone shows.
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

  // Applies one answered batch. An item the provider did not answer is
  // unknown, not closed: its state is cleared, never invented.
  const applyAnswers = (batch, answers, changed) => {
    const checkedAt = now();
    for (const [key, entry] of batch) {
      forced.delete(key);
      entry.checkedAt = checkedAt;
      const answer = answers.get(key) ?? null;
      if (answer) entry.fetchedAt = checkedAt;
      if (JSON.stringify(answer) === JSON.stringify(entry.state)) continue;
      entry.state = answer;
      changed.add(key);
    }
  };

  // Matches answers back to the batch: a batch is always one provider.
  const answersFor = (batch, result) => {
    const answers = new Map();
    if (batch[0][1].item.provider === 'linear') {
      const byIdentifier = new Map(batch.map(([key, entry]) => [entry.item.identifier, key]));
      for (const summary of result.issues ?? []) {
        const key = byIdentifier.get(String(summary?.identifier ?? '').toUpperCase());
        if (key) answers.set(key, summary);
      }
      return answers;
    }
    const byThread = new Map(batch.map(([key, entry]) => [`${entry.item.kind}:${threadAnswerKey(entry.item)}`, key]));
    for (const [kind, summaries] of [['pull', result.pulls], ['issue', result.issues]]) {
      for (const summary of summaries ?? []) {
        const key = byThread.get(`${kind}:${threadAnswerKey(summary)}`);
        if (key) answers.set(key, summary);
      }
    }
    return answers;
  };

  const readBatch = async (batch) => {
    const first = batch[0][1].item;
    if (first.provider === 'linear') {
      return readers.linear({ identifiers: batch.map(([, entry]) => entry.item.identifier) });
    }
    const pulls = batch.filter(([, entry]) => entry.item.kind === 'pull').map(([, entry]) => threadRef(entry.item));
    const issues = batch.filter(([, entry]) => entry.item.kind === 'issue').map(([, entry]) => threadRef(entry.item));
    const accountId = first.accountId ?? null;
    return first.provider === 'gitlab'
      ? readers.gitlab({ instance: first.instance, accountId, pulls, issues })
      : readers.github({ accountId, pulls, issues });
  };

  const refreshGroup = async (group, groupEntries, changed) => {
    const limit = BATCH_LIMIT[groupEntries[0][1].item.provider];
    for (let start = 0; start < groupEntries.length; start += limit) {
      const batch = groupEntries.slice(start, start + limit);
      let result;
      try {
        result = await readBatch(batch);
      } catch (error) {
        log.warn?.(`[tracked-items] ${group} read failed`, error?.message ?? error);
        result = { status: 'unavailable' };
      }
      if (result?.status === 'ok') {
        backoff.delete(group);
        applyAnswers(batch, answersFor(batch, result), changed);
        continue;
      }
      // The last known state stays; the items wait for the provider.
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
        // An item a client already asked about in the meantime is newer.
        if (entries.has(key)) continue;
        entries.set(key, { item: record.item, state: record.state ?? null, fetchedAt: record.fetchedAt, checkedAt: 0 });
      }
    } catch (error) {
      log.warn?.('[tracked-items] could not restore state', error?.message ?? error);
    }
  })();

  return {
    /** Resolves once the persisted state has been read (or failed to). */
    ready: () => restored,

    /**
     * Replaces what one connection shows and answers with what is known of it
     * already. Unknown items are asked about right away when the client is
     * visible. Throws `unknown-connection` for a connection that is not open.
     */
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

    /** A connection's window became visible or hidden. Visible again refreshes what aged past the floor. */
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

    /** Asks about these items now, whatever their age: a user's refresh, our own mutation. */
    refresh(items) {
      for (const item of items) {
        const key = trackedItemKey(item);
        if (entries.has(key)) forced.add(key);
      }
      scheduleNext();
    },

    /** An agent turn finished somewhere: anything still open may have moved. */
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
