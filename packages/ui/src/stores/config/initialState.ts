import { type ConfigSlice } from './types';
import { resolveInitialDirectoryKey } from './directories';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { type ModelMetadata } from '@/types';

export const createInitialConfigState: ConfigSlice<
    | 'activeDirectoryKey'
    | 'directoryScoped'
    | 'configRuntimeKey'
    | 'catalogReloadRevision'
    | 'providers'
    | 'agents'
    | 'providersLoaded'
    | 'agentsLoaded'
    | 'currentProviderId'
    | 'currentModelId'
    | 'currentVariant'
    | 'currentVariantSelection'
    | 'currentAgentName'
    | 'selectedProviderId'
    | 'agentModelSelections'
    | 'defaultProviders'
    | 'selectionSource'
    | 'agentSelectionSource'
    | 'isConnected'
    | 'hasEverConnected'
    | 'connectionPhase'
    | 'lastDisconnectReason'
    | 'lastInitFailure'
    | 'projectConfigErrors'
    | 'settingsOnlyProviders'
    | 'isInitialized'
    | 'modelsMetadata'
    | 'settingsDefaultModel'
    | 'settingsDefaultsLoaded'
    | 'settingsDefaultVariant'
    | 'settingsDefaultAgent'
    | 'chatsDefaultModel'
    | 'chatsDefaultVariant'
    | 'chatsDefaultAgent'
    | 'opencodeDefaultAgent'
    | 'opencodeDefaultModel'
    | 'settingsAutoCreateWorktree'
    | 'settingsGitmojiEnabled'
    | 'settingsDefaultFileViewerPreview'
    | 'settingsZenModel'
    | 'settingsMessageStreamTransport'
> = () => ({
    activeDirectoryKey: resolveInitialDirectoryKey(),
    directoryScoped: {},
    configRuntimeKey: getRuntimeKey(),
    catalogReloadRevision: 0,

    providers: [],
    agents: [],
    providersLoaded: false,
    agentsLoaded: false,
    currentProviderId: "",
    currentModelId: "",
    currentVariant: undefined,
    currentVariantSelection: { override: undefined, inherited: undefined },
    currentAgentName: undefined,
    selectedProviderId: "",
    agentModelSelections: {},
    defaultProviders: {},
    selectionSource: "auto",
    agentSelectionSource: "auto",
    isConnected: false,
    hasEverConnected: false,
    connectionPhase: "connecting",
    lastDisconnectReason: null,
    lastInitFailure: null,
    projectConfigErrors: {},
    settingsOnlyProviders: {},
    isInitialized: false,
    modelsMetadata: new Map<string, ModelMetadata>(),
    settingsDefaultModel: undefined,
    settingsDefaultsLoaded: false,
    settingsDefaultVariant: undefined,
    settingsDefaultAgent: undefined,
    chatsDefaultModel: undefined,
    chatsDefaultVariant: undefined,
    chatsDefaultAgent: undefined,
    opencodeDefaultAgent: undefined,
    opencodeDefaultModel: undefined,
    settingsAutoCreateWorktree: false,
    settingsGitmojiEnabled: false,
    settingsDefaultFileViewerPreview: true,
    settingsZenModel: undefined,
    settingsMessageStreamTransport: 'auto',
});
