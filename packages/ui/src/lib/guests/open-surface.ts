import type { HostRequestErrorCode } from '@openchamber/sdk';

import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { shownContextModes } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

export type GuestOpenSurfaceResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

type OpenGuestSurfaceOptions = {
  mode: ContextPanelMode;
  /** The panel's directory, the same key the rail opens it under; null before the app knows one. */
  directory: string | null;
  /** VS Code and mobile have no context panel for guests. */
  supported: boolean;
};

const isShown = (directory: string, mode: ContextPanelMode): boolean => {
  const state = useUIStore.getState();
  return shownContextModes(state.contextPanelByDirectory[directory], state.contextSurfaceZones).has(mode);
};

/**
 * `host.openSurface`: open the surface the way its rail icon does, and answer
 * by what the panel shows afterwards. A surface already on screen stays open:
 * the rail toggles it closed, the SDK call only ever opens.
 */
export const openGuestSurface = ({ mode, directory, supported }: OpenGuestSurfaceOptions): GuestOpenSurfaceResult => {
  if (!supported) return { ok: false, code: 'UNSUPPORTED', message: 'This OpenChamber surface has no side panel.' };
  // A build without workflows answers as for any surface it does not have, so the name stays unknown.
  if (mode === 'workflows' && !useUIStore.getState().agentWorkflowFeatureAvailable) {
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
