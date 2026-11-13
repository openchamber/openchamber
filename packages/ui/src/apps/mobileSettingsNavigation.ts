import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useUIStore } from '@/stores/useUIStore';

export type MobileSettingsStage = 'nav' | 'page-content';

/**
 * The phone shows Settings as a fullscreen surface and never renders the
 * Settings dialog. Shared entry points still ask for the dialog, so a request
 * opens the surface: on the requested page when the phone shows it, otherwise
 * on the page list.
 */
export const connectMobileSettingsNavigation = (
  visiblePages: readonly string[],
  openSettings: (stage: MobileSettingsStage) => void,
): (() => void) => {
  const openRequestedSettings = (): void => {
    const ui = useUIStore.getState();
    if (!ui.isSettingsDialogOpen) return;
    // This flag belongs to the dialog. Leaving it set blocks chat shortcuts.
    ui.setSettingsDialogOpen(false);
    openSettings(visiblePages.includes(resolveSettingsSlug(ui.settingsPage)) ? 'page-content' : 'nav');
  };
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (state.isSettingsDialogOpen && !previous.isSettingsDialogOpen) openRequestedSettings();
  });
  openRequestedSettings();
  return unsubscribe;
};
