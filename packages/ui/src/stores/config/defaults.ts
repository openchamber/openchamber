import { type ConfigRuntimeContext, isSameConfigRuntimeContext, isConfigRuntimeContextCurrent, captureConfigRuntimeContext } from './runtime';
import { type DesktopSettings } from '@/lib/desktop';
import { markStartupTrace } from '@/lib/startupTrace';
import { loadDesktopSettings } from '@/lib/persistence';
import type { StoreApi } from 'zustand';
import { type ConfigSlice, type ConfigStore, type DirectoryScopedConfig } from './types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { fromDirectoryKey } from './directories';
import { getProjectDefaultsForConfigDirectory, isChatDraftOpen } from './projectDefaults';
import { resolveGitGenerationModelSelection, resolveVariantFromSelection } from './selectionResolution';

interface OpenChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultAgent?: string;
    chatsDefaultModel?: string;
    chatsDefaultVariant?: string;
    chatsDefaultAgent?: string;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    dictationEnabled?: boolean;
    dictationAutoSend?: boolean;
    sttProvider?: 'local' | 'openai-compatible';
    sttServerUrl?: string;
    sttEndpointPath?: string;
    sttModel?: string;
    sttLocalModel?: string;
    sttLanguage?: string;
    sttCorrectTranscript?: boolean;
}

const OPENCHAMBER_DEFAULTS_FRESH_MS = 15_000;

let openChamberDefaultsCache: {
    at: number;
    context: ConfigRuntimeContext;
    request: Promise<OpenChamberDefaults | null>;
} | null = null;
let openChamberDefaultsUserRevision = 0;

export const invalidateOpenChamberDefaultsCache = (): void => {
    openChamberDefaultsCache = null;
};

const recordOpenChamberDefaultsChange = (): void => {
    openChamberDefaultsUserRevision += 1;
    invalidateOpenChamberDefaultsCache();
};

const fetchOpenChamberDefaults = (context: ConfigRuntimeContext): Promise<OpenChamberDefaults | null> => {
    const now = Date.now();
    if (
        openChamberDefaultsCache
        && isSameConfigRuntimeContext(openChamberDefaultsCache.context, context)
        && now - openChamberDefaultsCache.at < OPENCHAMBER_DEFAULTS_FRESH_MS
    ) {
        return openChamberDefaultsCache.request;
    }
    const request = requestOpenChamberDefaults(context);
    const cacheEntry = { at: now, context, request };
    openChamberDefaultsCache = cacheEntry;
    void request.then((result) => {
        if (result === null && openChamberDefaultsCache === cacheEntry) {
            openChamberDefaultsCache = null;
        }
    }).catch(() => {
        if (openChamberDefaultsCache === cacheEntry) openChamberDefaultsCache = null;
    });
    return request;
};

const toOpenChamberDefaults = (data: DesktopSettings): OpenChamberDefaults => {
    const defaultModel = data.defaultModel?.trim() ?? '';
    const defaultVariant = data.defaultVariant?.trim() ?? '';
    const defaultAgent = data.defaultAgent?.trim() ?? '';
    const zenModel = data.zenModel ?? '';

    return {
        defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
        defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
        defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
        chatsDefaultModel: data.chatsDefaultModel?.trim() || undefined,
        chatsDefaultVariant: data.chatsDefaultVariant?.trim() || undefined,
        chatsDefaultAgent: data.chatsDefaultAgent?.trim() || undefined,
        autoCreateWorktree: data.autoCreateWorktree,
        gitmojiEnabled: data.gitmojiEnabled,
        defaultFileViewerPreview: data.defaultFileViewerPreview,
        zenModel: zenModel.length > 0 ? zenModel : undefined,
        messageStreamTransport: data.messageStreamTransport,
        dictationEnabled: data.dictationEnabled,
        dictationAutoSend: data.dictationAutoSend,
        sttProvider: data.sttProvider,
        sttServerUrl: data.sttServerUrl,
        sttEndpointPath: data.sttEndpointPath,
        sttModel: data.sttModel,
        sttLocalModel: data.sttLocalModel,
        sttLanguage: data.sttLanguage,
        sttCorrectTranscript: data.sttCorrectTranscript,
    };
};

