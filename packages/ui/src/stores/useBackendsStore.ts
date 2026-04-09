import { create } from 'zustand';

export interface BackendCapabilities {
  chat: boolean;
  sessions: boolean;
  models: boolean;
  agents: boolean;
  providers: boolean;
  commands: boolean;
  config: boolean;
  skills: boolean;
}

export interface BackendDescriptor {
  id: string;
  label: string;
  available: boolean;
  comingSoon?: boolean;
  capabilities: BackendCapabilities;
}

interface BackendsState {
  backends: BackendDescriptor[];
  defaultBackendId: string;
  isLoaded: boolean;
  loadBackends: () => Promise<void>;
  getBackend: (id: string) => BackendDescriptor | undefined;
  hasCapability: (backendId: string, capability: keyof BackendCapabilities) => boolean;
  getBackendsWithCapability: (capability: keyof BackendCapabilities) => BackendDescriptor[];
}

let loadPromise: Promise<void> | null = null;

export const useBackendsStore = create<BackendsState>()((set, get) => ({
  backends: [],
  defaultBackendId: '',
  isLoaded: false,

  loadBackends: async () => {
    if (get().isLoaded) return;

    // Deduplicate concurrent loads
    if (loadPromise) {
      await loadPromise;
      return;
    }

    loadPromise = (async () => {
      try {
        const response = await fetch('/api/openchamber/backends', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!data) return;
        set({
          backends: Array.isArray(data.backends) ? data.backends : [],
          defaultBackendId: typeof data.defaultBackend === 'string' ? data.defaultBackend : '',
          isLoaded: true,
        });
      } catch {
        // Silently fail -- backends will remain empty
      }
    })();

    await loadPromise;
    loadPromise = null;
  },

  getBackend: (id: string) => {
    return get().backends.find((b) => b.id === id);
  },

  hasCapability: (backendId: string, capability: keyof BackendCapabilities) => {
    const backend = get().backends.find((b) => b.id === backendId);
    return Boolean(backend?.capabilities[capability]);
  },

  getBackendsWithCapability: (capability: keyof BackendCapabilities) => {
    return get().backends.filter((b) => b.available && b.capabilities[capability]);
  },
}));
