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
  timer = null;
  if (active.size >= 2 || pending.length === 0) return;
  const first = pending[0];
  const space = spaceIdOfDirectory(first.directory);
  const directories = new Set<string>();
  const batch = pending.filter((read) => {
    if (directories.size === 200 || directories.has(read.directory) || read.runtime !== first.runtime || read.mode !== first.mode || spaceIdOfDirectory(read.directory) !== space) return false;
    directories.add(read.directory);
    return true;
  });
  const selected = new Set(batch);
  pending = pending.filter((read) => !selected.has(read));
  const controller = new AbortController();
  active.add(controller);
  if (pending.length && active.size < 2) timer = setTimeout(() => { void flush(); }, 0);
  const unsettled = new Set(batch);
  try {
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
    for (const read of unsettled) read.reject(error instanceof Error ? error : new Error('Git status batch failed'));
  } finally {
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
