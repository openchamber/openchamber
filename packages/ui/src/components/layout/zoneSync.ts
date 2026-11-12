import { z } from 'zod';
import { isContextPanelMode } from '@/lib/surfaces/modes';
import { zonePlacementSchema, zoneOfMode, type ContextZonePlacement } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

const UI_STORE_KEY = 'ui-store';

// A save without the field (an older build in another window) says nothing
// about placement; it must not read as "everything back on the right".
const persistedPlacementSchema = z.object({
  state: z.object({ contextSurfaceZones: z.record(z.string(), z.unknown()) }),
});

/** The placement another window saved, or null when the value carries none. */
export const readPersistedZonePlacement = (raw: string | null): ContextZonePlacement | null => {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = persistedPlacementSchema.safeParse(json);
  return parsed.success ? zonePlacementSchema.parse(parsed.data.state.contextSurfaceZones) : null;
};

/**
 * Adopts surface moves made in another window of this app. Without it, this
 * window's next save writes its older placement back over the move. Only the
 * placement is shared: each window keeps what it has open.
 */
export const followZonePlacementOfOtherWindows = (): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== UI_STORE_KEY) return;
    const incoming = readPersistedZonePlacement(event.newValue);
    if (!incoming) return;
    const current = useUIStore.getState().contextSurfaceZones;
    const modes = new Set([...Object.keys(current), ...Object.keys(incoming)].filter(isContextPanelMode));
    for (const mode of modes) {
      const zone = zoneOfMode(incoming, mode);
      if (zone !== zoneOfMode(useUIStore.getState().contextSurfaceZones, mode)) {
        useUIStore.getState().moveContextSurfaceToZone(mode, zone);
      }
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
};
