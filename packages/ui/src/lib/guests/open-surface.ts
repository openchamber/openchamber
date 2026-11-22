import type { HostRequestErrorCode } from '@openchamber/sdk';

import { isPluginContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';
import { openMobileWorkspace, type MobileWorkspaceRequest } from '@/lib/mobileWorkspaceTabs';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { shownContextModes } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';

import { phoneGuestPanelModes } from './phone.ts';
import { useGuestsStore } from './store.ts';

export type GuestOpenSurfaceResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

type OpenGuestSurfaceOptions = {
  mode: ContextPanelMode;
  directory: string | null;
  supported: boolean;
};

const isShown = (directory: string, mode: ContextPanelMode): boolean => {
  const state = useUIStore.getState();
  return shownContextModes(state.contextPanelByDirectory[directory], state.contextSurfaceZones).has(mode);
};

const phoneTabFor = (mode: ContextPanelMode): MobileWorkspaceRequest | null => {
  if (isPluginContextPanelMode(mode)) {
    return phoneGuestPanelModes(useGuestsStore.getState().guests).includes(mode) ? { tab: mode } : null;
  }
  switch (mode) {
    case 'diff':
    case 'git':
      return { tab: 'changes' };
    case 'file':
      return { tab: 'files' };
    case 'terminal':
      return { tab: 'terminal' };
    case 'notes':
      return { tab: 'notes' };
    case 'browser':
      return isCapacitorApp() ? { tab: 'preview' } : null;
    default:
      return null;
  }
};

const openGuestSurfaceOnPhone = (mode: ContextPanelMode): GuestOpenSurfaceResult => {
  const request = phoneTabFor(mode);
  if (request && openMobileWorkspace(request)) return { ok: true };
  return { ok: false, code: 'UNSUPPORTED', message: 'That surface does not open on the phone.' };
};

export const openGuestSurface = ({ mode, directory, supported }: OpenGuestSurfaceOptions): GuestOpenSurfaceResult => {
  if (!supported) return { ok: false, code: 'UNSUPPORTED', message: 'This OpenChamber surface has no side panel.' };
  if (isMobileSurfaceRuntime()) return openGuestSurfaceOnPhone(mode);
  if (mode === 'workflows' && !selectWorkflowsShown(useUIStore.getState())) {
    return { ok: false, code: 'UNSUPPORTED', message: 'That surface cannot open here.' };
  }
  const key = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  if (!key) return { ok: false, code: 'NO_DIRECTORY', message: 'No chat or project is open.' };
  if (isShown(key, mode)) return { ok: true };
  useUIStore.getState().openContextSurface(key, mode);
  return isShown(key, mode)
    ? { ok: true }
    : { ok: false, code: 'UNSUPPORTED', message: 'That surface cannot open here.' };
};
