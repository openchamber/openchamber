import { pluginModeFromId, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';

/** Close every context-panel tab of one guest in every project. Disable, remove, and a catalog that no longer lists the guest all end here. */
export const closeGuestTabsEverywhere = (mode: PluginContextPanelMode): void => {
  const ui = useUIStore.getState();
  for (const [directory, panel] of Object.entries(ui.contextPanelByDirectory)) {
    const tabIds = panel.tabs.filter((tab) => tab.mode === mode).map((tab) => tab.id);
    if (tabIds.length > 0) {
      ui.closeContextPanelTabs(directory, tabIds);
    }
  }
};

export const closeGuestTabsById = (guestId: string): void => closeGuestTabsEverywhere(pluginModeFromId(guestId));