const requestOpenChamberDefaults = async (context: ConfigRuntimeContext): Promise<OpenChamberDefaults | null> => {
    markStartupTrace('config.defaults:start');
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const finish = (source: string, result: OpenChamberDefaults | null) => {
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('config.defaults:end', {
            source,
            durationMs: Math.round(ended - started),
            hasDefaultModel: Boolean(result?.defaultModel),
            hasDefaultAgent: Boolean(result?.defaultAgent),
        });
        return result;
    };
    try {
        const data = await loadDesktopSettings();
        if (!isConfigRuntimeContextCurrent(context)) {
            return finish('stale', null);
        }
        if (!data) {
            return finish('settings-unavailable', null);
        }

        return finish('settings', toOpenChamberDefaults(data));
    } catch (error) {
        markStartupTrace('config.defaults:error', { error: error instanceof Error ? error.message : String(error) });
        return finish('error', null);
    }
};

const applyChatsDefaultsToDraft = (set: StoreApi<ConfigStore>['setState'], get: StoreApi<ConfigStore>['getState']) => {
    if (!isChatDraftOpen()) return;
    const before = get();
    const agentManual = before.agentSelectionSource === 'manual' && !!before.currentAgentName;
    const modelManual = before.selectionSource === 'manual' && !!before.currentProviderId && !!before.currentModelId;
    const variantOverride = before.currentVariantSelection.override !== undefined;
    const chatDefaults = getProjectDefaultsForConfigDirectory(fromDirectoryKey(before.activeDirectoryKey));
    before.applyDefaultModelAgentSelection(agentManual ? { ...chatDefaults, projectDefaultAgent: before.currentAgentName } : chatDefaults);
    if (!agentManual && !modelManual && !variantOverride) return;
    set((state) => {
        const sameModel = state.currentProviderId === before.currentProviderId && state.currentModelId === before.currentModelId;
        const kept: Partial<DirectoryScopedConfig> = {};
        if (agentManual) Object.assign(kept, { currentAgentName: before.currentAgentName, agentSelectionSource: 'manual' });
        if (modelManual) Object.assign(kept, { currentProviderId: before.currentProviderId, currentModelId: before.currentModelId, selectionSource: 'manual' });
        if (sameModel) {
            const selection = { override: before.currentVariantSelection.override, inherited: state.currentVariantSelection.inherited };
            Object.assign(kept, { currentVariant: resolveVariantFromSelection(selection), currentVariantSelection: selection });
        } else if (modelManual) {
            Object.assign(kept, { currentVariant: before.currentVariant, currentVariantSelection: before.currentVariantSelection });
        }
        const directoryKey = state.activeDirectoryKey;
        const snapshot = state.directoryScoped[directoryKey];
        if (!snapshot) return kept;
        return { ...kept, directoryScoped: { ...state.directoryScoped, [directoryKey]: { ...snapshot, ...kept } } };
    });
};

export const createSettingsDefaults: ConfigSlice<
    | 'loadSessionDefaults'
    | 'setSettingsDefaultModel'
    | 'setSettingsDefaultVariant'
    | 'setSettingsDefaultAgent'
    | 'setChatsDefaultModel'
    | 'setChatsDefaultVariant'
    | 'setChatsDefaultAgent'
    | 'setSettingsAutoCreateWorktree'
    | 'setSettingsGitmojiEnabled'
    | 'setSettingsDefaultFileViewerPreview'
    | 'setSettingsZenModel'
    | 'setSettingsMessageStreamTransport'
    | 'getResolvedGitGenerationModel'
