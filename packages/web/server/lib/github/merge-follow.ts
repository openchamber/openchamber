import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolvePrimaryWorktreeRoot } from '../git/service.js';
import { isTrackedItemInput, parseTrackedItem, threadInstance, trackedItemKey } from '../tracked-items/items.js';
import type { ServerTrackedItemState, TrackedThread } from '../tracked-items/contracts.js';
import type { createTrackedItemsService } from '../tracked-items/service.js';
import type { MutationRecord, MutationResult } from '../source-control/mutation-storage.js';
import type { ResolvedMutationTarget, ProviderMutationContext } from '../source-control/provider-contract.js';
import type { GitHubEnvelope } from './contracts.js';

type MergeSnapshot = z.infer<typeof snapshotSchema>;
type MergeEntry = Omit<z.infer<typeof entrySchema>, 'item'> & { item: TrackedThread };
type MergeEvent = 'merged' | 'closed' | 'removed' | 'checks-failed';
export interface MergeNotification { item: TrackedThread; event: MergeEvent; url: string; directory: string | null }
interface MergeFollowOptions {
  dataDir: string;
  notify: (notification: MergeNotification) => void | Promise<void>;
  resolveProjectDirectory?: (directory: string) => Promise<string | null | undefined>;
  now?: () => number;
}
interface MergeMutation {
  context: Pick<ProviderMutationContext, 'provider' | 'instance' | 'accountId'> & { directory?: string | undefined };
  kind: string;
  input: { cancel?: unknown; method?: unknown };
}
type SucceededMutation = MergeMutation & { replayed: boolean; record: MutationRecord };
type TrackedService = Pick<ReturnType<typeof createTrackedItemsService>, 'setServerInterest' | 'subscribe' | 'refresh'>;
interface ErrorFields { code?: unknown; message?: unknown }
const hasErrorFields = (value: unknown): value is ErrorFields => value != null;
const errorField = (value: GitHubEnvelope['data'], key: keyof ErrorFields) => {
  if (!hasErrorFields(value)) throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  return value[key];
};

const OWNER = 'github-user-merges';
const WAITING_OUTCOMES: readonly MutationResult['outcome'][] = ['queued', 'auto-merge', 'merging'];
const snapshotSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string().optional(),
  checks: z.object({ state: z.string() }).nullable().optional(),
  isInMergeQueue: z.boolean().optional(),
  autoMergeRequest: z.object({ enabledAt: z.string(), mergeMethod: z.string() }).nullish(),
});
const entrySchema = z.object({
  item: z.unknown(), directory: z.string().min(1).optional(), startedAt: z.number(), observedAt: z.number().optional(), last: snapshotSchema,
});
const pullRequestUrl = (item: TrackedThread) => `https://${threadInstance(item)}/${item.owner}/${item.repo}/pull/${item.number}`;

export function mergeFollowEvents(previous: MergeSnapshot, next: MergeSnapshot): MergeEvent[] {
  if (next.state === 'merged') return ['merged'];
  if (next.state === 'closed') return ['closed'];
  const events: MergeEvent[] = [];
  if ((previous.isInMergeQueue || previous.autoMergeRequest) && !next.isInMergeQueue && !next.autoMergeRequest) events.push('removed');
  if (next.checks?.state === 'failure' && (previous.checks?.state !== 'failure' || previous.headSha !== next.headSha)) events.push('checks-failed');
  return events;
}

const primaryWorktreeOf = async (directory: string) => (await resolvePrimaryWorktreeRoot(directory)).root;

