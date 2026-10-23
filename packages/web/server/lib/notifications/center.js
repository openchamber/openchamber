/**
 * The notification center: every notification this server raised, kept on
 * this machine so a client can list what it missed and mark it read. See
 * "Notification center" in DOCUMENTATION.md.
 */
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const FILE_NAME = 'notification-center.json';
const VERSION = 1;
export const NOTIFICATION_CENTER_LIMIT = 200;
export const NOTIFICATION_CENTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1_000;
const TITLE_MAX = 200;
const BODY_MAX = 500;

/** The kinds clients before `api.notification-center.v2` parse; any other kind fails their whole list. */
const V1_NOTIFICATION_KINDS = ['ready', 'error', 'question', 'permission', 'goal', 'browser-help', 'plugin'];
const NOTIFICATION_KINDS = [
  ...V1_NOTIFICATION_KINDS,
  'restart', 'fix-loop', 'restack', 'update', 'opencode-update', 'scheduled-task', 'bot',
];
const NOTIFICATION_PRIORITIES = ['high', 'normal', 'low'];
/**
 * What happened to the alert: `delivered` went out on the channels the user
 * has on, `focused` raised none because the app was in front, `quiet` raised
 * none because Jev ranked the finished turn low.
 */
const NOTIFICATION_DELIVERIES = ['delivered', 'focused', 'quiet'];
/** Jev's reading of a finished turn; null when Jev was not asked or did not answer. */
const TURN_VERDICTS = ['review', 'stopped-midway', 'looks-done', 'trivial'];

const optionalText = z.string().trim().min(1).nullable().catch(null);

/**
 * What a click opens when it is more than the entry's session: every chat an
 * OpenCode restart cut off, the OpenChamber or OpenCode update, a project's
 * scheduled tasks. Null opens the session, when there is one.
 */
const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sessions'),
    sessions: z.array(z.object({
      sessionId: z.string().min(1),
      directory: optionalText,
      title: optionalText,
    })).min(1).max(50),
  }),
  z.object({ type: z.literal('openchamber-update'), version: optionalText }),
  z.object({ type: z.literal('opencode-update'), version: optionalText }),
  z.object({ type: z.literal('scheduled-tasks'), projectId: z.string().min(1) }),
  z.object({ type: z.literal('bots'), projectId: z.string().min(1), itemId: z.string().min(1) }),
]);

const entrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().finite(),
  kind: z.enum(NOTIFICATION_KINDS),
  priority: z.enum(NOTIFICATION_PRIORITIES),
  delivery: z.enum(NOTIFICATION_DELIVERIES),
  verdict: z.enum(TURN_VERDICTS).nullable().catch(null),
  title: z.string(),
  body: z.string(),
  sessionId: optionalText,
  directory: optionalText,
  sessionName: optionalText,
  /**
   * What the entry waits on, so a client can tell whether it still does: the
   * form, page or permission request id, the fix loop or restack run id, the
   * update's version. Null on entries written before it existed.
   */
  requestId: optionalText,
  action: actionSchema.nullable().catch(null),
  readAt: z.number().finite().nullable().catch(null),
  /** When nothing was left to do about it; resolved entries leave the list for the history. */
  resolvedAt: z.number().finite().nullable().catch(null),
  botState: z.enum(['needs-you', 'waiting-answer']).optional(),
});

/**
 * A finished turn is done once it was seen: reading it resolves it. Errors and
 * every other kind stay until what they wait on is settled (`resolve`).
 */
const RESOLVED_ON_READ = new Set(['ready']);
const isPendingBot = (entry) => entry.kind === 'bot' && entry.resolvedAt === null;

const fileSchema = z.object({ version: z.literal(VERSION), entries: z.array(z.unknown()) });

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const textOrNull = (value) => {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
};

/**
 * Entries live in `notification-center.json` in the data directory. A missing
 * file is an empty center; an unreadable or malformed one is logged and also
 * starts empty, since nothing else depends on it. Single entries that do not
 * parse are dropped, the rest load.
 */
