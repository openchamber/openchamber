import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useUIStore } from '@/stores/useUIStore';

export type MobileSettingsStage = 'nav' | 'page-content';

export const connectMobileSettingsNavigation = (
  visiblePages: readonly string[],
  openSettings: (stage: MobileSettingsStage) => void,
): (() => void) => {
  const openRequestedSettings = (): void => {
    const ui = useUIStore.getState();
    if (!ui.isSettingsDialogOpen) return;
    ui.setSettingsDialogOpen(false);
    openSettings(visiblePages.includes(resolveSettingsSlug(ui.settingsPage)) ? 'page-content' : 'nav');
  };
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (state.isSettingsDialogOpen && !previous.isSettingsDialogOpen) openRequestedSettings();
  });
  openRequestedSettings();
  return unsubscribe;
};
