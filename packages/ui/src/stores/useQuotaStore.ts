import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS, type UsageSelectionId } from '@/lib/quota';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDefaultModels } from '@/lib/quota/model-families';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

const QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
let quotaAutoRefreshConsumers = 0;
let quotaAutoRefreshInterval: number | null = null;

interface QuotaSettingsState {
  displayMode: 'usage' | 'remaining';
  dropdownProviderIds: QuotaProviderId[];
  /** Configured providers the user removed from the Usage block (still configured elsewhere). */
  hiddenProviderIds: QuotaProviderId[];
  selectedModels: Record<string, string[]>;  // Map of providerId -> selected model names
  expandedFamilies: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
}

interface QuotaStore extends QuotaSettingsState {
  results: ProviderResult[];
  /** Quota IDs from GET /api/quota/providers (auth/credential configured). */
  authConfiguredProviderIds: QuotaProviderId[];
  /** null = Usage Overview; `__add_provider__` = add flow; otherwise a quota provider detail. */
  selectedProviderId: UsageSelectionId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;

  loadSettings: () => Promise<void>;
  fetchAuthConfiguredProviders: () => Promise<void>;
  fetchAllQuotas: () => Promise<void>;
  fetchQuotas: (providerIds: QuotaProviderId[]) => Promise<void>;
  fetchProviderQuota: (providerId: QuotaProviderId) => Promise<void>;
  setSelectedProvider: (providerId: UsageSelectionId | null) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  setHiddenProviderIds: (providerIds: QuotaProviderId[]) => void;
  hideUsageProvider: (providerId: QuotaProviderId) => void;
  showUsageProvider: (providerId: QuotaProviderId) => void;
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: string, availableModels: string[]) => void;
}

const parseSettings = (data: Record<string, unknown> | null): QuotaSettingsState => {
  const allProviderIds = QUOTA_PROVIDERS.map((provider) => provider.id);
  const displayMode = data?.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const rawDropdownProviders = Array.isArray(data?.usageDropdownProviders)
    ? data?.usageDropdownProviders
    : null;
  const dropdownProviderIds = rawDropdownProviders
    ? rawDropdownProviders.filter((entry): entry is QuotaProviderId =>
        typeof entry === 'string' && allProviderIds.includes(entry as QuotaProviderId)
      )
    : allProviderIds;

  const rawHiddenProviders = Array.isArray(data?.usageHiddenProviders)
    ? data?.usageHiddenProviders
    : null;
  const hiddenProviderIds = rawHiddenProviders
    ? rawHiddenProviders.filter((entry): entry is QuotaProviderId =>
        typeof entry === 'string' && allProviderIds.includes(entry as QuotaProviderId)
      )
    : [];

  // Parse selected models (providerId -> array of model names)
  const selectedModels: Record<string, string[]> = {};
  const rawSelectedModels = data?.usageSelectedModels;
  if (rawSelectedModels && typeof rawSelectedModels === 'object') {
    for (const [providerId, models] of Object.entries(rawSelectedModels)) {
      if (Array.isArray(models)) {
        selectedModels[providerId] = models.filter((m): m is string => typeof m === 'string');
      }
    }
  }

  // Parse expanded families (inverted collapsed logic for header dropdown)
  const expandedFamilies: Record<string, string[]> = {};
  const rawExpandedFamilies = data?.usageExpandedFamilies;
  if (rawExpandedFamilies && typeof rawExpandedFamilies === 'object') {
    for (const [providerId, families] of Object.entries(rawExpandedFamilies)) {
      if (Array.isArray(families)) {
        expandedFamilies[providerId] = families.filter((f): f is string => typeof f === 'string');
      }
    }
  }

  return {
    displayMode,
    dropdownProviderIds,
    hiddenProviderIds,
    selectedModels,
    expandedFamilies,
  };
};

const loadSettingsFromRuntime = async (): Promise<QuotaSettingsState> => {
  const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
  if (runtimeSettings) {
    try {
      const result = await runtimeSettings.load();
      const settings = result?.settings as Record<string, unknown> | undefined;
      return parseSettings(settings ?? null);
    } catch {
      // fall through
    }
  }

  if (!isVSCodeRuntime()) {
    const response = await runtimeFetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      return parseSettings(data as Record<string, unknown> | null);
    }
  }

  return {
    displayMode: 'usage',
    dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
    hiddenProviderIds: [],
    selectedModels: {},
    expandedFamilies: {},
  };
};

const parseAuthConfiguredProviderIds = (payload: unknown): QuotaProviderId[] => {
  const allProviderIds = new Set(QUOTA_PROVIDERS.map((provider) => provider.id));
  const providers = (payload as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers)) return [];
  return providers.filter((entry): entry is QuotaProviderId =>
    typeof entry === 'string' && allProviderIds.has(entry as QuotaProviderId)
  );
};