export function createMergeFollowRuntime({ dataDir, notify, resolveProjectDirectory = primaryWorktreeOf, now = Date.now }: MergeFollowOptions) {
  const file = path.join(dataDir, 'github-merge-follow.json');
  const entries = new Map<string, MergeEntry>();
  const cancelling = new Map<string, number>();
  let trackedItems: TrackedService | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let queue = Promise.resolve();
  const attachedService = () => {
    if (trackedItems === null) throw new Error('Tracked items service is not attached');
    return trackedItems;
  };
  const projectDirectoryOf = async (directory: string | undefined) => {
    const folder = directory?.trim();
    if (!folder) return undefined;
    const project = await resolveProjectDirectory(folder).catch(() => null);
    return project?.trim() || folder;
  };
  const serialize = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const loaded = (async () => {
    let stored: unknown;
    try { stored = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (errorField(error, 'code') === 'ENOENT') return; throw error; }
    const parsed = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(200) }).safeParse(stored);
    if (!parsed.success) throw new Error('Invalid GitHub merge follows file');
    for (const value of parsed.data.entries) {
      const parsedEntry = entrySchema.safeParse(value);
      if (!parsedEntry.success) continue;
      const item = isTrackedItemInput(parsedEntry.data.item) ? parseTrackedItem(parsedEntry.data.item) : null;
      if (item?.provider !== 'github' || item.kind !== 'pull') continue;
      entries.set(trackedItemKey(item), { ...parsedEntry.data, item });
    }
  })();
  void loaded.catch((error: GitHubEnvelope['data']) => console.warn('[merge-follow] load failed:', errorField(error, 'message')));
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
  const accept = (states: ServerTrackedItemState[]) => serialize(async () => {
    await loaded;
    const notifications: MergeNotification[] = [];
    const previous = new Map(entries);
    let changed = false;
    for (const record of states) {
      const entry = entries.get(record.key);
      const observedAt = record.requestedAt ?? record.fetchedAt;
      if (!entry) continue;
      const parsed = snapshotSchema.safeParse(record.state);
      if (!parsed.success) continue;
      const next = parsed.data;
      if (observedAt < Math.max(entry.startedAt, entry.observedAt ?? 0) && next.state !== 'merged') continue;
      if (JSON.stringify(entry.last) === JSON.stringify(next)) continue;
      changed = true;
      const events = mergeFollowEvents(entry.last, next).filter((event) => event !== 'removed' || !cancelling.has(record.key));
      if (next.state === 'merged' || next.state === 'closed') entries.delete(record.key);
      else entries.set(record.key, { ...entry, observedAt, last: next });
      for (const event of events) notifications.push({ item: entry.item, event, url: pullRequestUrl(entry.item), directory: entry.directory ?? null });
    }
    if (!changed) return;
    try { await persist(); }
    catch (error) { entries.clear(); for (const [key, entry] of previous) entries.set(key, entry); throw error; }
    interest();
    for (const notification of notifications) {
      try { await notify(notification); }
      catch (error) { console.warn('[merge-follow] notification failed:', errorField(error, 'message')); }
    }
  });
  return {
    attach(service: TrackedService) {
      stopped = false;
      trackedItems = service;
      unsubscribe?.();
      unsubscribe = service.subscribe((states) => { void accept(states).catch((error: GitHubEnvelope['data']) => console.warn('[merge-follow] update failed:', errorField(error, 'message'))); });
      return serialize(async () => { await loaded; interest(); attachedService().refresh([...entries.values()].map((entry) => entry.item)); });
    },
    onMutationStarting({ context, kind, input, target }: MergeMutation & { target?: ResolvedMutationTarget }) {
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
        void serialize(async () => {
          const count = (cancelling.get(key) ?? 1) - 1;
          if (count > 0) cancelling.set(key, count); else cancelling.delete(key);
        });
      };
    },
    async onMutationSucceeded({ context, kind, input, record, replayed }: SucceededMutation) {
      if (context.provider !== 'github' || kind !== 'change-request-merge' || replayed) return;
      const item = parseTrackedItem({ provider: 'github', kind: 'pull', instance: context.instance, accountId: context.accountId,
        owner: record.target.project.owner, repo: record.target.project.name, number: record.target.number });
      if (!item) return;
      const outcome = record.result?.outcome;
      const directory = !input.cancel && !record.result?.merged && WAITING_OUTCOMES.includes(outcome)
        ? await projectDirectoryOf(context.directory)
        : undefined;
      return serialize(async () => {
        await loaded;
        const key = trackedItemKey(item);
        if (input.cancel || record.result?.merged) {
          const previous = entries.get(key);
          if (!previous) return;
          entries.delete(key);
          try { await persist(); }
          catch (error) { entries.set(key, previous); throw error; }
          interest();
          return;
        }
        if (!WAITING_OUTCOMES.includes(outcome)) return;
        if (!entries.has(key) && entries.size >= 200) throw new Error('Too many followed pull requests');
        const previous = entries.get(key);
        entries.set(key, { item, directory, startedAt: now(), last: {
          state: 'open', headSha: record.target.headSha,
          isInMergeQueue: outcome === 'queued',
          autoMergeRequest: outcome === 'auto-merge' ? { enabledAt: new Date(now()).toISOString(), mergeMethod: String(input.method).toUpperCase() } : null,
        } });
        try { await persist(); }
        catch (error) { if (previous) entries.set(key, previous); else entries.delete(key); throw error; }
        interest();
        trackedItems?.refresh([item]);
      });
    },
    async stop() { stopped = true; unsubscribe?.(); unsubscribe = null; interest(); await queue; },
    accept,
  };
}
