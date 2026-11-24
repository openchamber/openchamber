import { type Model, type Provider, type Agent, type Config } from '@/lib/opencode/model';
import { type ProjectConfigError } from '@/lib/opencode/configError';
import { type ModelMetadata } from '@/types';
import { type VoiceApiKeyState, type VoiceApiKeyKind } from '@/lib/voiceKeysApi';
import { type UseBoundStore, type StoreApi } from 'zustand';

export type ProviderModel = Model;
export type ProviderWithModelList = Provider & { models: Model[] };

export type ProviderModelSelection = { providerId: string; modelId: string; variant?: string | null } | null;

export type DefaultAgentModelSelection = {
    agentName: string | undefined;
    providerId?: string;
    modelId?: string;
    variant?: string | null;
};

type DirectoryDefaultSelection = {
    agentName: string | undefined;
    providerId: string;
    modelId: string;
    variant?: string | null;
};

export interface DirectoryScopedConfig {
    providersLoaded?: boolean;
    agentsLoaded?: boolean;

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant?: string | undefined;
    currentVariantSelection?: CurrentVariantSelection;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    selectionSource?: "auto" | "manual";
    agentSelectionSource?: "auto" | "manual";
}

export type CurrentVariantSelection = {
    override: string | null | undefined;
    inherited: string | null | undefined;
};

export interface ConfigStore {

    activeDirectoryKey: string;
    directoryScoped: Record<string, DirectoryScopedConfig>;
    configRuntimeKey: string;
    catalogReloadRevision: number;

    providers: ProviderWithModelList[];
    agents: Agent[];
    providersLoaded: boolean;
    agentsLoaded: boolean;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentVariantSelection: CurrentVariantSelection;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    selectionSource: "auto" | "manual";
    agentSelectionSource: "auto" | "manual";
    isConnected: boolean;
    hasEverConnected: boolean;
    connectionPhase: "connecting" | "connected" | "reconnecting";
    lastDisconnectReason: string | null;
    lastInitFailure: InitFailure | null;
    projectConfigErrors: Record<string, ProjectConfigError>;
    settingsOnlyProviders: Record<string, ProviderWithModelList[]>;
    isInitialized: boolean;
    modelsMetadata: Map<string, ModelMetadata>;
    settingsDefaultModel: string | undefined;
    settingsDefaultsLoaded: boolean;
    settingsDefaultVariant: string | undefined;
    settingsDefaultAgent: string | undefined;
    chatsDefaultModel: string | undefined;
    chatsDefaultVariant: string | undefined;
    chatsDefaultAgent: string | undefined;
    opencodeDefaultAgent: string | undefined;
    opencodeDefaultModel: string | undefined;
    settingsAutoCreateWorktree: boolean;
    settingsGitmojiEnabled: boolean;
    settingsDefaultFileViewerPreview: boolean;
    settingsZenModel: string | undefined;
    settingsMessageStreamTransport: 'auto' | 'ws' | 'sse';
    voiceProvider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say';
    setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => void;
    speechRate: number;
    speechPitch: number;
    speechVolume: number;
    sayVoice: string;
    browserVoice: string;
    localTtsVoiceId: number;
    localTtsModelId: string;
    ttsFollowTextLanguage: boolean;
    openaiVoice: string;
    voiceApiKeys: VoiceApiKeyState;
    openaiCompatibleUrl: string;
    openaiCompatibleVoice: string;
    openaiCompatibleTtsModel: string;
    openaiCompatibleTtsEndpointPath: string;
    dictationEnabled: boolean;
    dictationAutoSend: boolean;
    sttProvider: 'local' | 'openai-compatible';
    sttServerUrl: string;
    sttModel: string;
    sttEndpointPath: string;
    sttLocalModel: string;
    sttLanguage: string;
    sttCorrectTranscript: boolean;
    showMessageTTSButtons: boolean;
    autoReadAloudEnabled: boolean;
    ttsInputMode: 'sanitized' | 'raw' | 'summarized';
    ttsChunkedMode: boolean;
    summarizeMessageTTS: boolean;
    summarizeVoiceConversation: boolean;
    summarizeCharacterThreshold: number;
    summarizeMaxLength: number;
    setSpeechRate: (rate: number) => void;
    setSpeechPitch: (pitch: number) => void;
    setSpeechVolume: (volume: number) => void;
    setSayVoice: (voice: string) => void;
    setBrowserVoice: (voice: string) => void;
    setLocalTtsVoiceId: (voiceId: number) => void;
    setLocalTtsModelId: (modelId: string) => void;
    setTtsFollowTextLanguage: (enabled: boolean) => void;
    setOpenaiVoice: (voice: string) => void;
    setVoiceApiKey: (kind: VoiceApiKeyKind, apiKey: string | null, speechServer?: string | null) => Promise<boolean>;
    refreshVoiceApiKeys: (options?: { force?: boolean }) => Promise<void>;
    setOpenaiCompatibleUrl: (url: string) => void;
    setOpenaiCompatibleVoice: (voice: string) => void;
    setOpenaiCompatibleTtsModel: (model: string) => void;
    setOpenaiCompatibleTtsEndpointPath: (path: string) => void;
    setDictationEnabled: (enabled: boolean) => void;
    setDictationAutoSend: (enabled: boolean) => void;
    setSttProvider: (provider: 'local' | 'openai-compatible') => void;
    setSttServerUrl: (url: string) => void;
    setSttModel: (model: string) => void;
    setSttEndpointPath: (path: string) => void;
    setSttLocalModel: (model: string) => void;
    setSttLanguage: (lang: string) => void;
    setSttCorrectTranscript: (enabled: boolean) => void;
    setShowMessageTTSButtons: (show: boolean) => void;
    setAutoReadAloudEnabled: (enabled: boolean) => void;
    setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => void;
    setTtsChunkedMode: (enabled: boolean) => void;
    setSummarizeMessageTTS: (enabled: boolean) => void;
    setSummarizeVoiceConversation: (enabled: boolean) => void;
    setSummarizeCharacterThreshold: (threshold: number) => void;
    setSummarizeMaxLength: (maxLength: number) => void;

