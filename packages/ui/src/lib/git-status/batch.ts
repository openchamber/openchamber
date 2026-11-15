import { z } from 'zod';
import type { GitStatus } from '../api/types';
import { runtimeFetch } from '../runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '../runtime-switch';
import { spaceIdOfDirectory } from '../spaces/space-route';
import { GIT_REPOSITORY_UNREADABLE, GitRepositoryUnreadableError } from '../gitRepositoryUnreadable';

const lineStats = z.record(z.string(), z.object({ insertions: z.number(), deletions: z.number() }));
const statusSchema = z.object({
  current: z.string(), tracking: z.string().nullable(), ahead: z.number(), behind: z.number(),
  files: z.array(z.object({ path: z.string(), index: z.string(), working_dir: z.string(), previousPath: z.string().optional() })),
  isClean: z.boolean(), unborn: z.boolean().optional(), aheadBase: z.string().nullable().optional(),
  upstreamComparison: z.object({ remote: z.string(), branch: z.string(), ahead: z.number(), behind: z.number() }).nullable().optional(),
  diffStats: z.object({ staged: lineStats, working: lineStats }).optional(),
  mergeInProgress: z.object({ head: z.string(), message: z.string() }).nullable().optional(),
  rebaseInProgress: z.object({ headName: z.string(), onto: z.string() }).nullable().optional(),
  attentionReason: z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']).nullable().optional(),
});
const entrySchema = z.union([
  z.object({ directory: z.string(), status: statusSchema, isGitRepository: z.boolean() }),
  z.object({ directory: z.string(), error: z.string(), code: z.string().nullable().optional() }),
]);
type Read = {
  directory: string;
  mode?: 'light';
  runtime: string;
  single: (signal: AbortSignal) => Promise<GitStatus>;
  resolve: (result: { status: GitStatus; isGitRepository?: boolean }) => void;
  reject: (error: Error) => void;
};
let pending: Read[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const active = new Set<AbortController>();
// Servers, keyed by runtime and space routing context, that answered without
// the batch route. Their reads use the single-directory GET, one per slot.
const withoutBatchRoute = new Set<string>();
const serverKey = (read: Read) => `${read.runtime}\0${spaceIdOfDirectory(read.directory) ?? ''}`;

// An older server has no batch route: the unmatched POST falls through to the
// OpenCode proxy, which answers 404/405 or its web UI as an HTML page. The
// route itself never answers either way, so any other failure stays an error.
const lacksBatchRoute = (response: Response) =>
  response.status === 404 || response.status === 405
  || (response.ok && (response.headers.get('content-type') ?? '').includes('text/html'));

subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
  if (runtimeKey === previousRuntimeKey) return;
  for (const controller of active) controller.abort();
  for (const read of pending) read.reject(new Error('Git status runtime changed'));
  pending = [];
});

async function* readStatusEntries(response: Response) {
  if (!response.ok || !response.body) throw new Error(`Git status batch failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield entrySchema.parse(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) yield entrySchema.parse(JSON.parse(buffer));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function flush() {
  // 1. Admit a batch only when a request slot is free.
  timer = null;
  if (active.size >= 2 || pending.length === 0) return;

  // 2. Select reads that can share one endpoint, routing context and mode.
  // Duplicate directories stay queued for a separate, potentially fresher read.
  const first = pending[0];
  const space = spaceIdOfDirectory(first.directory);
  const limit = withoutBatchRoute.has(serverKey(first)) ? 1 : 200;
  const directories = new Set<string>();
  const batch = pending.filter((read) => {
    if (directories.size === limit || directories.has(read.directory) || read.runtime !== first.runtime || read.mode !== first.mode || spaceIdOfDirectory(read.directory) !== space) return false;
    directories.add(read.directory);
    return true;
  });
  const selected = new Set(batch);
  pending = pending.filter((read) => !selected.has(read));

  // 3. Hold a slot for the response's entire lifetime. Another batch may use
  // the remaining slot while this one waits for Git or consumes its stream.
  const controller = new AbortController();
  active.add(controller);
  if (pending.length && active.size < 2) timer = setTimeout(() => { void flush(); }, 0);
  const unsettled = new Set(batch);
  try {
    // 4. Send the batch to its captured runtime. A lone read keeps its GET path;
    // multiple reads settle independently as their streamed entries arrive.
    if (first.runtime !== getRuntimeKey()) throw new Error('Git status runtime changed');
    if (batch.length === 1) {
      const status = await first.single(controller.signal);
      if (controller.signal.aborted) throw new Error('Git status runtime changed');
      first.resolve({ status });
      unsettled.delete(first);
    } else {
      const response = await runtimeFetch('/api/git/status/batch', {
        method: 'POST', query: { directory: first.directory }, signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directories: [...directories], mode: first.mode }),
      });
      if (lacksBatchRoute(response)) {
        // Requeue at the front; the next flushes send them as single GETs
        // through the same two slots, so the fallback adds no burst.
        await response.body?.cancel().catch(() => undefined);
        if (controller.signal.aborted) throw new Error('Git status runtime changed');
        withoutBatchRoute.add(serverKey(first));
        pending = [...unsettled, ...pending];
        unsettled.clear();
        return;
      }
      for await (const entry of readStatusEntries(response)) {
        if (controller.signal.aborted) throw new Error('Git status runtime changed');
        for (const read of unsettled) {
          if (read.directory !== entry.directory) continue;
          unsettled.delete(read);
          if ('status' in entry) read.resolve(entry);
          else read.reject(entry.code === GIT_REPOSITORY_UNREADABLE ? new GitRepositoryUnreadableError(entry.error) : new Error(entry.error));
        }
      }
      if (unsettled.size) throw new Error('Git status stream ended before every directory answered');
    }
  } catch (error) {
    // 5. Fail only unanswered reads; already published results remain valid.
    for (const read of unsettled) read.reject(error instanceof Error ? error : new Error('Git status batch failed'));
  } finally {
    // 6. Release the slot on success, failure or cancellation, then drain the queue.
    active.delete(controller);
    if (pending.length && timer === null) timer = setTimeout(() => { void flush(); }, 0);
  }
}

// At most two sockets for status loads; callers may already own a
// background-network slot, so acquiring that gate again would deadlock them.
export function readGitStatus(directory: string, mode: 'light' | undefined, single: Read['single']): Promise<{ status: GitStatus; isGitRepository?: boolean }> {
  return new Promise((resolve, reject) => {
    pending.push({ directory, mode, runtime: getRuntimeKey(), single, resolve, reject });
    if (active.size < 2 && timer === null) timer = setTimeout(() => { void flush(); }, 0);
  });
}
