import type { OpenSurfaceOptions } from '@openchamber/sdk';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { openGuestSurfaceInContextWindow } from '@/lib/contextWindow/owner';
import { useContextWindowStore } from '@/lib/contextWindow/store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isGuestInFolders, useGuestScopeStore } from '@/lib/guests/folders';
import { guestPanelInstallationKey } from '@/lib/guests/item-store';
import { openGuestPanelItem, openGuestSurface, type GuestOpenSurfaceResult } from '@/lib/guests/open-surface';
import type { InstalledGuest } from '@/lib/guests/types';
import { isMiniChatWindow } from '@/lib/miniChatWindow';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { pluginModeFromId, type ContextPanelMode } from '@/lib/surfaces/modes';
import { zoneOfMode } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useRightSlotStore } from './rightSlot';

export const openGuestFrameSurface = (
  mode: ContextPanelMode,
  directory: string | null,
  guest: InstalledGuest,
  options?: OpenSurfaceOptions,
): GuestOpenSurfaceResult | Promise<GuestOpenSurfaceResult> => {
  const supported = !isVSCodeRuntime() && !(options && isMiniChatWindow());
  if (!options || !supported) return openGuestSurface({ mode, directory, supported });
  if (options.item !== undefined) {
    if (mode !== pluginModeFromId(guest.id)) {
      return { ok: false, code: 'HOST_REJECTED', message: 'An extension can only send items to its own panel.' };
    }
    if (!guest.entry || !isGuestInFolders(guest, useGuestScopeStore.getState().paths)) {
      return { ok: false, code: 'UNSUPPORTED', message: 'This extension has no panel here.' };
    }
  }
  const visibleDirectory = resolveEffectiveDirectory() ?? '';
  if (directory && normalizeContextPanelDirectoryKey(directory) !== normalizeContextPanelDirectoryKey(visibleDirectory)) {
    return { ok: false, code: 'UNSUPPORTED', message: 'The requested panel belongs to a chat or project outside the current view.' };
  }
  if (directory && useContextWindowStore.getState().detached) {
    return openGuestSurfaceInContextWindow(directory, options.tab !== undefined
      ? { tab: options.tab }
      : { guestId: guest.id, item: options.item, installationKey: guestPanelInstallationKey(guest) });
  }
  if (!isMobileSurfaceRuntime() && useRightSlotStore.getState().chatCovered
    && zoneOfMode(useUIStore.getState().contextSurfaceZones, mode) === 'bottom') {
    return { ok: false, code: 'UNSUPPORTED', message: 'The current page covers the requested panel.' };
  }
  return options.item === undefined
    ? openGuestSurface({ mode, directory, supported, options })
    : openGuestPanelItem(guest, directory, options.item);
};