export const useQuotaStore = create<QuotaStore>()(
  devtools(
    (set, get) => ({
      results: [],
      authConfiguredProviderIds: [],
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      displayMode: 'usage',
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      hiddenProviderIds: [],
      selectedModels: {},
      expandedFamilies: {},

      loadSettings: async () => {
        try {
          const settings = await loadSettingsFromRuntime();
          set(settings);
        } catch (error) {
          console.warn('Failed to load usage settings:', error);
        }
      },

      fetchAuthConfiguredProviders: async () => {
        try {
          const response = await runtimeFetch('/api/quota/providers', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            // Keep last-known auth list; do not treat failure as "none configured".
            return;
          }
          const payload = await response.json().catch(() => null);
          set({ authConfiguredProviderIds: parseAuthConfiguredProviderIds(payload) });
        } catch (error) {
          console.warn('Failed to list configured quota providers:', error);
        }
      },

      fetchQuotas: async (providerIds) => {
        set({ isLoading: true, error: null });
        try {
          await Promise.all(
            providerIds.map((providerId) => get().fetchProviderQuota(providerId))
          );
          set({
            isLoading: false,
            lastUpdated: Date.now()
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch quotas';
          set({ isLoading: false, error: message });
        }
      },

      fetchAllQuotas: async () => {
        await get().fetchAuthConfiguredProviders();
        await get().fetchQuotas(QUOTA_PROVIDERS.map((provider) => provider.id));
      },

      fetchProviderQuota: async (providerId) => {
        set((state) => ({
          isFetchingProvider: { ...state.isFetchingProvider, [providerId]: true }
        }));
        try {
          const response = await runtimeFetch(`/api/quota/${encodeURIComponent(providerId)}`);
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(payload?.error || 'Failed to fetch quota');
          }

          const result = payload as ProviderResult;
          set((state) => {
            const next = state.results.filter((entry) => entry.providerId !== providerId);
            next.push(result);
            return { results: next, error: null };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch quota';
          const previous = get().results.find((entry) => entry.providerId === providerId);
          const authConfigured = get().authConfiguredProviderIds.includes(providerId);
          // Fetch failure must not erase an authoritative "configured" signal from
          // auth.json / managed credentials or a prior successful fetch.
          const fallback: ProviderResult = {
            providerId,
            providerName: previous?.providerName ?? providerId,
            ok: false,
            configured: Boolean(previous?.configured || authConfigured),
            error: message,
            usage: previous?.usage ?? null,
            fetchedAt: Date.now()
          };
          set((state) => {
            const next = state.results.filter((entry) => entry.providerId !== providerId);
            next.push(fallback);
            return { results: next, error: message };
          });
        } finally {
          set((state) => ({
            isFetchingProvider: { ...state.isFetchingProvider, [providerId]: false }
          }));
        }
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setDropdownProviderIds: (providerIds) => set({ dropdownProviderIds: providerIds }),
      setHiddenProviderIds: (providerIds) => set({ hiddenProviderIds: providerIds }),
      hideUsageProvider: (providerId) => {
        const next = Array.from(new Set([...get().hiddenProviderIds, providerId]));
        set({
          hiddenProviderIds: next,
          selectedProviderId: get().selectedProviderId === providerId ? null : get().selectedProviderId,
        });
        void updateDesktopSettings({ usageHiddenProviders: next });
      },
      showUsageProvider: (providerId) => {
        const next = get().hiddenProviderIds.filter((id) => id !== providerId);
        set({ hiddenProviderIds: next });
        void updateDesktopSettings({ usageHiddenProviders: next });
      },

      setSelectedModels: (providerId, modelNames) => {
        set((state) => ({
          selectedModels: { ...state.selectedModels, [providerId]: modelNames }
        }));
      },

      toggleModelSelected: (providerId, modelName) => {
        set((state) => {
          const currentSelected = state.selectedModels[providerId] ?? [];
          const isSelected = currentSelected.includes(modelName);
          const nextSelected = isSelected
            ? currentSelected.filter((m) => m !== modelName)
            : [...currentSelected, modelName];
          return {
            selectedModels: { ...state.selectedModels, [providerId]: nextSelected }
          };
        });
      },

      setExpandedFamilies: (providerId, familyIds) => {
        set((state) => ({
          expandedFamilies: { ...state.expandedFamilies, [providerId]: familyIds }
        }));
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      toggleFamilyExpanded: (providerId, familyId) => {
        set((state) => {
          const currentExpanded = state.expandedFamilies[providerId] ?? [];
          const isExpanded = currentExpanded.includes(familyId);
          const nextExpanded = isExpanded
            ? currentExpanded.filter((id) => id !== familyId)
            : [...currentExpanded, familyId];
          return {
            expandedFamilies: { ...state.expandedFamilies, [providerId]: nextExpanded }
          };
        });
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        // Only apply if no prior selections exist
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId as QuotaProviderId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        // Persist
        void updateDesktopSettings({ usageSelectedModels: get().selectedModels });
      },
    }),
    { name: 'quota-store' }
  )
);

export const useQuotaAutoRefresh = () => {
  React.useEffect(() => {
    quotaAutoRefreshConsumers += 1;
    if (quotaAutoRefreshInterval === null) {
      quotaAutoRefreshInterval = window.setInterval(() => {
        const { dropdownProviderIds, fetchQuotas } = useQuotaStore.getState();
        if (dropdownProviderIds.length > 0) {
          void fetchQuotas(dropdownProviderIds);
        }
      }, QUOTA_REFRESH_INTERVAL_MS);
    }

    return () => {
      quotaAutoRefreshConsumers -= 1;
      if (quotaAutoRefreshConsumers === 0 && quotaAutoRefreshInterval !== null) {
        window.clearInterval(quotaAutoRefreshInterval);
        quotaAutoRefreshInterval = null;
      }
    };
  }, []);
};