    activateDirectory: (directory: string | null | undefined, options?: { preserveManualModel?: boolean }) => Promise<void>;

    loadProviders: (options?: { directory?: string | null; source?: string; fresh?: boolean }) => Promise<void>;
    loadSessionDefaults: () => Promise<boolean>;
    loadAgents: (options?: { directory?: string | null; source?: string; fresh?: boolean }) => Promise<boolean>;
    invalidateModelMetadataCache: () => void;
    invalidateProviderCache: (directory?: string | null) => void;
    setProvider: (providerId: string) => void;
    setModel: (modelId: string) => void;
    followModel: (providerId: string, modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
    setCurrentVariantOverride: (override: string | null | undefined, inherited: string | null | undefined) => void;
    cycleCurrentVariant: () => string | undefined;
    getCurrentModelVariants: () => string[];
    getDefaultVariantForModel: (providerId: string, modelId: string, directory?: string | null) => string | undefined;
    setAgent: (agentName: string | undefined, options?: { keepModel?: boolean }) => void;
    applyDefaultModelAgentSelection: (options?: { projectDefaultAgent?: string; projectDefaultModel?: string; projectDefaultVariant?: string }) => void;
    resolveDirectoryDefaultSelection: (directory: string) => Promise<DirectoryDefaultSelection | null>;
    dropStaleAutoSelection: () => void;
    applyOpenCodeConfigDefaults: (directory?: string | null, source?: string, config?: Config) => void;
    setSelectedProvider: (providerId: string) => void;
    setSettingsDefaultModel: (model: string | undefined) => void;
    setSettingsDefaultVariant: (variant: string | undefined) => void;
    setSettingsDefaultAgent: (agent: string | undefined) => void;
    setChatsDefaultModel: (model: string | undefined) => void;
    setChatsDefaultVariant: (variant: string | undefined) => void;
    setChatsDefaultAgent: (agent: string | undefined) => void;
    setSettingsAutoCreateWorktree: (enabled: boolean) => void;
    setSettingsGitmojiEnabled: (enabled: boolean) => void;
    setSettingsDefaultFileViewerPreview: (enabled: boolean) => void;
    setSettingsZenModel: (model: string | undefined) => void;
    setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => void;
    saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => void;
    getAgentModelSelection: (agentName: string) => { providerId: string; modelId: string } | null;
    probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
    checkConnection: () => Promise<boolean>;
    initializeApp: () => Promise<void>;
    getCurrentProvider: () => ProviderWithModelList | undefined;
    getCurrentModel: () => ProviderModel | undefined;
    getCurrentAgent: () => Agent | undefined;
    getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
    getVisibleAgents: () => Agent[];
}

declare global {
    interface Window {
        __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
    }
}

export type InitFailure = {
    step: 'serverUnreachable' | 'openCodeUnavailable' | 'loadAgents' | 'unexpected';
    message: string | null;
};

export type ConfigSlice<K extends keyof ConfigStore> = (set: StoreApi<ConfigStore>["setState"], get: StoreApi<ConfigStore>["getState"]) => Pick<ConfigStore, K>;
