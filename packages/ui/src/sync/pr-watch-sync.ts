import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { applyPrWatches, applyPrWatchSnapshot, prWatchSnapshotSchema, restorePrWatches, takePrWatches } from './pr-watch';

const isPrWatchAvailable = (): boolean => !isVSCodeRuntime();

const hydratePrWatches = async (): Promise<void> => {
  if (!isPrWatchAvailable()) return;
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch('/api/pr-watch', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Pull request watches failed to load (${response.status})`);
  const parsed = prWatchSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Invalid pull request watch response');
  if (runtimeKey !== getRuntimeKey()) return;
  applyPrWatchSnapshot(parsed.data);
  if (parsed.data.watches.length > 0) void seedGlobalSessionStatusFromHost().catch(() => undefined);
};

export const subscribePrWatchSync = (runtimeKey: string): (() => void) => {
  if (!isPrWatchAvailable()) return () => undefined;
  void hydratePrWatches().catch(() => undefined);
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') void hydratePrWatches().catch(() => undefined);
    else if (event.type === 'openchamber:pr-watch.updated') {
      const { revision, sessionID, watch, watches } = event.properties;
      applyPrWatches(revision, sessionID, watches ?? (watch ? [watch] : []));
    }
  });
};

export const stopPrWatch = async (sessionID: string, url?: string): Promise<void> => {
  const previous = takePrWatches(sessionID, url);
  const response = await runtimeFetch(`/api/pr-watch/sessions/${encodeURIComponent(sessionID)}`, {
    method: 'DELETE',
    query: url === undefined ? undefined : { url },
  }).catch(() => null);
  if (response?.ok) return;
  if (previous) restorePrWatches(previous);
  await hydratePrWatches().catch(() => undefined);
  throw new Error(`Stopping the pull request watch failed (${response?.status ?? 'network'})`);
};