> = (set, get) => ({
    loadSessionDefaults: async () => {
        const runtimeContext = captureConfigRuntimeContext();
        const revision = openChamberDefaultsUserRevision;
        const defaults = await fetchOpenChamberDefaults(runtimeContext);
        if (!isConfigRuntimeContextCurrent(runtimeContext) || !defaults) return false;

        set((state) => {
            const edited = revision !== openChamberDefaultsUserRevision;
            const next: Partial<ConfigStore> = {
                configRuntimeKey: runtimeContext.runtimeKey,
                settingsDefaultsLoaded: true,
                settingsDefaultModel: edited ? state.settingsDefaultModel : defaults.defaultModel,
                settingsDefaultVariant: edited ? state.settingsDefaultVariant : defaults.defaultVariant,
                settingsDefaultAgent: edited ? state.settingsDefaultAgent : defaults.defaultAgent,
                chatsDefaultModel: edited ? state.chatsDefaultModel : defaults.chatsDefaultModel,
                chatsDefaultVariant: edited ? state.chatsDefaultVariant : defaults.chatsDefaultVariant,
                chatsDefaultAgent: edited ? state.chatsDefaultAgent : defaults.chatsDefaultAgent,
                settingsAutoCreateWorktree: defaults.autoCreateWorktree ?? false,
                settingsGitmojiEnabled: defaults.gitmojiEnabled ?? false,
                settingsDefaultFileViewerPreview: defaults.defaultFileViewerPreview ?? true,
                settingsZenModel: defaults.zenModel,
                settingsMessageStreamTransport: defaults.messageStreamTransport ?? state.settingsMessageStreamTransport,
                dictationEnabled: typeof defaults.dictationEnabled === 'boolean' ? defaults.dictationEnabled : state.dictationEnabled,
                dictationAutoSend: defaults.dictationAutoSend ?? state.dictationAutoSend,
                sttProvider: defaults.sttProvider ?? state.sttProvider,
                sttServerUrl: defaults.sttServerUrl ?? state.sttServerUrl,
                sttModel: defaults.sttModel ?? state.sttModel,
                sttEndpointPath: defaults.sttEndpointPath ?? state.sttEndpointPath,
                sttLocalModel: defaults.sttLocalModel ?? state.sttLocalModel,
                sttLanguage: defaults.sttLanguage ?? state.sttLanguage,
                sttCorrectTranscript: defaults.sttCorrectTranscript ?? state.sttCorrectTranscript,
            };
            if (!useSessionUIStore.getState().currentSessionId && state.selectionSource === 'auto' && state.agentSelectionSource === 'auto' && next.settingsDefaultAgent) {
                next.currentAgentName = next.settingsDefaultAgent;
            }
            return next;
        });
        const state = get();
        const projectDefaults = getProjectDefaultsForConfigDirectory(fromDirectoryKey(state.activeDirectoryKey));
        if (!useSessionUIStore.getState().currentSessionId && state.selectionSource === 'auto' && state.agentSelectionSource === 'auto'
            && state.currentVariantSelection.override === undefined
            && (projectDefaults.projectDefaultModel || projectDefaults.projectDefaultAgent || state.settingsDefaultModel)) {
            state.applyDefaultModelAgentSelection(projectDefaults);
        }
        markStartupTrace('config.defaults:published');
        return true;
    },

     setSettingsDefaultModel: (model: string | undefined) => {
         recordOpenChamberDefaultsChange();
         set({ settingsDefaultModel: model });
         if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
     },

     setSettingsDefaultVariant: (variant: string | undefined) => {
         recordOpenChamberDefaultsChange();
         set({ settingsDefaultVariant: variant });
         if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
     },
 
     setSettingsDefaultAgent: (agent: string | undefined) => {
         recordOpenChamberDefaultsChange();
         set({ settingsDefaultAgent: agent });
         if (!useSessionUIStore.getState().currentSessionId) get().applyDefaultModelAgentSelection();
     },

    setChatsDefaultModel: (model: string | undefined) => {
        recordOpenChamberDefaultsChange();
        set({ chatsDefaultModel: model });
        applyChatsDefaultsToDraft(set, get);
    },

    setChatsDefaultVariant: (variant: string | undefined) => {
        recordOpenChamberDefaultsChange();
        set({ chatsDefaultVariant: variant });
        applyChatsDefaultsToDraft(set, get);
    },

    setChatsDefaultAgent: (agent: string | undefined) => {
        recordOpenChamberDefaultsChange();
        set({ chatsDefaultAgent: agent });
        applyChatsDefaultsToDraft(set, get);
    },

    setSettingsAutoCreateWorktree: (enabled: boolean) => {
        set({ settingsAutoCreateWorktree: enabled });
    },

    setSettingsGitmojiEnabled: (enabled: boolean) => {
        set({ settingsGitmojiEnabled: enabled });
    },

    setSettingsDefaultFileViewerPreview: (enabled: boolean) => {
        set({ settingsDefaultFileViewerPreview: enabled });
    },

    setSettingsZenModel: (model: string | undefined) => {
        set({ settingsZenModel: model });
    },

    setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => {
        set({ settingsMessageStreamTransport: transport });
    },

    getResolvedGitGenerationModel: () => {
        const state = get();
        return resolveGitGenerationModelSelection({
            providers: state.providers,
            settingsZenModel: state.settingsZenModel,
        });
    },
});
