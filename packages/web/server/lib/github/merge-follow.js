import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseTrackedItem, trackedItemKey } from '../tracked-items/items.js';

const OWNER = 'github-user-merges';
const snapshotSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string().optional(),
  checks: z.object({ state: z.string() }).nullable().optional(),
  isInMergeQueue: z.boolean().optional(),
  autoMergeRequest: z.object({ enabledAt: z.string(), mergeMethod: z.string() }).nullish(),
});
const entrySchema = z.object({ item: z.unknown(), startedAt: z.number(), observedAt: z.number().optional(), last: snapshotSchema });

/** Terminal events take precedence over queue removal caused by that same merge/close. */
export function mergeFollowEvents(previous, next) {
  if (next.state === 'merged') return ['merged'];
  if (next.state === 'closed') return ['closed'];
  const events = [];
  if ((previous.isInMergeQueue || previous.autoMergeRequest) && !next.isInMergeQueue && !next.autoMergeRequest) events.push('removed');
  if (next.checks?.state === 'failure' && (previous.checks?.state !== 'failure' || previous.headSha !== next.headSha)) events.push('checks-failed');
  return events;
}

/** User-requested merges share tracked-items' reads, cadence and provider backoff. */
export function createMergeFollowRuntime({ dataDir, notify, now = Date.now }) {
  const file = path.join(dataDir, 'github-merge-follow.json');
  const entries = new Map();
  // Keys of pull requests whose cancel from OpenChamber is running, with the
  // number of such cancels.
  const cancelling = new Map();
  let trackedItems = null;
  let unsubscribe = null;
  let stopped = false;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const loaded = (async () => {
    let stored;
    try { stored = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const parsed = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(200) }).safeParse(stored);
    if (!parsed.success) throw new Error('Invalid GitHub merge follows file');
    for (const value of parsed.data.entries) {
      const parsedEntry = entrySchema.safeParse(value);
      if (!parsedEntry.success) continue;
      const item = parseTrackedItem(parsedEntry.data.item);
      if (item?.provider !== 'github' || item.kind !== 'pull') continue;
      entries.set(trackedItemKey(item), { ...parsedEntry.data, item });
    }
  })();
  // A failed load never authorizes replacing the file with an empty snapshot.
  void loaded.catch((error) => console.warn('[merge-follow] load failed:', error.message));
  const persist = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  };
  const interest = () => trackedItems?.setServerInterest(OWNER, stopped ? new Map() : new Map([...entries].map(([key, entry]) => [key, entry.item])));
  const accept = (states) => serialize(async () => {
    await loaded;
    const notifications = [];
    const previous = new Map(entries);
    let changed = false;
    for (const record of states) {
      const entry = entries.get(record.key);
      const observedAt = record.requestedAt ?? record.fetchedAt;
      if (!entry) continue;
      const parsed = snapshotSchema.safeParse(record.state);
      if (!parsed.success) continue;
      const next = parsed.data;
      // A read begun before the follow says nothing about queue removal, but
      // merged is final whenever it was read, and tracked items stop reading a
      // merged PR, so a stale merged read is the only one that will come.
      if (observedAt < Math.max(entry.startedAt, entry.observedAt ?? 0) && next.state !== 'merged') continue;
      if (JSON.stringify(entry.last) === JSON.stringify(next)) continue;
      changed = true;
      // The user's own cancel from OpenChamber is in flight: its dequeue is
      // not news to them.
      const events = mergeFollowEvents(entry.last, next).filter((event) => event !== 'removed' || !cancelling.has(record.key));
      if (next.state === 'merged' || next.state === 'closed') entries.delete(record.key);
      else entries.set(record.key, { ...entry, observedAt, last: next });
      for (const event of events) notifications.push({ item: entry.item, event });
    }
    if (!changed) return;
    try { await persist(); }
    catch (error) { entries.clear(); for (const [key, entry] of previous) entries.set(key, entry); throw error; }
    interest();
    // Best-effort live notifications, like session notifications. Persist the
    // baseline first so a restart cannot replay a completed notification.
    for (const notification of notifications) {
      try { await notify(notification); }
      catch (error) { console.warn('[merge-follow] notification failed:', error.message); }
    }
  });
  return {
    attach(service) {
      stopped = false;
      trackedItems = service;
      unsubscribe?.();
      unsubscribe = service.subscribe((states) => { void accept(states).catch((error) => console.warn('[merge-follow] update failed:', error.message)); });
      return serialize(async () => { await loaded; interest(); trackedItems.refresh([...entries.values()].map((entry) => entry.item)); });
    },
    /** Before a cancel reaches GitHub; the returned function runs once it settles. */
    onMutationStarting({ context, kind, input, target }) {
      if (context.provider !== 'github' || kind !== 'change-request-merge' || !input.cancel || !target) return null;
      const item = parseTrackedItem({ provider: 'github', kind: 'pull', instance: context.instance, accountId: context.accountId,
        owner: target.project.owner, repo: target.project.name, number: target.number });
      if (!item) return null;
      const key = trackedItemKey(item);
      cancelling.set(key, (cancelling.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Released after onMutationSucceeded has queued the removal, so a read
        // accepted in between still sees the cancel as running.
        void serialize(async () => {
          const count = (cancelling.get(key) ?? 1) - 1;
          if (count > 0) cancelling.set(key, count); else cancelling.delete(key);
        });
      };
    },
    async onMutationSucceeded({ context, kind, input, record, replayed }) {
      if (context.provider !== 'github' || kind !== 'change-request-merge' || replayed) return;
      const item = parseTrackedItem({ provider: 'github', kind: 'pull', instance: context.instance, accountId: context.accountId,
        owner: record.target.project.owner, repo: record.target.project.name, number: record.target.number });
      if (!item) return;
      return serialize(async () => {
        await loaded;
        const key = trackedItemKey(item);
        // The user's own cancel ends the follow; it must not come back as a
        // "removed from the queue" notification.
        if (input.cancel || record.result.merged) {
          const previous = entries.get(key);
          if (!previous) return;
          entries.delete(key);
          try { await persist(); }
          catch (error) { entries.set(key, previous); throw error; }
          interest();
          return;
        }
        if (!['queued', 'auto-merge', 'merging'].includes(record.result.outcome)) return;
        if (!entries.has(key) && entries.size >= 200) throw new Error('Too many followed pull requests');
        const previous = entries.get(key);
        entries.set(key, { item, startedAt: now(), last: {
          state: 'open', headSha: record.target.headSha,
          isInMergeQueue: record.result.outcome === 'queued',
          autoMergeRequest: record.result.outcome === 'auto-merge' ? { enabledAt: new Date(now()).toISOString(), mergeMethod: input.method.toUpperCase() } : null,
        } });
        try { await persist(); }
        catch (error) { if (previous) entries.set(key, previous); else entries.delete(key); throw error; }
        interest();
        trackedItems?.refresh([item]);
      });
    },
    async stop() { stopped = true; unsubscribe?.(); unsubscribe = null; interest(); await queue; },
    // Deterministic tests await the same serialized path the subscription uses.
    accept,
  };
}
