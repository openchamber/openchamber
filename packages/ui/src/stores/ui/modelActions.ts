import type { UIStoreSlice } from './types';

const MAX_LAST_USED_EFFORTS = 512;

export const createModelActions: UIStoreSlice<
  | 'toggleFavoriteModel'
  | 'reorderFavoriteModel'
  | 'setProviderOrder'
  | 'setCustomProviderIcon'
  | 'setCustomProviderLogo'
  | 'toggleHiddenModel'
  | 'isHiddenModel'
  | 'hideAllModels'
  | 'showAllModels'
  | 'toggleModelProviderCollapsed'
  | 'setModelProvidersCollapsed'
  | 'isFavoriteModel'
  | 'addRecentModel'
  | 'setLastSelectedModel'
  | 'toggleFavoriteAgent'
  | 'addRecentAgent'
  | 'addRecentEffort'
  | 'rememberLastUsedEffort'
> = (set, get) => ({
  toggleFavoriteModel: (providerID, modelID) => {
    set((state) => {
      const exists = state.favoriteModels.some(
        (fav) => fav.providerID === providerID && fav.modelID === modelID
      );

      if (exists) {
        return {
          favoriteModels: state.favoriteModels.filter(
            (fav) => !(fav.providerID === providerID && fav.modelID === modelID)
          ),
        };
      } else {
        return {
          favoriteModels: [{ providerID, modelID }, ...state.favoriteModels],
        };
      }
    });
  },

  reorderFavoriteModel: (activeProviderID, activeModelID, overProviderID, overModelID) => {
    set((state) => {
      const oldIndex = state.favoriteModels.findIndex(
        (fav) => fav.providerID === activeProviderID && fav.modelID === activeModelID
      );
      const newIndex = state.favoriteModels.findIndex(
        (fav) => fav.providerID === overProviderID && fav.modelID === overModelID
      );

      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
        return state;
      }

      const nextFavorites = state.favoriteModels.slice();
      const [moved] = nextFavorites.splice(oldIndex, 1);
      if (!moved) {
        return state;
      }
      nextFavorites.splice(newIndex, 0, moved);
      return { favoriteModels: nextFavorites };
    });
  },

  setProviderOrder: (orderedProviderIDs) => {
    set((state) => {
      const next = orderedProviderIDs.filter((id) => typeof id === 'string' && id.length > 0);
      const current = state.providerOrder;
      if (current.length === next.length && current.every((id, index) => id === next[index])) {
        return state;
      }
      return { providerOrder: next };
    });
  },

  setCustomProviderIcon: (providerID, icon) => {
    const normalizedProviderID = providerID.trim();
    if (!normalizedProviderID) return;
    set((state) => {
      const next = { ...state.customProviderIcons };
      if (icon) next[normalizedProviderID] = icon;
      else delete next[normalizedProviderID];
      return { customProviderIcons: next };
    });
  },

  setCustomProviderLogo: (providerID, logo) => {
    const normalizedProviderID = providerID.trim();
    if (!normalizedProviderID) return;
    set((state) => {
      const next = { ...state.customProviderLogos };
      if (logo) next[normalizedProviderID] = logo;
      else delete next[normalizedProviderID];
      return { customProviderLogos: next };
    });
  },

  toggleHiddenModel: (providerID, modelID) => {
    set((state) => {
      const exists = state.hiddenModels.some(
        (item) => item.providerID === providerID && item.modelID === modelID
      );

      if (exists) {
        return {
          hiddenModels: state.hiddenModels.filter(
            (item) => !(item.providerID === providerID && item.modelID === modelID)
          ),
        };
      }

      return {
        hiddenModels: [{ providerID, modelID }, ...state.hiddenModels],
      };
    });
  },

  isHiddenModel: (providerID, modelID) => {
    const { hiddenModels } = get();
    return hiddenModels.some(
      (item) => item.providerID === providerID && item.modelID === modelID
    );
  },

  hideAllModels: (providerID, modelIDs) => {
    set((state) => {
      const current = state.hiddenModels.filter((item) => item.providerID !== providerID);
      const additions = modelIDs
        .filter((modelID) => typeof modelID === 'string' && modelID.length > 0)
        .map((modelID) => ({ providerID, modelID }));
      return { hiddenModels: [...additions, ...current] };
    });
  },

  showAllModels: (providerID) => {
    set((state) => ({
      hiddenModels: state.hiddenModels.filter((item) => item.providerID !== providerID),
    }));
  },

  toggleModelProviderCollapsed: (providerID) => {
    const normalizedProviderID = typeof providerID === 'string' ? providerID.trim() : '';
    if (!normalizedProviderID) {
      return;
    }

    set((state) => {
      const isCollapsed = state.collapsedModelProviders.includes(normalizedProviderID);
      if (isCollapsed) {
        return {
          collapsedModelProviders: state.collapsedModelProviders.filter((id) => id !== normalizedProviderID),
        };
      }

      return {
        collapsedModelProviders: [...state.collapsedModelProviders, normalizedProviderID],
      };
    });
  },

  setModelProvidersCollapsed: (providerIDs, collapsed) => {
    const normalizedProviderIDs = Array.from(new Set(
      providerIDs
        .filter((providerID): providerID is string => typeof providerID === 'string')
        .map((providerID) => providerID.trim())
        .filter(Boolean)
    ));

    if (normalizedProviderIDs.length === 0) {
      return;
    }

    set((state) => {
      const scopedProviderIDs = new Set(normalizedProviderIDs);
      const untouchedProviders = state.collapsedModelProviders.filter((providerID) => !scopedProviderIDs.has(providerID));

      return {
        collapsedModelProviders: collapsed
          ? [...untouchedProviders, ...normalizedProviderIDs]
          : untouchedProviders,
      };
    });
  },

  isFavoriteModel: (providerID, modelID) => {
    const { favoriteModels } = get();
    return favoriteModels.some(
      (fav) => fav.providerID === providerID && fav.modelID === modelID
    );
  },

  addRecentModel: (providerID, modelID) => {
    set((state) => {
      const filtered = state.recentModels.filter(
        (m) => !(m.providerID === providerID && m.modelID === modelID)
      );
      return {
        recentModels: [{ providerID, modelID }, ...filtered].slice(0, 5),
      };
    });
  },

  setLastSelectedModel: (providerID, modelID) => {
    const next = `${providerID}/${modelID}`;
    if (get().lastSelectedModel === next) return;
    set({ lastSelectedModel: next });
  },

  toggleFavoriteAgent: (agentName) => {
    const normalized = agentName.trim();
    if (!normalized) return;
    set((state) => ({
      favoriteAgents: state.favoriteAgents.includes(normalized)
        ? state.favoriteAgents.filter((name) => name !== normalized)
        : [...state.favoriteAgents, normalized],
    }));
  },

  addRecentAgent: (agentName) => {
    const normalized = typeof agentName === 'string' ? agentName.trim() : '';
    if (!normalized) {
      return;
    }
    set((state) => {
      if (state.recentAgents.includes(normalized)) {
        return state;
      }
      const filtered = state.recentAgents;
      return {
        recentAgents: [normalized, ...filtered].slice(0, 5),
      };
    });
  },

  addRecentEffort: (providerID, modelID, variant) => {
    const provider = providerID.trim();
    const model = modelID.trim();
    if (!provider || !model) {
      return;
    }
    const key = `${provider}/${model}`;
    const normalizedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant.trim() : 'default';
    set((state) => {
      const current = state.recentEfforts[key] ?? [];
      if (current.includes(normalizedVariant)) {
        return state;
      }
      const filtered = current;
      return {
        recentEfforts: {
          ...state.recentEfforts,
          [key]: [normalizedVariant, ...filtered].slice(0, 5),
        },
      };
    });
  },

  rememberLastUsedEffort: (providerID, modelID, variant) => {
    const provider = typeof providerID === 'string' ? providerID.trim() : '';
    const model = typeof modelID === 'string' ? modelID.trim() : '';
    if (!provider || !model) {
      return;
    }
    const key = `${provider}/${model}`;
    const normalizedVariant = variant?.trim() || null;
    set((state) => {
      if (state.lastUsedEfforts[key] === normalizedVariant) {
        return state;
      }
      const entries = Object.entries(state.lastUsedEfforts).filter(([entryKey]) => entryKey !== key);
      entries.push([key, normalizedVariant]);
      return {
        lastUsedEfforts: Object.fromEntries(entries.slice(-MAX_LAST_USED_EFFORTS)),
      };
    });
  },
});
