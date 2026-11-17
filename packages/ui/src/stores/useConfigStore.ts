import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDirectoryActivation } from './config/activation';
import { createAgentCatalog } from './config/agents';
import { createAgentSelection } from './config/agentSelection';
import { createConfigConnection } from './config/connection';
import { createDefaultSelection } from './config/defaultSelection';
import { createSettingsDefaults } from './config/defaults';
import { createInitialConfigState } from './config/initialState';
import { createMetadataActions } from './config/metadata';
import { createModelSelection } from './config/modelSelection';
import { configPersistence } from './config/persistence';
import { createProviderCatalog } from './config/providers';
import { createConfigGetters } from './config/selectors';
import { subscribeConfigRuntimeChanges, subscribeConfigStoreChanges } from './config/subscriptions';
import { type ConfigStore } from './config/types';
import { createVoiceSettings } from './config/voice';

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

export { invalidateConfigCatalogsForReload, markConfigCatalogStale } from './config/catalogLifecycle';
export { invalidateConfigAgentsLoad } from './config/catalogRequests';
export { resolveModelMetadata } from './config/metadata';
export {
    isStaleAutoSelection,
    selectCatalogLoadedForDirectory,
    selectConfigAgentsForDirectory,
    selectIsModelMissingFromCatalog,
    selectKnownAgent,
    selectKnownCatalogModel,
    selectProvidersForDirectory,
    selectSettingsOnlyProvidersForDirectory,
} from './config/selectors';
export type { InitFailure } from './config/types';
