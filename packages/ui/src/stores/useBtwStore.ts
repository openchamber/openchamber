import { create } from 'zustand';

/**
 * UI-only state for the `/btw` peek panel.
 *
 * The panel's identity is NOT stored here: it is derived from session
 * metadata (`openchamber.btwSessionID` on the parent — see
 * `sessionBtwMetadata`), so the panel appears only in the session `/btw` was
 * typed into and survives reloads. This store keeps only transient
 * per-parent presentation state that has no authoritative home:
 *
 * - `collapsed`: the panel is minimized to the composer chip; the composer
 *   talks to the main session again until it is expanded.
 * - `creating`: `/btw` is between submit and the parent-metadata link
 *   landing, so the panel can show its starting state immediately.
 * - `destroying`: close was clicked; hides the panel optimistically while the
 *   unlink/delete round-trip completes.
 */
type BtwPanelUIState = {
  collapsed?: boolean;
  creating?: boolean;
  destroying?: boolean;
};

type BtwStore = {
  byParent: Record<string, BtwPanelUIState>;
  setPanelState: (parentSessionId: string, patch: BtwPanelUIState) => void;
  clearPanelState: (parentSessionId: string) => void;
};

export const useBtwStore = create<BtwStore>()((set) => ({
  byParent: {},
  setPanelState: (parentSessionId, patch) =>
    set((state) => ({
      byParent: {
        ...state.byParent,
        [parentSessionId]: { ...state.byParent[parentSessionId], ...patch },
      },
    })),
  clearPanelState: (parentSessionId) =>
    set((state) => {
      if (!(parentSessionId in state.byParent)) return state;
      const byParent = { ...state.byParent };
      delete byParent[parentSessionId];
      return { byParent };
    }),
}));
