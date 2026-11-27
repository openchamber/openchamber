import type { GuestItem, HostRequestErrorCode, OpenSurfaceOptions } from '@openchamber/sdk';

import { resolveProjectContextOwner } from '@/hooks/useProjectContextOwner';
import { getChatsRoot } from '@/lib/chatDirectories';
import type { GuestSurfaceOpenRequest } from '@/lib/contextWindow/protocol';
import { contextWindowMatchesRuntime } from '@/lib/contextWindow/runtime';
import { useContextWindowStore } from '@/lib/contextWindow/store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceProjectDirectoryOf } from '@/lib/spaces/spaces-store';
import { isPluginContextPanelMode, pluginIdFromMode, pluginModeFromId, type ContextPanelMode } from '@/lib/surfaces/modes';
import { openMobileWorkspace, type MobileWorkspaceRequest } from '@/lib/mobileWorkspaceTabs';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { afterDelay } from '@/lib/timing/afterDelay';
import { shownContextModes } from '@/lib/workspace/zones';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { selectWorkflowsShown } from '@/lib/workflows/availability';

import { isGuestActive } from './capabilities.ts';
import { isGuestInFolders, toGuestScopePaths } from './folders.ts';
import { guestPanelInstallationKey, guestPanelItemOwner, requestGuestPanelItem, useGuestItemStore } from './item-store.ts';
import { phoneGuestPanelModes } from './phone.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

export type GuestOpenSurfaceResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

type OpenGuestSurfaceOptions = {
  mode: ContextPanelMode;
  directory: string | null;
  supported: boolean;
  options?: OpenSurfaceOptions;
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

const openGuestSurfaceOnDesktop = (mode: ContextPanelMode, directory: string | null): GuestOpenSurfaceResult => {
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

const projectKnowledgeOwner = (directory: string | null) => {
  const { projects, activeProjectId } = useProjectsStore.getState();
  const { availableWorktreesByProject, newSessionDraft } = useSessionUIStore.getState();
  return resolveProjectContextOwner({
    projects, activeProjectId, directory, worktreesByProject: availableWorktreesByProject,
    chatDraftOpen: newSessionDraft.open, chatDraftTarget: newSessionDraft.target, chatsRoot: getChatsRoot(),
  });
};

export const openGuestSurface = ({ mode, directory, supported, options }: OpenGuestSurfaceOptions): GuestOpenSurfaceResult => {
  if (!supported) return { ok: false, code: 'UNSUPPORTED', message: 'This OpenChamber surface has no side panel.' };
  const mobile = isMobileSurfaceRuntime();
  if (options?.tab !== undefined && (mobile || directory)
    && !projectKnowledgeOwner(useSessionUIStore.getState().currentSessionDirectory)) {
    return { ok: false, code: 'UNSUPPORTED', message: 'Project Knowledge has no tabs here.' };
  }
  const opened = mobile ? openGuestSurfaceOnPhone(mode) : openGuestSurfaceOnDesktop(mode, directory);
  if (!opened.ok) return opened;
  if (options?.tab !== undefined) useUIStore.getState().setProjectContextTab(options.tab);
  if (options?.item !== undefined && isPluginContextPanelMode(mode)) {
    useGuestItemStore.getState().setPendingItem(pluginIdFromMode(mode), options.item);
  }
  return opened;
};

export const openGuestPanelItem = (
  guest: InstalledGuest, directory: string | null, item: GuestItem, expiresAt?: number,
): GuestOpenSurfaceResult | Promise<GuestOpenSurfaceResult> => {
  const opened = openGuestSurface({ mode: pluginModeFromId(guest.id), directory, supported: true });
  if (!opened.ok) return opened;
  return requestGuestPanelItem(guest.id, item, guestPanelItemOwner(guest, directory), expiresAt).then((delivered) => delivered
    ? opened
    : { ok: false, code: 'HOST_UNAVAILABLE', message: 'The extension panel did not receive the item.' });
};

const waitForDetachedCatalog = (expiresAt: number): Promise<void> => {
  const pending = () => {
    const { status, runtimeKey } = useGuestsStore.getState();
    return runtimeKey !== getRuntimeKey() || status === 'idle' || status === 'loading';
  };
  if (!pending() || expiresAt <= Date.now()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      unsubscribe();
      cancelTimeout();
      resolve();
    };
    const unsubscribe = useGuestsStore.subscribe(() => { if (!pending()) finish(); });
    const cancelTimeout = afterDelay(expiresAt - Date.now(), finish);
  });
};

const followsRequest = (directory: string, runtimeKey: string): boolean => {
  const { followedDirectory } = useContextWindowStore.getState();
  return Boolean(followedDirectory && contextWindowMatchesRuntime(runtimeKey)
    && normalizeContextPanelDirectoryKey(directory) === normalizeContextPanelDirectoryKey(followedDirectory));
};

export const openDetachedGuestSurface = async (
  { directory, runtimeKey, destination, expiresAt }: GuestSurfaceOpenRequest,
): Promise<GuestOpenSurfaceResult> => {
  if (!followsRequest(directory, runtimeKey)) {
    return { ok: false, code: 'UNSUPPORTED', message: 'The detached panel no longer shows the requested project.' };
  }
  if ('tab' in destination) {
    return openGuestSurface({ mode: 'notes', directory, supported: true, options: { tab: destination.tab } });
  }
  const { guestId, item, installationKey } = destination;
  await waitForDetachedCatalog(expiresAt);
  if (!followsRequest(directory, runtimeKey)) {
    return { ok: false, code: 'UNSUPPORTED', message: 'The detached panel no longer shows the requested project.' };
  }
  const catalog = useGuestsStore.getState();
  if (Date.now() >= expiresAt || catalog.status !== 'ready' || catalog.runtimeKey !== getRuntimeKey()) {
    return { ok: false, code: 'HOST_UNAVAILABLE', message: 'The detached panel has not loaded its extensions.' };
  }
  const guest = catalog.guests.find((entry) => entry.id === guestId);
  const scope = toGuestScopePaths([directory, projectKnowledgeOwner(directory)?.path, spaceProjectDirectoryOf(directory)]);
  if (!guest?.entry || !isGuestActive(guest) || !isGuestInFolders(guest, scope) || guestPanelInstallationKey(guest) !== installationKey) {
    return { ok: false, code: 'UNSUPPORTED', message: 'This extension has no panel in the detached window.' };
  }
  return openGuestPanelItem(guest, directory, item, expiresAt);
};
