import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { applyLaterPages, applyLaterPagesSnapshot, laterPagesSnapshotSchema } from './later-pages';

/** VS Code has no OpenChamber server, so no agent there shows a page. */
const isLaterPagesAvailable = (): boolean => !isVSCodeRuntime();

const hydrateLaterPages = async (): Promise<void> => {
  if (!isLaterPagesAvailable()) return;
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch('/api/openchamber/render/later', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Later pages failed to load (${response.status})`);
  const parsed = laterPagesSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Invalid later pages response');
  if (runtimeKey !== getRuntimeKey()) return;
  applyLaterPagesSnapshot(parsed.data);
};

/**
 * Later pages ride the control SSE stream: read once at mount, again after
 * every reconnect of that stream, and kept by its updates in between.
 */
export const subscribeLaterPagesSync = (runtimeKey: string): (() => void) => {
  if (!isLaterPagesAvailable()) return () => undefined;
  void hydrateLaterPages().catch(() => undefined);
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') void hydrateLaterPages().catch(() => undefined);
    else if (event.type === 'openchamber:render-later.updated') {
      applyLaterPages(event.properties.revision, event.properties.sessionID, event.properties.pages);
    }
  });
};
