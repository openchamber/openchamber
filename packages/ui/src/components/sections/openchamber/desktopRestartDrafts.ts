import { create } from 'zustand';

import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';

/** Desktop settings that only apply on the next launch. */
type DesktopRestartPatch = Partial<Pick<DesktopSettings,
  'desktopLanAccessEnabled' | 'desktopUiPassword' | 'desktopMacMenuBarEnabled' | 'desktopLinuxNativeFrame'
>>;

type DraftOwner = 'app' | 'network';

type DraftState = {
  /** Each section's unsaved changes, or nothing when it has none. */
  patches: Partial<Record<DraftOwner, DesktopRestartPatch>>;
  /** A section whose changes cannot be saved as they are (LAN on without a password). */
  blocked: Partial<Record<DraftOwner, boolean>>;
  setDraft: (owner: DraftOwner, patch: DesktopRestartPatch | null, blocked: boolean) => void;
};

/**
 * The desktop app and network sections each hold changes that apply after a
 * restart, and each has its own "Save + restart". Either button restarts the
 * app, so it saves every section's pending changes in one write: a restart
 * from one section never drops what the user changed in the other.
 */
export const useDesktopRestartDrafts = create<DraftState>((set) => ({
  patches: {},
  blocked: {},
  setDraft: (owner, patch, blocked) => set((state) => ({
    patches: { ...state.patches, [owner]: patch ?? undefined },
    blocked: { ...state.blocked, [owner]: blocked },
  })),
}));

/** Every pending restart change, merged, or null when there is none. */
const collectDesktopRestartPatch = (): DesktopRestartPatch | null => {
  const { patches } = useDesktopRestartDrafts.getState();
  const merged = { ...patches.app, ...patches.network };
  return Object.keys(merged).length > 0 ? merged : null;
};

/** Saves every pending restart change in one write; resolves whether it was stored. */
export const saveDesktopRestartDrafts = async (): Promise<boolean> => {
  const patch = collectDesktopRestartPatch();
  if (!patch) return false;
  const result = await updateDesktopSettings(patch);
  return result.ok;
};
