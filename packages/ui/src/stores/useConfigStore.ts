import { subscribeConfigRuntimeChanges, subscribeConfigStoreChanges } from './config/subscriptions';
import { create } from 'zustand';
import { type ConfigStore } from './config/types';
import { devtools, persist } from 'zustand/middleware';
import { createInitialConfigState } from './config/initialState';
import { createVoiceSettings } from './config/voice';
import { createDirectoryActivation } from './config/activation';
import { createProviderCatalog } from './config/providers';
import { createModelSelection } from './config/modelSelection';
import { createSettingsDefaults } from './config/defaults';
import { createAgentCatalog } from './config/agents';
import { createMetadataActions } from './config/metadata';
import { createAgentSelection } from './config/agentSelection';
import { createDefaultSelection } from './config/defaultSelection';
import { createConfigConnection } from './config/connection';
import { createConfigGetters } from './config/selectors';
import { configPersistence } from './config/persistence';

subscribeConfigRuntimeChanges();

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({
                ...createInitialConfigState(set, get),
                ...createVoiceSettings(set, get),
                ...createDirectoryActivation(set, get),
                ...createProviderCatalog(set, get),
                ...createModelSelection(set, get),
                ...createSettingsDefaults(set, get),
                ...createAgentCatalog(set, get),
                ...createMetadataActions(set, get),
                ...createAgentSelection(set, get),
                ...createDefaultSelection(set, get),
                ...createConfigConnection(set, get),
                ...createConfigGetters(set, get),
            }),
            configPersistence,
        ),
    ),
);

subscribeConfigStoreChanges();
export { isStaleAutoSelection } from './config/selectionResolution';
export { resolveModelMetadata } from './config/metadata';
export { markConfigCatalogStale } from './config/catalogLifecycle';
export type { InitFailure } from './config/types';
export { invalidateConfigAgentsLoad } from './config/catalogLifecycle';
export { selectProvidersForDirectory } from './config/selectors';
export { selectIsModelMissingFromCatalog } from './config/selectors';
export { selectSettingsOnlyProvidersForDirectory } from './config/selectors';
export { selectConfigAgentsForDirectory } from './config/selectors';
export { selectKnownCatalogModel } from './config/selectors';
export { selectKnownAgent } from './config/selectors';
export { selectCatalogLoadedForDirectory } from './config/selectors';
export { invalidateConfigCatalogsForReload } from './config/catalogLifecycle';
