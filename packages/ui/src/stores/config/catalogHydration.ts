import { DIRECTORY_KEY_GLOBAL } from './directories';
import { captureConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { readCachedCatalog } from '../configCatalogCache';
import { useConfigStore } from '../useConfigStore';
import { createEmptyDirectoryScopedConfig } from './directorySnapshots';
import { markStartupTrace } from '@/lib/startupTrace';
import { type DirectoryScopedConfig } from './types';
import { ensureDisabledProviders } from '@/lib/disabledProviders';

export const hydrateConfigCatalogFromCache = async (directoryKey: string): Promise<void> => {
    if (directoryKey === DIRECTORY_KEY_GLOBAL) return;
    const context = captureConfigRuntimeContext();
    const cached = await readCachedCatalog(context.runtimeKey, directoryKey);
    if (!cached || !isConfigRuntimeContextCurrent(context)) return;
    const disabledProviders = await ensureDisabledProviders();
    if (!isConfigRuntimeContextCurrent(context)) return;
    const disabledProviderIds = disabledProviders && disabledProviders.length > 0 ? new Set(disabledProviders) : null;
    useConfigStore.setState((state) => {
        const snapshot = state.directoryScoped[directoryKey] ?? createEmptyDirectoryScopedConfig();
        const isActive = state.activeDirectoryKey === directoryKey;
        const providersLive = snapshot.providersLoaded === true || snapshot.providers.length > 0
            || (isActive && (state.providersLoaded || state.providers.length > 0));
        const agentsLive = snapshot.agentsLoaded === true || snapshot.agents.length > 0
            || (isActive && (state.agentsLoaded || state.agents.length > 0));
        // The cache can predate a provider being turned off; the disabled
        // list read for this runtime applies to it the same way it applies
        // to a live catalog.
        const providers = !providersLive && cached.providers?.length
            ? (disabledProviderIds ? cached.providers.filter((provider) => !disabledProviderIds.has(provider.id)) : cached.providers)
            : null;
        const agents = !agentsLive && cached.agents?.length ? cached.agents : null;
        if (!providers && !agents) return state;
        markStartupTrace('configCatalogCache:hydrated', { directoryKey, providers: providers?.length ?? 0, agents: agents?.length ?? 0 });
        const defaultProviders = providers && cached.defaultProviders ? cached.defaultProviders : snapshot.defaultProviders;
        const nextSnapshot: DirectoryScopedConfig = {
            ...snapshot,
            ...(providers ? { providers, defaultProviders } : {}),
            ...(agents ? { agents } : {}),
        };
        return {
            directoryScoped: { ...state.directoryScoped, [directoryKey]: nextSnapshot },
            ...(isActive && providers ? { providers, defaultProviders } : {}),
            ...(isActive && agents ? { agents } : {}),
        };
    });
};
