import { create } from 'zustand';

import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

type GuestInstallRequest = { source: string; confirmed: boolean };

type GuestInstallRequestState = {
  request: (GuestInstallRequest & { isCurrent: () => boolean }) | null;
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

export const requestGuestInstall = (request: GuestInstallRequest): void => {
  useGuestInstallRequestStore.setState({ request: { ...request, isCurrent: captureRuntimeInstance() } });
  const ui = useUIStore.getState();
  ui.setSettingsPage('extensions');
  ui.setSettingsDialogOpen(true);
};
