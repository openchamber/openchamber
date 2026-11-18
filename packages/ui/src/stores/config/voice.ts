import { type ConfigSlice } from './types';
import { EMPTY_VOICE_API_KEYS, updateVoiceApiKeys, migrateLegacyVoiceApiKeys, fetchVoiceApiKeys } from '@/lib/voiceKeysApi';
import { getSafeStorage } from '../utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { updateDesktopSettings } from '@/lib/persistence';

let voiceApiKeysLoad: { runtimeKey: string; promise: Promise<void> } | null = null;

export const createVoiceSettings: ConfigSlice<
    | 'voiceProvider'
    | 'speechRate'
    | 'speechPitch'
    | 'speechVolume'
    | 'sayVoice'
    | 'localTtsVoiceId'
    | 'localTtsModelId'
    | 'ttsFollowTextLanguage'
    | 'browserVoice'
    | 'openaiVoice'
    | 'voiceApiKeys'
    | 'openaiCompatibleUrl'
    | 'openaiCompatibleVoice'
    | 'openaiCompatibleTtsModel'
    | 'openaiCompatibleTtsEndpointPath'
    | 'dictationEnabled'
    | 'dictationAutoSend'
    | 'sttProvider'
    | 'sttServerUrl'
    | 'sttModel'
    | 'sttEndpointPath'
    | 'sttLocalModel'
    | 'sttLanguage'
    | 'sttCorrectTranscript'
    | 'showMessageTTSButtons'
    | 'autoReadAloudEnabled'
    | 'ttsInputMode'
    | 'ttsChunkedMode'
    | 'summarizeMessageTTS'
    | 'summarizeVoiceConversation'
    | 'summarizeCharacterThreshold'
    | 'summarizeMaxLength'
    | 'setVoiceProvider'
    | 'setSpeechRate'
    | 'setSpeechPitch'
    | 'setSpeechVolume'
    | 'setSayVoice'
    | 'setLocalTtsVoiceId'
    | 'setLocalTtsModelId'
    | 'setTtsFollowTextLanguage'
    | 'setBrowserVoice'
    | 'setOpenaiVoice'
    | 'setVoiceApiKey'
    | 'refreshVoiceApiKeys'
    | 'setOpenaiCompatibleUrl'
    | 'setOpenaiCompatibleVoice'
    | 'setOpenaiCompatibleTtsModel'
    | 'setOpenaiCompatibleTtsEndpointPath'
    | 'setDictationEnabled'
    | 'setSttCorrectTranscript'
    | 'setDictationAutoSend'
    | 'setSttProvider'
    | 'setSttServerUrl'
    | 'setSttModel'
    | 'setSttEndpointPath'
    | 'setSttLocalModel'
    | 'setSttLanguage'
    | 'setShowMessageTTSButtons'
    | 'setAutoReadAloudEnabled'
    | 'setTtsInputMode'
    | 'setTtsChunkedMode'
    | 'setSummarizeMessageTTS'
    | 'setSummarizeVoiceConversation'
    | 'setSummarizeCharacterThreshold'
    | 'setSummarizeMaxLength'
