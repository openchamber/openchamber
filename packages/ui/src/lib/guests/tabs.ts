import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { pluginModeFromId, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { isGuestInFolders, toGuestScopePaths } from './folders.ts';
import type { InstalledGuest } from './types.ts';

export const closeGuestTabsEverywhere = (mode: PluginContextPanelMode, keep?: (directory: string) => boolean): void => {
  const ui = useUIStore.getState();
  for (const [directory, panel] of Object.entries(ui.contextPanelByDirectory)) {
    if (keep?.(directory)) continue;
    const tabIds = panel.tabs.filter((tab) => tab.mode === mode).map((tab) => tab.id);
    if (tabIds.length > 0) {
      ui.closeContextPanelTabs(directory, tabIds);
    }
  }
};

export const closeGuestTabsById = (guestId: string): void => closeGuestTabsEverywhere(pluginModeFromId(guestId));

const closeGuestTabsOutside = (guest: InstalledGuest): void => {
  const { projects } = useProjectsStore.getState();
  const worktrees = useSessionUIStore.getState().availableWorktreesByProject;
  closeGuestTabsEverywhere(pluginModeFromId(guest.id), (directory) => {
    const project = resolveProjectForSessionDirectory(projects, worktrees, directory);
    return !project || isGuestInFolders(guest, toGuestScopePaths([directory, project.path]));
  });
};

export const closeGuestTabsOutsideChangedFolders = (previous: readonly InstalledGuest[], next: readonly InstalledGuest[]): void => {
  const before = new Map(previous.map((guest) => [guest.id, (guest.folders ?? []).join('\n')]));
  for (const guest of next) {
    const was = before.get(guest.id);
    if (was !== undefined && guest.folders?.length && was !== guest.folders.join('\n')) closeGuestTabsOutside(guest);
  }
};
