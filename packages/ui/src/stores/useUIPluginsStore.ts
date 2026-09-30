import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getComposerStatusContributions,
  parseUIPluginManifest,
  type OpenChamberUIPluginManifestV1,
  type ComposerStatusContribution,
} from '@/lib/uiPlugins';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type UIPluginCatalogResponse = { plugins?: unknown };
let catalogLoadGeneration = 0;

interface UIPluginsStore {
  catalog: OpenChamberUIPluginManifestV1[];
  disabledPluginIds: string[];
  isLoading: boolean;
  loadError: boolean;
  loadCatalog: () => Promise<boolean>;
  setPluginEnabled: (pluginId: string, enabled: boolean) => void;
}

export const isUIPluginEnabled = (state: Pick<UIPluginsStore, 'disabledPluginIds'>, pluginId: string): boolean =>
  !Array.isArray(state.disabledPluginIds) || !state.disabledPluginIds.includes(pluginId);

export const findEnabledComposerStatusContributions = (
  state: Pick<UIPluginsStore, 'catalog' | 'disabledPluginIds'>,
): ComposerStatusContribution[] => getComposerStatusContributions(
  state.catalog.filter((plugin) => isUIPluginEnabled(state, plugin.id)),
);

export const useUIPluginsStore = create<UIPluginsStore>()(
  devtools(
    persist(
      (set) => ({
        catalog: [],
        disabledPluginIds: [],
        isLoading: false,
        loadError: false,
        loadCatalog: async () => {
          const generation = ++catalogLoadGeneration;
          set({ isLoading: true });
          try {
            const response = await runtimeFetch('/api/ui-plugins/catalog');
            if (!response.ok) throw new Error(`UI plugin catalog failed (${response.status})`);
            const payload = await response.json() as UIPluginCatalogResponse;
            if (!Array.isArray(payload.plugins)) throw new Error('Invalid UI plugin catalog');
            const catalog = payload.plugins.map(parseUIPluginManifest);
            const ids = new Set<string>();
            for (const plugin of catalog) {
              if (ids.has(plugin.id)) throw new Error(`Duplicate UI plugin: ${plugin.id}`);
              ids.add(plugin.id);
            }
            if (generation !== catalogLoadGeneration) return false;
            set({ catalog, isLoading: false, loadError: false });
            return true;
          } catch (error) {
            console.error('[UIPluginsStore] Failed to load catalog:', error);
            if (generation !== catalogLoadGeneration) return false;
            set({ isLoading: false, loadError: true });
            return false;
          }
        },
        setPluginEnabled: (pluginId, enabled) => set((state) => ({
          disabledPluginIds: enabled
            ? state.disabledPluginIds.filter((id) => id !== pluginId)
            : Array.from(new Set([...state.disabledPluginIds, pluginId])),
        })),
      }),
      {
        name: 'ui-plugins-store',
        version: 1,
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({ disabledPluginIds: state.disabledPluginIds }),
        merge: (persisted, current) => {
          const candidate = (persisted as { disabledPluginIds?: unknown } | null)?.disabledPluginIds;
          return {
            ...current,
            disabledPluginIds: Array.isArray(candidate)
              ? Array.from(new Set(candidate.filter((id): id is string => typeof id === 'string')))
              : [],
          };
        },
      },
    ),
    { name: 'ui-plugins-store' },
  ),
);