> = (set) => ({
    voiceProvider: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('voiceProvider');
            if (saved === 'openai' || saved === 'browser' || saved === 'local' || saved === 'say' || saved === 'openai-compatible') return saved;
        }
        return 'browser';
    })(),
    speechRate: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('speechRate');
            if (saved) {
                const parsed = parseFloat(saved);
                if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
            }
        }
        return 1;
    })(),
    speechPitch: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('speechPitch');
            if (saved) {
                const parsed = parseFloat(saved);
                if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
            }
        }
        return 1;
    })(),
    speechVolume: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('speechVolume');
            if (saved) {
                const parsed = parseFloat(saved);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
            }
        }
        return 1;
    })(),
    sayVoice: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sayVoice');
            if (saved) return saved;
        }
        return 'Samantha';
    })(),
    localTtsVoiceId: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('localTtsVoiceId');
            if (saved !== null) {
                const parsed = Number.parseInt(saved, 10);
                if (Number.isInteger(parsed) && parsed >= 0) return parsed;
            }
        }
        return 0;
    })(),
    localTtsModelId: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('localTtsModelId');
            if (saved) return saved;
        }
        return 'kokoro-en-v0_19';
    })(),

    ttsFollowTextLanguage: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('ttsFollowTextLanguage');
            if (saved !== null) return saved === 'true';
        }
        return true;
    })(),
    browserVoice: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('browserVoice');
            if (saved) return saved;
        }
        return '';
    })(),
    openaiVoice: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('openaiVoice');
            if (saved) return saved;
        }
        return 'nova';
    })(),
    voiceApiKeys: EMPTY_VOICE_API_KEYS,
    openaiCompatibleUrl: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('openaiCompatibleUrl');
            if (saved) return saved;
        }
        return '';
    })(),
    openaiCompatibleVoice: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('openaiCompatibleVoice');
            if (saved) return saved;
        }
        return 'af_sky';
    })(),
    openaiCompatibleTtsModel: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('openaiCompatibleTtsModel');
            if (saved && saved !== 'speaches-ai/Kokoro-82M-v1.0-ONNX') return saved;
        }
        return 'kokoro';
    })(),
    openaiCompatibleTtsEndpointPath: getSafeStorage().getItem('openaiCompatibleTtsEndpointPath') ?? '',
    dictationEnabled: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('dictationEnabled');
            if (saved === 'false') return false;
        }
        return true;
    })(),
    dictationAutoSend: getSafeStorage().getItem('dictationAutoSend') === 'true',
    sttProvider: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sttProvider');
            if (saved === 'local' || saved === 'openai-compatible') return saved;
            if (saved === 'server') return 'openai-compatible' as const;
        }
        return 'local' as const;
    })(),
    sttServerUrl: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sttServerUrl');
            if (saved) return saved;
        }
        return 'http://localhost:8001/v1';
    })(),
    sttModel: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sttModel');
            if (saved) return saved;
        }
        return 'deepdml/faster-whisper-large-v3-turbo-ct2';
    })(),
    sttEndpointPath: getSafeStorage().getItem('sttEndpointPath') ?? '',
    sttLocalModel: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sttLocalModel');
            if (saved) return saved;
        }
        return '';
    })(),
    sttLanguage: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('sttLanguage');
            if (saved !== null) return saved;
        }
        return '';
    })(),
    sttCorrectTranscript: globalThis.localStorage?.getItem('sttCorrectTranscript') === 'true',
    showMessageTTSButtons: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('showMessageTTSButtons');
            if (saved === 'true') return true;
        }
        return false;
    })(),
    autoReadAloudEnabled: (() => {
        const saved = globalThis.window?.localStorage?.getItem('autoReadAloudEnabled');
        return saved === 'true';
    })(),
    ttsInputMode: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('ttsInputMode');
            if (saved === 'raw') return 'raw' as const;
            if (saved === 'summarized') return 'summarized' as const;
        }
        return 'sanitized' as const;
    })(),
    ttsChunkedMode: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('ttsChunkedMode');
            if (saved === 'true') return true;
        }
        return false;
    })(),
    summarizeMessageTTS: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('summarizeMessageTTS');
            if (saved === 'true') return true;
        }
        return false;
    })(),
    summarizeVoiceConversation: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('summarizeVoiceConversation');
            if (saved === 'true') return true;
        }
        return false;
    })(),
    summarizeCharacterThreshold: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('summarizeCharacterThreshold');
            if (saved) {
                const parsed = parseInt(saved, 10);
                if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
            }
        }
        return 200;
    })(),
    summarizeMaxLength: (() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('summarizeMaxLength');
            if (saved) {
                const parsed = parseInt(saved, 10);
                if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
            }
        }
        return 500;
    })(),

    setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => {
        set({ voiceProvider: provider });
        if (typeof window !== 'undefined') {
            localStorage.setItem('voiceProvider', provider);
        }
    },

    setSpeechRate: (rate: number) => {
        const clampedRate = Math.max(0.5, Math.min(2, rate));
        set({ speechRate: clampedRate });
        if (typeof window !== 'undefined') {
            localStorage.setItem('speechRate', String(clampedRate));
        }
    },

    setSpeechPitch: (pitch: number) => {
        const clampedPitch = Math.max(0.5, Math.min(2, pitch));
        set({ speechPitch: clampedPitch });
        if (typeof window !== 'undefined') {
            localStorage.setItem('speechPitch', String(clampedPitch));
        }
    },

    setSpeechVolume: (volume: number) => {
        const clampedVolume = Math.max(0, Math.min(1, volume));
        set({ speechVolume: clampedVolume });
        if (typeof window !== 'undefined') {
            localStorage.setItem('speechVolume', String(clampedVolume));
        }
    },

    setSayVoice: (voice: string) => {
        set({ sayVoice: voice });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sayVoice', voice);
        }
    },

    setLocalTtsVoiceId: (voiceId: number) => {
        set({ localTtsVoiceId: voiceId });
        if (typeof window !== 'undefined') {
            localStorage.setItem('localTtsVoiceId', String(voiceId));
        }
    },

    setLocalTtsModelId: (modelId: string) => {
        set({ localTtsModelId: modelId });
        if (typeof window !== 'undefined') {
            localStorage.setItem('localTtsModelId', modelId);
        }
    },

    setTtsFollowTextLanguage: (enabled: boolean) => {
        set({ ttsFollowTextLanguage: enabled });
        if (typeof window !== 'undefined') {
            localStorage.setItem('ttsFollowTextLanguage', String(enabled));
        }
    },

    setBrowserVoice: (voice: string) => {
        set({ browserVoice: voice });
        if (typeof window !== 'undefined') {
            localStorage.setItem('browserVoice', voice);
        }
    },

    setOpenaiVoice: (voice: string) => {
        set({ openaiVoice: voice });
        if (typeof window !== 'undefined') {
            localStorage.setItem('openaiVoice', voice);
        }
    },

    setVoiceApiKey: async (kind, apiKey) => {
        try {
            set({ voiceApiKeys: await updateVoiceApiKeys({ [kind]: apiKey }) });
            return true;
        } catch (error) {
            console.warn('Failed to save voice API key:', error);
            return false;
        }
    },

    refreshVoiceApiKeys: (options) => {
        const runtimeKey = getRuntimeKey();
        if (!options?.force && voiceApiKeysLoad?.runtimeKey === runtimeKey) {
            return voiceApiKeysLoad.promise;
        }
        const promise = (async () => {
            try {
                const migrated = await migrateLegacyVoiceApiKeys();
                const voiceApiKeys = migrated ?? await fetchVoiceApiKeys();
                if (getRuntimeKey() === runtimeKey) set({ voiceApiKeys });
            } catch (error) {
                if (getRuntimeKey() === runtimeKey) set({ voiceApiKeys: EMPTY_VOICE_API_KEYS });
                console.warn('Failed to read voice API keys:', error);
            }
        })();
        voiceApiKeysLoad = { runtimeKey, promise };
        return promise;
    },

    setOpenaiCompatibleUrl: (url: string) => {
        set({ openaiCompatibleUrl: url });
        if (typeof window !== 'undefined') {
            localStorage.setItem('openaiCompatibleUrl', url);
        }
    },


    setOpenaiCompatibleVoice: (voice: string) => {
        set({ openaiCompatibleVoice: voice });
        if (typeof window !== 'undefined') {
            localStorage.setItem('openaiCompatibleVoice', voice);
        }
    },

    setOpenaiCompatibleTtsModel: (model: string) => {
        set({ openaiCompatibleTtsModel: model });
        if (typeof window !== 'undefined') {
            localStorage.setItem('openaiCompatibleTtsModel', model);
        }
    },

    setOpenaiCompatibleTtsEndpointPath: (path: string) => {
        set({ openaiCompatibleTtsEndpointPath: path });
        getSafeStorage().setItem('openaiCompatibleTtsEndpointPath', path);
    },

    setDictationEnabled: (enabled: boolean) => {
        set({ dictationEnabled: enabled });
        if (typeof window !== 'undefined') {
            localStorage.setItem('dictationEnabled', String(enabled));
        }
        updateDesktopSettings({ dictationEnabled: enabled }).catch(() => {});
    },

    setSttCorrectTranscript: (enabled: boolean) => {
        set({ sttCorrectTranscript: enabled });
        globalThis.localStorage?.setItem('sttCorrectTranscript', String(enabled));
        updateDesktopSettings({ sttCorrectTranscript: enabled }).catch(() => {});
    },

    setDictationAutoSend: (enabled: boolean) => {
        set({ dictationAutoSend: enabled });
        getSafeStorage().setItem('dictationAutoSend', String(enabled));
        updateDesktopSettings({ dictationAutoSend: enabled }).catch(() => {});
    },

    setSttProvider: (provider: 'local' | 'openai-compatible') => {
        set({ sttProvider: provider });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sttProvider', provider);
        }
        updateDesktopSettings({ sttProvider: provider }).catch(() => {});
    },

    setSttServerUrl: (url: string) => {
        set({ sttServerUrl: url });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sttServerUrl', url);
        }
        updateDesktopSettings({ sttServerUrl: url }).catch(() => {});
    },


    setSttModel: (model: string) => {
        set({ sttModel: model });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sttModel', model);
        }
        updateDesktopSettings({ sttModel: model }).catch(() => {});
    },

    setSttEndpointPath: (path: string) => {
        set({ sttEndpointPath: path });
        getSafeStorage().setItem('sttEndpointPath', path);
        updateDesktopSettings({ sttEndpointPath: path }).catch(() => {});
    },

    setSttLocalModel: (model: string) => {
        set({ sttLocalModel: model });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sttLocalModel', model);
        }
        updateDesktopSettings({ sttLocalModel: model }).catch(() => {});
    },

    setSttLanguage: (lang: string) => {
        set({ sttLanguage: lang });
        if (typeof window !== 'undefined') {
            localStorage.setItem('sttLanguage', lang);
        }
        updateDesktopSettings({ sttLanguage: lang }).catch(() => {});
    },

    setShowMessageTTSButtons: (show: boolean) => {
        set({ showMessageTTSButtons: show });
        if (typeof window !== 'undefined') {
            localStorage.setItem('showMessageTTSButtons', String(show));
        }
    },

    setAutoReadAloudEnabled: (enabled: boolean) => {
        set({ autoReadAloudEnabled: enabled });
        globalThis.window?.localStorage?.setItem('autoReadAloudEnabled', String(enabled));
    },

    setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => {
        set({ ttsInputMode: mode });
        if (typeof window !== 'undefined') {
            localStorage.setItem('ttsInputMode', mode);
        }
    },

    setTtsChunkedMode: (enabled: boolean) => {
        set({ ttsChunkedMode: enabled });
        if (typeof window !== 'undefined') {
            localStorage.setItem('ttsChunkedMode', String(enabled));
        }
    },

    setSummarizeMessageTTS: (enabled: boolean) => {
        set({ summarizeMessageTTS: enabled });
        if (typeof window !== 'undefined') {
            localStorage.setItem('summarizeMessageTTS', String(enabled));
        }
    },

    setSummarizeVoiceConversation: (enabled: boolean) => {
        set({ summarizeVoiceConversation: enabled });
        if (typeof window !== 'undefined') {
            localStorage.setItem('summarizeVoiceConversation', String(enabled));
        }
    },

    setSummarizeCharacterThreshold: (threshold: number) => {
        const clamped = Math.max(50, Math.min(2000, threshold));
        set({ summarizeCharacterThreshold: clamped });
        if (typeof window !== 'undefined') {
            localStorage.setItem('summarizeCharacterThreshold', String(clamped));
        }
    },

    setSummarizeMaxLength: (maxLength: number) => {
        const clamped = Math.max(50, Math.min(2000, maxLength));
        set({ summarizeMaxLength: clamped });
        if (typeof window !== 'undefined') {
            localStorage.setItem('summarizeMaxLength', String(clamped));
        }
    },
});
