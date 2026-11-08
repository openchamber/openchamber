import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { applyPrWatch, applyPrWatchSnapshot, prWatchSnapshotSchema, restorePrWatch, takePrWatch } from './pr-watch';

/** VS Code has no OpenChamber server, so no agent there waits on a pull request. */
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
  // A wait this device only learned of now keeps a turn it never counted: the host knows its start.
  if (parsed.data.watches.length > 0) void seedGlobalSessionStatusFromHost().catch(() => undefined);
};

/**
 * Pull request watches ride the control SSE stream: read once at mount, again
 * after every reconnect of that stream, and kept by its updates in between.
 */
export const subscribePrWatchSync = (runtimeKey: string): (() => void) => {
  if (!isPrWatchAvailable()) return () => undefined;
  void hydratePrWatches().catch(() => undefined);
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') void hydratePrWatches().catch(() => undefined);
    else if (event.type === 'openchamber:pr-watch.updated') {
      applyPrWatch(event.properties.revision, event.properties.sessionID, event.properties.watch);
    }
  });
};

/** The user's "stop watching": the session is not woken. A refused request puts the row back. */
export const stopPrWatch = async (sessionID: string): Promise<void> => {
  const previous = takePrWatch(sessionID);
  const response = await runtimeFetch(`/api/pr-watch/sessions/${encodeURIComponent(sessionID)}`, { method: 'DELETE' }).catch(() => null);
  if (response?.ok) return;
  if (previous) restorePrWatch(previous);
  await hydratePrWatches().catch(() => undefined);
  throw new Error(`Stopping the pull request watch failed (${response?.status ?? 'network'})`);
};
