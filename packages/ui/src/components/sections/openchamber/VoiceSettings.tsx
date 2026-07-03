import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDeviceInfo } from '@/lib/device';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useLocalTTS } from '@/hooks/useLocalTTS';
import { disposePreviewAudio } from './voicePreviewAudio';

const LOCAL_STT_MODELS = [
    {
        id: 'parakeet-tdt-0.6b-v2-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV2',
        badgeKey: 'settings.voice.page.stt.badge.bestForEnglish',
        accuracy: 5,
        speed: 5,
        size: '460 MB',
    },
    {
        id: 'parakeet-tdt-0.6b-v3-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV3',
        badgeKey: 'settings.voice.page.stt.badge.bestForMultilingual',
        accuracy: 5,
        speed: 4,
        size: '465 MB',
    },
    {
        id: 'whisper-base-int8',
        labelKey: 'settings.voice.page.stt.model.whisperBase',
        badgeKey: null,
        accuracy: 3,
        speed: 3,
        size: '200 MB',
    },
    {
        id: 'whisper-tiny-int8',
        labelKey: 'settings.voice.page.stt.model.whisperTiny',
        badgeKey: null,
        accuracy: 2,
        speed: 4,
        size: '115 MB',
    },
] as const;

interface DictationModelState {
    id: string;
    installed: boolean;
    downloading: boolean;
    downloadProgress: number | null;
    downloadError: string | null;
}

const RatingBar = ({ value, label }: { value: number; label: string }) => (
    <span className="flex items-center gap-1.5" title={`${label}: ${value}/5`}>
        <span
            className="h-1.5 w-12 flex-shrink-0 overflow-hidden rounded-full bg-[var(--interactive-border)]"
            aria-hidden="true"
        >
            <span
                className="block h-full rounded-full bg-[var(--primary-base)]"
                style={{ width: `${(value / 5) * 100}%` }}
            />
        </span>
        <span className="typography-ui-compact text-muted-foreground">{label}</span>
    </span>
);

