import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import {
  applyExtensionWaits,
  applyExtensionWaitsSnapshot,
  extensionWaitsSnapshotSchema,
  restoreExtensionWaits,
  takeExtensionWaits,
} from './extension-waits';

/** VS Code has no OpenChamber server, so no agent there waits on an extension. */
const isExtensionWaitsAvailable = (): boolean => !isVSCodeRuntime();

const hydrateExtensionWaits = async (): Promise<void> => {
  if (!isExtensionWaitsAvailable()) return;
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch('/api/extension-waits', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Extension waits failed to load (${response.status})`);
  const parsed = extensionWaitsSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Invalid extension waits response');
  if (runtimeKey !== getRuntimeKey()) return;
  applyExtensionWaitsSnapshot(parsed.data);
  // A wait this device only learned of now keeps a turn it never counted: the host knows its start.
  if (parsed.data.waits.length > 0) void seedGlobalSessionStatusFromHost().catch(() => undefined);
};

/**
 * Extension waits ride the control SSE stream: read once at mount, again
 * after every reconnect of that stream, and kept by its updates in between.
 */
export const subscribeExtensionWaitsSync = (runtimeKey: string): (() => void) => {
  if (!isExtensionWaitsAvailable()) return () => undefined;
  void hydrateExtensionWaits().catch(() => undefined);
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') void hydrateExtensionWaits().catch(() => undefined);
    else if (event.type === 'openchamber:extension-waits.updated') {
      applyExtensionWaits(event.properties.revision, event.properties.sessionID, event.properties.waits);
    }
  });
};

/** The user's "stop waiting", for every wait of the session: none wakes it. A refused request puts the row back. */
export const stopExtensionWaits = async (sessionID: string): Promise<void> => {
  const previous = takeExtensionWaits(sessionID);
  const response = await runtimeFetch(`/api/extension-waits/sessions/${encodeURIComponent(sessionID)}`, { method: 'DELETE' }).catch(() => null);
  if (response?.ok) return;
  if (previous) restoreExtensionWaits(previous);
  await hydrateExtensionWaits().catch(() => undefined);
  throw new Error(`Stopping the extension waits failed (${response?.status ?? 'network'})`);
};
