import { create } from 'zustand';

import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

/** `confirmed` skips the add dialog; the approval dialog still decides what the package may do. */
type GuestInstallRequest = { source: string; confirmed: boolean };

type GuestInstallRequestState = {
  request: (GuestInstallRequest & { isCurrent: () => boolean }) | null;
  /** Hands the request over once: a request made on another server is dropped, since a path means nothing there. */
  take: () => GuestInstallRequest | null;
};

export const useGuestInstallRequestStore = create<GuestInstallRequestState>((set, get) => ({
  request: null,
  take: () => {
    const { request } = get();
    if (!request) return null;
    set({ request: null });
    return request.isCurrent() ? { source: request.source, confirmed: request.confirmed } : null;
  },
}));

/** Settings → Extensions takes it from here, whatever opened it. */
export const requestGuestInstall = (request: GuestInstallRequest): void => {
  useGuestInstallRequestStore.setState({ request: { ...request, isCurrent: captureRuntimeInstance() } });
  const ui = useUIStore.getState();
  ui.setSettingsPage('extensions');
  ui.setSettingsDialogOpen(true);
};
