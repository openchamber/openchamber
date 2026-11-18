import { type CatalogKind } from '@/lib/opencode/events';
import { toConfigDirectoryKey, DIRECTORY_KEY_GLOBAL } from './directories';
import { type ConfigRuntimeContext, isConfigRuntimeContextCurrent } from './runtime';
import { type CachedCatalog, writeCachedCatalogWhenSettled } from '../configCatalogCache';
import { useConfigStore } from '../useConfigStore';
import { opencodeClient } from '@/lib/opencode/client';
import { _inFlightProviders, _inFlightAgents, _agentsLoadGeneration } from './catalogRequests';

export const _providersLoadedAt = new Map<string, number>();
export const _agentsLoadedAt = new Map<string, number>();
const CONFIG_REFRESH_TTL_MS = 30_000;

const ALL_DIRECTORIES = '*';
export const catalogLifecycle = { revision: 0, loadEpoch: 0 };
export const _providersStaleAt = new Map<string, number>();
export const _agentsStaleAt = new Map<string, number>();

const markCatalogStale = (loadedAt: Map<string, number>, staleAt: Map<string, number>, directoryKey: string | null): void => {
    catalogLifecycle.revision += 1;
    if (directoryKey === null) {
        loadedAt.clear();
        staleAt.set(ALL_DIRECTORIES, catalogLifecycle.revision);
        return;
    }
    loadedAt.delete(directoryKey);
    staleAt.set(directoryKey, catalogLifecycle.revision);
};

const isCatalogStaleSince = (staleAt: Map<string, number>, directoryKey: string, loadRevision: number): boolean =>
    Math.max(staleAt.get(directoryKey) ?? 0, staleAt.get(ALL_DIRECTORIES) ?? 0) > loadRevision;

export const markCatalogLoaded = (
    loadedAt: Map<string, number>,
    staleAt: Map<string, number>,
    directoryKey: string,
    loadRevision: number,
): void => {
    if (isCatalogStaleSince(staleAt, directoryKey, loadRevision)) return;
    loadedAt.set(directoryKey, Date.now());
};

export const markConfigCatalogStale = (kind: CatalogKind, directory: string | null): void => {
    const directoryKey = directory ? toConfigDirectoryKey(directory) : null;
    if (kind === 'provider' || kind === 'model' || kind === 'credential' || kind === 'config') {
        markCatalogStale(_providersLoadedAt, _providersStaleAt, directoryKey);
    }
    if (kind === 'agent' || kind === 'config') {
        markCatalogStale(_agentsLoadedAt, _agentsStaleAt, directoryKey);
    }
};
export const persistLoadedCatalog = (
    context: ConfigRuntimeContext,
    directoryKey: string,
    update: CachedCatalog,
    staleAt: Map<string, number>,
    loadRevision: number,
): void => {
    if (directoryKey === DIRECTORY_KEY_GLOBAL) return;
    writeCachedCatalogWhenSettled(
        context.runtimeKey,
        directoryKey,
        update,
        () => !isConfigRuntimeContextCurrent(context) || isCatalogStaleSince(staleAt, directoryKey, loadRevision),
    );
};

export const isConfigFresh = (loadedAt: Map<string, number>, key: string): boolean => {
    const at = loadedAt.get(key);
    return typeof at === 'number' && Date.now() - at < CONFIG_REFRESH_TTL_MS;
};

export const invalidateConfigCatalogsForReload = (
    kinds: readonly ("provider" | "agent")[],
): void => {
    catalogLifecycle.loadEpoch += 1;
    if (kinds.includes("provider")) {
        markConfigCatalogStale("provider", null);
        _inFlightProviders.clear();
        opencodeClient.clearProviderCatalogRequests();
    }
    if (kinds.includes("agent")) {
        markConfigCatalogStale("agent", null);
        _agentsLoadGeneration.clear();
        _inFlightAgents.clear();
        opencodeClient.clearAgentListRequests();
    }
    useConfigStore.setState((state) => ({ catalogReloadRevision: state.catalogReloadRevision + 1 }));
};