export function createNotificationCenterPersistence({ dataDir, fs = fsPromises }) {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const file = fileSchema.safeParse(JSON.parse(raw));
      if (!file.success) throw new Error('Invalid notification center snapshot');
      return file.data.entries.flatMap((candidate) => {
        const entry = entrySchema.safeParse(candidate);
        return entry.success ? [entry.data] : [];
      });
    },
    async save(entries) {
      // Temp file in the same directory, so the rename is atomic on one device.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, entries }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    },
  };
}

/**
 * Entries are kept oldest first in memory; `list` answers newest first.
 * Every change is broadcast as `openchamber:notification-center.changed`:
 * `{ change: 'added', entry }`, `{ change: 'read', ids, readAt }` or
 * `{ change: 'cleared' }`. A client that reconnects lists again.
 */
export function createNotificationCenterRuntime({
  persistence,
  broadcast = () => {},
  now = Date.now,
  createId = () => crypto.randomUUID(),
  saveDelayMs = SAVE_DELAY_MS,
}) {
  let entries = [];
  let saveTimer = null;
  let stopped = false;
  let loadError = null;
  let writes = Promise.resolve();
  let botChanges = Promise.resolve();
  const serializeBot = (change) => {
    const result = botChanges.catch(() => {}).then(change);
    botChanges = result;
    return result;
  };

  const prune = (list) => {
    const cutoff = now() - NOTIFICATION_CENTER_TTL_MS;
    const history = list.filter((entry) => !isPendingBot(entry) && entry.createdAt >= cutoff);
    const kept = new Set(history.slice(-NOTIFICATION_CENTER_LIMIT));
    return list.filter((entry) => isPendingBot(entry) || kept.has(entry));
  };

  const loaded = (async () => {
    try {
      // A finished turn read before resolution existed is resolved by that read.
      entries = prune((await persistence.load())
        .map((entry) => (entry.resolvedAt === null && entry.readAt !== null && RESOLVED_ON_READ.has(entry.kind)
          ? { ...entry, resolvedAt: entry.readAt }
          : entry))
        .sort((a, b) => a.createdAt - b.createdAt));
    } catch (error) {
      loadError = error;
      console.warn('[notification-center] could not read saved notifications:', error?.message ?? error);
      entries = [];
    }
  })();

  const persist = () => {
    if (loadError) return Promise.reject(loadError);
    const snapshot = entries;
    const write = writes.catch(() => {}).then(() => persistence.save(snapshot));
    writes = write;
    return write;
  };

  const save = async () => {
    saveTimer = null;
    try {
      await persist();
    } catch (error) {
      console.warn('[notification-center] could not save notifications:', error?.message ?? error);
    }
  };

  const scheduleSave = () => {
    if (stopped || saveTimer) return;
    saveTimer = setTimeout(() => { void save(); }, saveDelayMs);
    saveTimer.unref?.();
  };

  const emit = (properties) => broadcast({ type: 'openchamber:notification-center.changed', properties });

  /**
   * Newest first. Without `allKinds`, what clients before v2 can show: their
   * kinds, and no resolved entry, since they have no history to put it in.
   */
  const list = async ({ allKinds = false } = {}) => {
    await loaded;
    const visible = allKinds
      ? entries
      : entries.filter((entry) => V1_NOTIFICATION_KINDS.includes(entry.kind) && entry.resolvedAt === null);
    return visible.slice().reverse();
  };

  /** Records one notification and answers with the stored entry. */
  const record = async ({
    kind, priority, delivery, verdict = null, title, body, sessionId, directory, sessionName, requestId = null, action = null,
  }) => {
    await loaded;
    const entry = {
      id: createId(),
      createdAt: now(),
      kind,
      priority,
      delivery,
      verdict: verdict ?? null,
      title: clip(title, TITLE_MAX),
      body: clip(body, BODY_MAX),
      sessionId: textOrNull(sessionId),
      directory: textOrNull(directory),
      sessionName: textOrNull(sessionName),
      requestId: textOrNull(requestId),
      action,
      readAt: null,
      resolvedAt: null,
    };
    const parsed = entrySchema.parse(entry);
    entries = prune([...entries, parsed]);
    scheduleSave();
    emit({ change: 'added', entry: parsed });
    return parsed;
  };

  /**
   * Marks unread entries read: the listed ids, every entry of one session, or
   * all of them. Answers with the ids that changed; nothing is broadcast when
   * none did.
   */
  const markRead = async ({ ids = null, sessionId = null, all = false }) => {
    await loaded;
    const wanted = ids ? new Set(ids) : null;
    const readAt = now();
    const changed = [];
    const resolved = [];
    entries = entries.map((entry) => {
      if (entry.readAt !== null) return entry;
      const matches = all || (wanted ? wanted.has(entry.id) : entry.sessionId === sessionId);
      if (!matches) return entry;
      changed.push(entry.id);
      if (!RESOLVED_ON_READ.has(entry.kind) || entry.resolvedAt !== null) return { ...entry, readAt };
      resolved.push(entry.id);
      return { ...entry, readAt, resolvedAt: readAt };
    });
    if (changed.length > 0) {
      scheduleSave();
      emit({ change: 'read', ids: changed, readAt });
      if (resolved.length > 0) emit({ change: 'resolved', ids: resolved, resolvedAt: readAt });
    }
    return { ids: changed, readAt };
  };

  /**
   * Moves to the history what no longer waits on the user: the entries of one
   * session of the given kinds, narrowed to one request when `requestId` is
   * set. A resolved entry is also read. Answers with the ids that changed.
   */
  const resolve = async ({ sessionId, kinds, requestId = null }) => {
    await loaded;
    if (!sessionId) return [];
    const wantedKinds = new Set(kinds);
    const at = now();
    const read = [];
    const resolved = [];
    entries = entries.map((entry) => {
      if (entry.resolvedAt !== null || entry.sessionId !== sessionId || !wantedKinds.has(entry.kind)) return entry;
      if (requestId && entry.requestId && entry.requestId !== requestId) return entry;
      resolved.push(entry.id);
      if (entry.readAt === null) read.push(entry.id);
      return { ...entry, readAt: entry.readAt ?? at, resolvedAt: at };
    });
    if (resolved.length > 0) {
      scheduleSave();
      // Clients before v2 know only `read`; it keeps their unread count right.
      if (read.length > 0) emit({ change: 'read', ids: read, readAt: at });
      emit({ change: 'resolved', ids: resolved, resolvedAt: at });
    }
    return resolved;
  };

  /** Deletes the listed entries. Answers with the ids that were there. */
  const remove = async (ids) => {
    await loaded;
    const wanted = new Set(ids);
    const removed = entries.filter((entry) => wanted.has(entry.id) && !isPendingBot(entry)).map((entry) => entry.id);
    if (removed.length === 0) return [];
    entries = entries.filter((entry) => !wanted.has(entry.id) || isPendingBot(entry));
    scheduleSave();
    emit({ change: 'removed', ids: removed });
    return removed;
  };

  const clear = async () => {
    await loaded;
    const removed = entries.filter((entry) => !isPendingBot(entry)).map((entry) => entry.id);
    entries = entries.filter(isPendingBot);
    scheduleSave();
    emit(entries.length ? { change: 'removed', ids: removed } : { change: 'cleared' });
  };

  /**
   * Records an entry unless one of the same kind already names this
   * `requestId` (an update version, a paused restack step), so a check that
   * repeats does not add it again. Answers with the stored entry or null.
   */
  const recordOnce = async (entry) => {
    await loaded;
    if (entry.requestId && entries.some((existing) => existing.kind === entry.kind && existing.requestId === entry.requestId)) {
      return null;
    }
    return record(entry);
  };

  // Bot requests are item-owned and acknowledged only after their snapshot is saved.
  const upsertBot = ({ projectId, itemId, title, body, botState = 'needs-you', sessionId = null, directory = null }) => serializeBot(async () => {
    await loaded;
    if (loadError) throw loadError;
    const action = actionSchema.parse({ type: 'bots', projectId, itemId });
    const existing = entries.find((entry) => isPendingBot(entry) && entry.requestId === itemId && entry.action?.projectId === projectId);
    const fields = { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), botState, sessionId: textOrNull(sessionId), directory: textOrNull(directory) };
    const changed = !existing || Object.entries(fields).some(([key, value]) => existing[key] !== value);
    const entry = entrySchema.parse({
      ...existing, ...fields, id: existing?.id ?? createId(), createdAt: existing?.createdAt ?? now(),
      kind: 'bot', priority: 'high', delivery: 'quiet', verdict: null, sessionName: null,
      requestId: itemId, action, readAt: changed ? null : existing.readAt, resolvedAt: null,
    });
    if (changed) entries = existing ? entries.map((candidate) => candidate === existing ? entry : candidate) : [...entries, entry];
    try {
      await persist();
    } catch (error) {
      if (changed) entries = entries.flatMap((candidate) => candidate === entry ? existing ? [existing] : [] : [candidate]);
      throw error;
    }
    if (changed) {
      if (existing) emit({ change: 'removed', ids: [existing.id] });
      emit({ change: 'added', entry });
    }
    return { entry, changed };
  });

  const resolveBot = ({ projectId, itemId }) => serializeBot(async () => {
    await loaded;
    if (loadError) throw loadError;
    actionSchema.parse({ type: 'bots', projectId, itemId });
    const ids = [];
    const previous = [];
    const at = now();
    entries = prune(entries.map((entry) => {
      if (!isPendingBot(entry) || entry.requestId !== itemId || entry.action?.projectId !== projectId) return entry;
      ids.push(entry.id);
      previous.push(entry);
      return { ...entry, readAt: entry.readAt ?? at, resolvedAt: at };
    }));
    try {
      await persist();
    } catch (error) {
      entries = [...entries.filter((entry) => !ids.includes(entry.id)), ...previous].sort((a, b) => a.createdAt - b.createdAt);
      throw error;
    }
    if (ids.length) {
      emit({ change: 'read', ids, readAt: at });
      emit({ change: 'resolved', ids, resolvedAt: at });
    }
    return ids;
  });

  /** Writes what is pending now; later changes are not saved. */
  const stop = async () => {
    await loaded;
    await botChanges.catch(() => {});
    stopped = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await save();
    }
    await writes;
  };

  return { ready: () => loaded, list, record, recordOnce, upsertBot, resolveBot, markRead, resolve, remove, clear, stop };
}

/**
 * The OpenChamber version this data directory last ran, kept beside the
 * center so a start on a new version can say so. `noteVersion(current)`
 * answers the previous version when it differs, and null on the first start
 * (nothing to compare with), on the same version, or when the file cannot be
 * read or written.
 */
export function createAppVersionMarker({ dataDir, fs = fsPromises }) {
  const filePath = path.join(dataDir, 'notification-center-version.json');
  const versionSchema = z.string().min(1);
  const markerSchema = z.object({ version: versionSchema });
  return {
    async noteVersion(current) {
      if (!versionSchema.safeParse(current).success) return null;
      let previous = null;
      try {
        previous = markerSchema.safeParse(JSON.parse(await fs.readFile(filePath, 'utf8'))).data?.version ?? null;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('[notification-center] could not read the last version:', error?.message ?? error);
          return null;
        }
      }
      if (previous === current) return null;
      try {
        await fs.writeFile(filePath, JSON.stringify({ version: current }), { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        console.warn('[notification-center] could not save the version:', error?.message ?? error);
        return null;
      }
      return previous;
    },
  };
}
