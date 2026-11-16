import { create } from 'zustand';

import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';

type DesktopRestartPatch = Partial<Pick<DesktopSettings,
  'desktopLanAccessEnabled' | 'desktopUiPassword' | 'desktopMacMenuBarEnabled' | 'desktopLinuxNativeFrame'
>>;

type DraftOwner = 'app' | 'network';

type DraftState = {
  patches: Partial<Record<DraftOwner, DesktopRestartPatch>>;
  blocked: Partial<Record<DraftOwner, boolean>>;
  setDraft: (owner: DraftOwner, patch: DesktopRestartPatch | null, blocked: boolean) => void;
};

export const useDesktopRestartDrafts = create<DraftState>((set) => ({
  patches: {},
  blocked: {},
  setDraft: (owner, patch, blocked) => set((state) => ({
    patches: { ...state.patches, [owner]: patch ?? undefined },
    blocked: { ...state.blocked, [owner]: blocked },
  })),
}));

const collectDesktopRestartPatch = (): DesktopRestartPatch | null => {
  const { patches } = useDesktopRestartDrafts.getState();
  const merged = { ...patches.app, ...patches.network };
  return Object.keys(merged).length > 0 ? merged : null;
};

export const saveDesktopRestartDrafts = async (): Promise<boolean> => {
  const patch = collectDesktopRestartPatch();
  if (!patch) return false;
  const result = await updateDesktopSettings(patch);
  return result.ok;
};
