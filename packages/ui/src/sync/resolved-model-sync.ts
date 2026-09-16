import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { applyResolvedModelUpdatedEvent, resyncResolvedModels } from '@/stores/resolvedModelStore';

/** Resolved-model events use the control SSE stream even while OpenCode uses WS. */
export const subscribeResolvedModelSync = (runtimeKey: string): (() => void) => (
  // VS Code is deliberately absent: its extension owns a separate OpenCode
  // lifecycle without the managed plugin, and subscribeOpenchamberEvents is a
  // documented no-op there — so no events arrive and the snapshot is never
  // fetched. The projection stays empty and the badge renders nothing.
  subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') {
      void resyncResolvedModels().catch(() => undefined);
    } else if (event.type === 'openchamber:resolved-model') {
      applyResolvedModelUpdatedEvent(event, runtimeKey);
    }
  })
);