const LocalModelPicker = ({
    selectedModelId,
    onSelect,
}: {
    selectedModelId: string;
    onSelect: (modelId: string) => void;
}) => {
    const { t } = useI18n();
    const tUnsafe = useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const [models, setModels] = useState<Map<string, DictationModelState>>(new Map());
    const [requestingId, setRequestingId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', {
                query: { provider: 'local' },
            });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            if (Array.isArray(data?.models)) {
                setModels(new Map(data.models.map((m: DictationModelState) => [m.id, m])));
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const anyDownloading = Array.from(models.values()).some((m) => m.downloading);
    useEffect(() => {
        if (!anyDownloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [anyDownloading, refresh]);

    const handleDownload = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}/download`, {
                method: 'POST',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    const handleDelete = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}`, {
                method: 'DELETE',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    return (
        <div role="radiogroup" aria-label={t('settings.voice.page.field.model')} className="mt-1 space-y-0">
            {LOCAL_STT_MODELS.map((entry) => {
                const selected = selectedModelId === entry.id;
                const state = models.get(entry.id) ?? null;
                return (
                    <div key={entry.id} className="flex w-full items-start gap-2 py-1.5">
                        <div className="pt-0.5">
                            <Radio
                                checked={selected}
                                onChange={() => onSelect(entry.id)}
                                ariaLabel={tUnsafe(entry.labelKey)}
                            />
                        </div>
                        <div
                            className="min-w-0 flex-1 cursor-pointer"
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelect(entry.id)}
                            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(entry.id); } }}
                        >
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                    {tUnsafe(entry.labelKey)}
                                </span>
                                {entry.badgeKey ? (
                                    <span
                                        className="rounded px-1 text-[9px] font-medium uppercase leading-[14px] tracking-wide"
                                        style={{
                                            backgroundColor: 'var(--status-success-background)',
                                            color: 'var(--status-success)',
                                            border: '1px solid var(--status-success-border)',
                                        }}
                                    >
                                        {tUnsafe(entry.badgeKey)}
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5">
                                <RatingBar value={entry.accuracy} label={t('settings.voice.page.stt.meta.accuracy')} />
                                <RatingBar value={entry.speed} label={t('settings.voice.page.stt.meta.speed')} />
                                <span className="typography-ui-compact tabular-nums text-muted-foreground">{entry.size}</span>
                            </div>
                            {state?.downloadError ? (
                                <p className="mt-0.5 typography-meta text-[var(--status-error)]">{state.downloadError}</p>
                            ) : null}
                        </div>
                        <div className="flex w-14 flex-shrink-0 items-center justify-end gap-1 pt-0.5">
                            {state?.installed ? (
                                <>
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                                        disabled={requestingId === entry.id}
                                        onClick={() => { void handleDelete(entry.id); }}
                                        title={t('settings.voice.page.stt.modelDelete')}
                                        aria-label={t('settings.voice.page.stt.modelDelete')}
                                    >
                                        <Icon name="delete-bin" className="h-4 w-4" />
                                    </Button>
                                    <Icon
                                        name="checkbox-circle"
                                        className="h-4 w-4 flex-shrink-0 text-[var(--status-success)]"
                                        aria-label={t('settings.voice.page.stt.modelInstalled')}
                                    />
                                </>
                            ) : state?.downloading ? (
                                <span className="flex items-center gap-1.5">
                                    <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                    <span className="typography-ui-compact tabular-nums text-muted-foreground">
                                        {typeof state.downloadProgress === 'number' ? `${state.downloadProgress}%` : ''}
                                    </span>
                                </span>
                            ) : (
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-6 w-6 p-0"
                                    disabled={requestingId === entry.id}
                                    onClick={() => { void handleDownload(entry.id); }}
                                    title={t('settings.voice.page.stt.modelDownload')}
                                    aria-label={t('settings.voice.page.stt.modelDownload')}
                                >
                                    <Icon name="download" className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

/** Kokoro en_v0_19 speaker ids in sherpa-onnx order. */
const KOKORO_VOICE_OPTIONS = [
    { id: 0, label: 'Alloy (af)' },
    { id: 1, label: 'Bella (af)' },
    { id: 2, label: 'Nicole (af)' },
    { id: 3, label: 'Sarah (af)' },
    { id: 4, label: 'Sky (af)' },
    { id: 5, label: 'Adam (am)' },
    { id: 6, label: 'Michael (am)' },
    { id: 7, label: 'Emma (bf)' },
    { id: 8, label: 'Isabella (bf)' },
    { id: 9, label: 'George (bm)' },
    { id: 10, label: 'Lewis (bm)' },
];

const LOCAL_TTS_MODEL_ID = 'kokoro-en-v0_19';

const LocalTtsModelStatus = () => {
    const { t } = useI18n();
    const [model, setModel] = useState<DictationModelState | null>(null);
    const [requesting, setRequesting] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', { query: { provider: 'local' } });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            const entry = Array.isArray(data?.ttsModels)
                ? data.ttsModels.find((m: DictationModelState) => m.id === LOCAL_TTS_MODEL_ID)
                : null;
            if (entry) {
                setModel(entry);
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!model?.downloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [model?.downloading, refresh]);

    const request = async (method: 'POST' | 'DELETE') => {
        setRequesting(true);
        try {
            const path = method === 'POST'
                ? `/api/dictation/models/${LOCAL_TTS_MODEL_ID}/download`
                : `/api/dictation/models/${LOCAL_TTS_MODEL_ID}`;
            await runtimeFetch(path, { method });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequesting(false);
        }
    };

    if (!model) {
        return null;
    }

    return (
        <div className="flex items-center gap-2 py-1.5">
            <span className="typography-ui-label text-foreground">Kokoro</span>
            <span className="typography-ui-compact tabular-nums text-muted-foreground">305 MB</span>
            {model.installed ? (
                <>
                    <Icon
                        name="checkbox-circle"
                        className="h-4 w-4 text-[var(--status-success)]"
                        aria-label={t('settings.voice.page.stt.modelInstalled')}
                    />
                    <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                        disabled={requesting}
                        onClick={() => { void request('DELETE'); }}
                        title={t('settings.voice.page.stt.modelDelete')}
                        aria-label={t('settings.voice.page.stt.modelDelete')}
                    >
                        <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                </>
            ) : model.downloading ? (
                <span className="flex items-center gap-1.5">
                    <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    <span className="typography-ui-compact tabular-nums text-muted-foreground">
                        {typeof model.downloadProgress === 'number' ? `${model.downloadProgress}%` : ''}
                    </span>
                </span>
            ) : (
                <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 w-6 p-0"
                    disabled={requesting}
                    onClick={() => { void request('POST'); }}
                    title={t('settings.voice.page.stt.modelDownload')}
                    aria-label={t('settings.voice.page.stt.modelDownload')}
                >
                    <Icon name="download" className="h-4 w-4" />
                </Button>
            )}
            {model.downloadError ? (
                <span className="typography-meta text-[var(--status-error)]">{model.downloadError}</span>
            ) : null}
        </div>
    );
};

const OPENAI_VOICE_OPTIONS = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'ash', label: 'Ash' },
    { value: 'ballad', label: 'Ballad' },
    { value: 'coral', label: 'Coral' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
    { value: 'nova', label: 'Nova' },
    { value: 'onyx', label: 'Onyx' },
    { value: 'sage', label: 'Sage' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'verse', label: 'Verse' },
    { value: 'marin', label: 'Marin' },
    { value: 'cedar', label: 'Cedar' },
];

export const VoiceSettings: React.FC = () => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const setVoiceProvider = useConfigStore((state) => state.setVoiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const setSpeechRate = useConfigStore((state) => state.setSpeechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const setSpeechPitch = useConfigStore((state) => state.setSpeechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const setSpeechVolume = useConfigStore((state) => state.setSpeechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const setSayVoice = useConfigStore((state) => state.setSayVoice);
    const localTtsVoiceId = useConfigStore((state) => state.localTtsVoiceId);
    const setLocalTtsVoiceId = useConfigStore((state) => state.setLocalTtsVoiceId);
    const { speak: speakLocalTts, stop: stopLocalTts, isPlaying: isLocalTtsPlaying, error: localTtsError } = useLocalTTS();

    const previewLocalVoice = useCallback(() => {
        if (isLocalTtsPlaying) {
            stopLocalTts();
            return;
        }
        const voiceLabel = KOKORO_VOICE_OPTIONS.find((v) => v.id === localTtsVoiceId)?.label
            ?? String(localTtsVoiceId);
        void speakLocalTts(t('settings.voice.page.preview.voiceLine', { voiceName: voiceLabel }), {
            speakerId: localTtsVoiceId,
            speed: useConfigStore.getState().speechRate,
        });
    }, [isLocalTtsPlaying, localTtsVoiceId, speakLocalTts, stopLocalTts, t]);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const setBrowserVoice = useConfigStore((state) => state.setBrowserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const setOpenaiVoice = useConfigStore((state) => state.setOpenaiVoice);
    const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
    const setOpenaiApiKey = useConfigStore((state) => state.setOpenaiApiKey);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const setOpenaiCompatibleUrl = useConfigStore((state) => state.setOpenaiCompatibleUrl);
    const openaiCompatibleApiKey = useConfigStore((state) => state.openaiCompatibleApiKey);
    const setOpenaiCompatibleApiKey = useConfigStore((state) => state.setOpenaiCompatibleApiKey);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const setOpenaiCompatibleVoice = useConfigStore((state) => state.setOpenaiCompatibleVoice);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const setOpenaiCompatibleTtsModel = useConfigStore((state) => state.setOpenaiCompatibleTtsModel);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);
    const setTtsInputMode = useConfigStore((state) => state.setTtsInputMode);
    // STT settings
    const sttProvider = useConfigStore((state) => state.sttProvider);
    const setSttProvider = useConfigStore((state) => state.setSttProvider);
    const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
    const setSttServerUrl = useConfigStore((state) => state.setSttServerUrl);
    const sttApiKey = useConfigStore((state) => state.sttApiKey);
    const setSttApiKey = useConfigStore((state) => state.setSttApiKey);
    const sttModel = useConfigStore((state) => state.sttModel);
    const setSttModel = useConfigStore((state) => state.setSttModel);
    const sttLocalModel = useConfigStore((state) => state.sttLocalModel);
    const setSttLocalModel = useConfigStore((state) => state.setSttLocalModel);
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const setShowMessageTTSButtons = useConfigStore((state) => state.setShowMessageTTSButtons);
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const setDictationEnabled = useConfigStore((state) => state.setDictationEnabled);

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isOpenAIAvailable, setIsOpenAIAvailable] = useState(false);
    const [isOpenAIPreviewPlaying, setIsOpenAIPreviewPlaying] = useState(false);
    const [openaiPreviewAudio, setOpenaiPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isCompatiblePreviewPlaying, setIsCompatiblePreviewPlaying] = useState(false);
    const [compatiblePreviewAudio, setCompatiblePreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [isBrowserPreviewPlaying, setIsBrowserPreviewPlaying] = useState(false);

    useEffect(() => {
        const loadVoices = async () => {
            const voices = await browserVoiceService.waitForVoices();
            setBrowserVoices(voices);
        };
        loadVoices();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                setBrowserVoices(window.speechSynthesis.getVoices());
            };
        }

        return () => {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = null;
            }
        };
    }, []);

    const filteredBrowserVoices = useMemo(() => {
        return browserVoices
            .filter(v => v.lang)
            .sort((a, b) => {
                const aIsEnglish = a.lang.startsWith('en');
                const bIsEnglish = b.lang.startsWith('en');
                if (aIsEnglish && !bIsEnglish) return -1;
                if (!aIsEnglish && bIsEnglish) return 1;
                const langCompare = a.lang.localeCompare(b.lang);
                if (langCompare !== 0) return langCompare;
                return a.name.localeCompare(b.name);
            });
    }, [browserVoices]);

    const previewBrowserVoice = useCallback(() => {
        if (isBrowserPreviewPlaying) {
            browserVoiceService.cancelSpeech();
            setIsBrowserPreviewPlaying(false);
            return;
        }

        const selectedVoice = browserVoices.find(v => v.name === browserVoice);
        const voiceName = selectedVoice?.name ?? t('settings.voice.page.preview.browserVoiceFallback');
        const previewText = t('settings.voice.page.preview.voiceLine', { voiceName });

        setIsBrowserPreviewPlaying(true);

        const utterance = new SpeechSynthesisUtterance(previewText);
        utterance.rate = speechRate;
        utterance.pitch = speechPitch;
        utterance.volume = speechVolume;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }

        utterance.onend = () => setIsBrowserPreviewPlaying(false);
        utterance.onerror = () => setIsBrowserPreviewPlaying(false);

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying, t]);

    useEffect(() => {
        return () => {
            if (isBrowserPreviewPlaying) {
                browserVoiceService.cancelSpeech();
            }
        };
    }, [isBrowserPreviewPlaying]);

    useEffect(() => {
        if (!showMessageTTSButtons || (voiceProvider !== 'openai' && voiceProvider !== 'openai-compatible')) {
            setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            return;
        }

        const checkOpenAIAvailability = async () => {
            try {
                const response = await runtimeFetch('/api/tts/status');
                const data = await response.json();
                const hasServerKey = data.available;
                const hasSettingsKey = openaiApiKey.trim().length > 0;
                setIsOpenAIAvailable(hasServerKey || hasSettingsKey);
            } catch {
                setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            }
        };

        checkOpenAIAvailability();
    }, [openaiApiKey, showMessageTTSButtons, voiceProvider]);

    useEffect(() => {
        if (!showMessageTTSButtons) {
            setIsSayAvailable(false);
            setSayVoices([]);
            return;
        }

        runtimeFetch('/api/tts/say/status')
            .then(res => res.json())
            .then(data => {
                setIsSayAvailable(data.available);
                if (data.voices) {
                    const uniqueVoices = data.voices
                        .filter((v: { name: string; locale: string }, i: number, arr: Array<{ name: string; locale: string }>) =>
                            arr.findIndex((x: { name: string }) => x.name === v.name) === i
                        )
                        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                    setSayVoices(uniqueVoices);
                }
            })
            .catch(() => {
                setIsSayAvailable(false);
            });
    }, [showMessageTTSButtons]);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            disposePreviewAudio(previewAudio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/say/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error('Preview failed');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(previewAudio);
        };
    }, [previewAudio]);

    const previewOpenAIVoice = useCallback(async () => {
        if (openaiPreviewAudio) {
            disposePreviewAudio(openaiPreviewAudio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
            return;
        }

        setIsOpenAIPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: openaiVoice }),
                    voice: openaiVoice,
                    speed: speechRate,
                    apiKey: openaiApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            setOpenaiPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
        }
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(openaiPreviewAudio);
        };
    }, [openaiPreviewAudio]);

    const previewCompatibleVoice = useCallback(async () => {
        if (compatiblePreviewAudio) {
            disposePreviewAudio(compatiblePreviewAudio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
            return;
        }

        if (!openaiCompatibleUrl.trim()) return;

        setIsCompatiblePreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.customServerLine'),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                    apiKey: openaiCompatibleApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            setCompatiblePreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
        }
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, openaiCompatibleApiKey, speechRate, compatiblePreviewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(compatiblePreviewAudio);
        };
    }, [compatiblePreviewAudio]);

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";

    return (
        <div className="space-y-8">

            {/* Playback (read messages aloud) */}
            <div data-settings-item="voice.playback" className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        {t('settings.voice.page.section.playbackAndSummary')}
                    </h3>
                </div>

                <section className="px-2 pb-2 pt-0 space-y-0">

                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={showMessageTTSButtons}
                        onClick={() => setShowMessageTTSButtons(!showMessageTTSButtons)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShowMessageTTSButtons(!showMessageTTSButtons); } }}
                    >
                        <Checkbox checked={showMessageTTSButtons} onChange={setShowMessageTTSButtons} ariaLabel={t('settings.voice.page.field.messageReadAloudButtonAria')} />
                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.messageReadAloudButton')}</span>
                    </div>

                    {showMessageTTSButtons && (
                        <>
                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.provider')}</span>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                <ul className="space-y-1">
                                                    <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.browser')}</li>
                                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.localTts')}</li>
                                                    <li><strong>OpenAI:</strong> {t('settings.voice.page.tooltip.openai')}</li>
                                                    <li><strong>{t('settings.voice.page.provider.custom')}</strong> {t('settings.voice.page.tooltip.custom')}</li>
                                                    <li><strong>{t('settings.voice.page.provider.say')}</strong> {t('settings.voice.page.tooltip.say')}</li>
                                                </ul>
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1">
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={voiceProvider === 'browser'}
                                            onClick={() => setVoiceProvider('browser')}
                                            className="!font-normal"
                                        >
                                            {t('settings.voice.page.provider.browser')}
                                        </Button>
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={voiceProvider === 'local'}
                                            onClick={() => setVoiceProvider('local')}
                                            className="!font-normal"
                                        >
                                            {t('settings.voice.page.provider.local')}
                                        </Button>
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={voiceProvider === 'openai'}
                                            onClick={() => setVoiceProvider('openai')}
                                            className="!font-normal"
                                        >
                                            OpenAI
                                        </Button>
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={voiceProvider === 'openai-compatible'}
                                            onClick={() => setVoiceProvider('openai-compatible')}
                                            className="!font-normal"
                                        >
                                            {t('settings.voice.page.provider.custom')}
                                        </Button>
                                        {isSayAvailable && (
                                            <Button
                                                variant="chip"
                                                size="xs"
                                                aria-pressed={voiceProvider === 'say'}
                                                onClick={() => setVoiceProvider('say')}
                                                className="!font-normal"
                                            >
                                                <Icon name="apple" className="w-3.5 h-3.5 mr-0.5" />
                                                {t('settings.voice.page.provider.say')}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className="py-1.5">
                                    <span className={cn("typography-ui-label text-foreground", !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                        {t('settings.voice.page.field.apiKey')}
                                    </span>
                                    <span className={cn("typography-meta ml-2", !isOpenAIAvailable ? "text-[var(--status-error)]/80" : "text-muted-foreground")}>
                                        {isOpenAIAvailable && !openaiApiKey
                                          ? t('settings.voice.page.field.apiKeyHintUsingConfig')
                                          : !isOpenAIAvailable
                                            ? t('settings.voice.page.field.apiKeyHintRequired')
                                            : t('settings.voice.page.field.apiKeyHintProvide')}
                                    </span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="password"
                                            value={openaiApiKey}
                                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {openaiApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* OpenAI-compatible custom server */}
                            {voiceProvider === 'openai-compatible' && (
                                <div className="py-1.5 space-y-2">
                                    <div>
                                        <span className={cn("typography-ui-label text-foreground", !openaiCompatibleUrl.trim() && "text-[var(--status-error)]")}>
                                            {t('settings.voice.page.field.serverUrl')}
                                        </span>
                                        <span className="typography-meta ml-2 text-muted-foreground">
                                            {t('settings.voice.page.field.serverUrlHint')}
                                        </span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input
                                                type="text"
                                                value={openaiCompatibleUrl}
                                                onChange={(e) => setOpenaiCompatibleUrl(e.target.value)}
                                                placeholder="http://localhost:8880/v1"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleUrl && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleUrl('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <Icon name="close" className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">API Key</span>
                                        <span className="typography-meta ml-2 text-muted-foreground">
                                            Optional
                                        </span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input
                                                type="password"
                                                value={openaiCompatibleApiKey}
                                                onChange={(e) => setOpenaiCompatibleApiKey(e.target.value)}
                                                placeholder="sk-..."
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleApiKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleApiKey('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <Icon name="close" className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.model')}</span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input
                                                type="text"
                                                value={openaiCompatibleTtsModel}
                                                onChange={(e) => setOpenaiCompatibleTtsModel(e.target.value)}
                                                placeholder="speaches-ai/Kokoro-82M-v1.0-ONNX"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.voice')}</span>
                                        <span className="typography-meta ml-2 text-muted-foreground">
                                            {t('settings.voice.page.field.voiceIdentifierHint')}
                                        </span>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <div className="relative max-w-xs flex-1">
                                                <input
                                                    type="text"
                                                    value={openaiCompatibleVoice}
                                                    onChange={(e) => setOpenaiCompatibleVoice(e.target.value)}
                                                    placeholder="af_sky"
                                                    className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                                />
                                            </div>
                                            <Button size="xs" variant="ghost" onClick={previewCompatibleVoice} title={t('settings.voice.page.actions.preview')} disabled={!openaiCompatibleUrl.trim()}>
                                                {isCompatiblePreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Local (Kokoro) TTS model status */}
                            {voiceProvider === 'local' && <LocalTtsModelStatus />}

                            {/* Voice Selection */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.voice')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {voiceProvider === 'local' && (
                                        <>
                                            <Select
                                                value={String(localTtsVoiceId)}
                                                onValueChange={(value) => setLocalTtsVoiceId(Number.parseInt(value, 10) || 0)}
                                            >
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')}>
                                                        {(value) => KOKORO_VOICE_OPTIONS.find((v) => String(v.id) === value)?.label ?? value}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {KOKORO_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.id} value={String(v.id)}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewLocalVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isLocalTtsPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                            {localTtsError ? (
                                                <span className="typography-meta text-[var(--status-error)]">{localTtsError}</span>
                                            ) : null}
                                        </>
                                    )}

                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewOpenAIVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isOpenAIPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'openai-compatible' && (
                                        <span className="typography-meta text-muted-foreground">{t('settings.voice.page.field.configuredAbove')}</span>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '$auto'} onValueChange={(value) => setBrowserVoice(value === '$auto' ? '' : value)}>
                                                <SelectTrigger className="w-fit max-w-[200px]">
                                                    <SelectValue placeholder={t('settings.voice.page.field.auto')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="$auto">{t('settings.voice.page.field.auto')}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewBrowserVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isBrowserPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Speech Rate */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechRate')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Pitch */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechPitch')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Volume */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechVolume')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} className={sliderClass} />}
                                    {isMobile ? (
                                        <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className="w-16 tabular-nums" />
                                    ) : (
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3rem] text-right">
                                            {Math.round(speechVolume * 100)}%
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* TTS input mode */}
                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">
                                            {t('settings.voice.page.field.ttsInputMode')}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1">
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={ttsInputMode === 'sanitized'}
                                            onClick={() => setTtsInputMode('sanitized')}
                                            className="!font-normal"
                                        >
                                            {t('settings.voice.page.field.ttsInputModeSanitized')}
                                        </Button>
                                        <Button
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={ttsInputMode === 'raw'}
                                            onClick={() => setTtsInputMode('raw')}
                                            className="!font-normal"
                                        >
                                            {t('settings.voice.page.field.ttsInputModeRaw')}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </section>
            </div>

            {/* Speech Recognition */}
            <div data-settings-item="voice.speech-recognition" className="mb-8">
                    <div className="mb-1 px-1">
                        <h3 className="typography-ui-header font-medium text-foreground">
                            {t('settings.voice.page.section.speechRecognition')}
                        </h3>
                    </div>

                    <section className="px-2 pb-2 pt-0 space-y-0">
                        <div
                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                            role="button"
                            tabIndex={0}
                            aria-pressed={dictationEnabled}
                            onClick={() => setDictationEnabled(!dictationEnabled)}
                            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setDictationEnabled(!dictationEnabled); } }}
                        >
                            <Checkbox checked={dictationEnabled} onChange={setDictationEnabled} ariaLabel={t('settings.voice.page.field.enableVoiceInputAria')} />
                            <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.enableVoiceInput')}</span>
                        </div>

                        {dictationEnabled && (<>
                        <div className="pb-1.5 pt-0.5">
                            <div className="flex min-w-0 flex-col gap-1.5">
                                <div className="flex items-center gap-1.5">
                                    <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.provider')}</span>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8} className="max-w-xs">
                                            <ul className="space-y-1">
                                                <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.sttLocal')}</li>
                                                <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>
                                            </ul>
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                    <Button
                                        variant="chip"
                                        size="xs"
                                        aria-pressed={sttProvider === 'local'}
                                        onClick={() => setSttProvider('local')}
                                        className="!font-normal"
                                    >
                                        {t('settings.voice.page.provider.local')}
                                    </Button>
                                    <Button
                                        variant="chip"
                                        size="xs"
                                        aria-pressed={sttProvider === 'openai-compatible'}
                                        onClick={() => setSttProvider('openai-compatible')}
                                        className="!font-normal"
                                    >
                                        {t('settings.voice.page.provider.server')}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        {sttProvider === 'local' && (
                            <div className="py-1.5">
                                <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.model')}</span>
                                <LocalModelPicker selectedModelId={sttLocalModel} onSelect={setSttLocalModel} />
                            </div>
                        )}

                        {sttProvider === 'openai-compatible' && (
                            <div className="py-1.5 space-y-2">
                                <div>
                                    <span className={cn("typography-ui-label text-foreground", !sttServerUrl.trim() && "text-[var(--status-error)]")}>
                                        {t('settings.voice.page.field.serverUrl')}
                                    </span>
                                    <span className="typography-meta ml-2 text-muted-foreground">
                                        {t('settings.voice.page.field.sttServerUrlHint')}
                                    </span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="text"
                                            value={sttServerUrl}
                                            onChange={(e) => setSttServerUrl(e.target.value)}
                                            placeholder="http://localhost:8001/v1"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttServerUrl && (
                                            <button
                                                type="button"
                                                onClick={() => setSttServerUrl('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <span className="typography-ui-label text-foreground">API Key</span>
                                    <span className="typography-meta ml-2 text-muted-foreground">
                                        Optional
                                    </span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="password"
                                            value={sttApiKey}
                                            onChange={(e) => setSttApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setSttApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.model')}</span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="text"
                                            value={sttModel}
                                            onChange={(e) => setSttModel(e.target.value)}
                                            placeholder="deepdml/faster-whisper-large-v3-turbo-ct2"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.language')}</span>
                                    <span className="typography-meta ml-2 text-muted-foreground">
                                        {t('settings.voice.page.field.sttLanguageHint')}
                                    </span>
                                    <div className="relative mt-1.5 max-w-[8rem]">
                                        <input
                                            type="text"
                                            value={sttLanguage}
                                            onChange={(e) => setSttLanguage(e.target.value)}
                                            placeholder="auto"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        </>)}
                    </section>
            </div>


        </div>
    );
};
