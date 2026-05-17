import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useBrowserVoice } from '@/hooks/useBrowserVoice';
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
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { audioStreamService } from '@/lib/voice/audioStreamService';
import { wasmSttService, WASM_MODELS } from '@/lib/voice/wasmSttService';
import type { WasmModelStatus } from '@/lib/voice/wasmSttService';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
const LANGUAGE_OPTIONS = [
    { value: 'en-US', label: 'English' },
    { value: 'es-ES', label: 'Español' },
    { value: 'fr-FR', label: 'Français' },
    { value: 'de-DE', label: 'Deutsch' },
    { value: 'ja-JP', label: '日本語' },
    { value: 'zh-CN', label: '中文' },
    { value: 'pt-BR', label: 'Português' },
    { value: 'it-IT', label: 'Italiano' },
    { value: 'ko-KR', label: '한국어' },
    { value: 'uk-UA', label: 'Українська' },
];

const WasmModelStatusIndicator = ({ modelId }: { modelId: string }) => {
    const { t } = useI18n();
    const [status, setStatus] = useState<WasmModelStatus>(wasmSttService.getModelStatus());
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const handler = (s: WasmModelStatus) => setStatus(s);
        wasmSttService.onModelStatusChange = handler;
        return () => { wasmSttService.onModelStatusChange = null; };
    }, []);

    const currentModelId = wasmSttService.getCurrentModelId();
    const isLoadingOrDownloading = status.state === 'downloading' || status.state === 'loading';

    // Reset local loading state when model finishes loading or errors
    useEffect(() => {
        if (status.state !== 'downloading' && status.state !== 'loading') {
            setLoading(false);
        }
    }, [status.state]);

    const handleDownload = async () => {
        setLoading(true);
        try {
            await wasmSttService.loadModel(modelId);
        } catch {
            // Error is shown via status indicator
        }
    };

    if (status.state === 'ready' && currentModelId === modelId) {
        return (
            <div className="flex items-center gap-2">
                <span className="typography-ui-compact text-green-600 dark:text-green-400">
                    {t('settings.voice.page.stt.wasmLoaded')}
                </span>
            </div>
        );
    }

    if (isLoadingOrDownloading) {
        const progress = status.state === 'downloading' ? Math.round(status.progress) : undefined;
        return (
            <div className="flex items-center gap-2">
                <span className="typography-ui-compact text-muted-foreground">
                    {status.state === 'downloading' ? t('settings.voice.page.stt.wasmDownloading') : t('settings.voice.page.stt.wasmLoading')}
                    {progress !== undefined ? ` (${progress}%)` : ''}
                </span>
            </div>
        );
    }

    if (status.state === 'error') {
        // Partial download (cached progress): show retry button.
        return (
            <div className="flex items-center gap-2">
                <span className="typography-ui-compact text-destructive">{status.error}</span>
                <Button variant="chip" size="xs" disabled={loading} onClick={handleDownload}>
                    {t('settings.voice.page.stt.wasmRetry')}
                </Button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <span className="typography-ui-compact text-muted-foreground">
                {t('settings.voice.page.stt.wasmNotLoaded')}
            </span>
            <Button variant="chip" size="xs" disabled={loading} onClick={handleDownload}>
                {t('settings.voice.page.stt.wasmDownload')}
            </Button>
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
    const {
        isSupported,
        language,
        setLanguage,
    } = useBrowserVoice();
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
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const setBrowserVoice = useConfigStore((state) => state.setBrowserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const setOpenaiVoice = useConfigStore((state) => state.setOpenaiVoice);
    const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
    const setOpenaiApiKey = useConfigStore((state) => state.setOpenaiApiKey);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const setOpenaiCompatibleUrl = useConfigStore((state) => state.setOpenaiCompatibleUrl);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const setOpenaiCompatibleVoice = useConfigStore((state) => state.setOpenaiCompatibleVoice);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const setOpenaiCompatibleTtsModel = useConfigStore((state) => state.setOpenaiCompatibleTtsModel);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    // STT settings
    const sttProvider = useConfigStore((state) => state.sttProvider);
    const setSttProvider = useConfigStore((state) => state.setSttProvider);
    const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
    const setSttServerUrl = useConfigStore((state) => state.setSttServerUrl);
    const sttModel = useConfigStore((state) => state.sttModel);
    const setSttModel = useConfigStore((state) => state.setSttModel);
    const wasmSttModel = useConfigStore((state) => state.wasmSttModel);
    const setWasmSttModel = useConfigStore((state) => state.setWasmSttModel);
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const sttSilenceThresholdDb = useConfigStore((state) => state.sttSilenceThresholdDb);
    const setSttSilenceThresholdDb = useConfigStore((state) => state.setSttSilenceThresholdDb);
    const sttSilenceHoldMs = useConfigStore((state) => state.sttSilenceHoldMs);
    const setSttSilenceHoldMs = useConfigStore((state) => state.setSttSilenceHoldMs);
    const sttTranscribeOnStop = useConfigStore((state) => state.sttTranscribeOnStop);
    const setSttTranscribeOnStop = useConfigStore((state) => state.setSttTranscribeOnStop);
    const setShowMessageTTSButtons = useConfigStore((state) => state.setShowMessageTTSButtons);
    const voiceModeEnabled = useConfigStore((state) => state.voiceModeEnabled);
    const setVoiceModeEnabled = useConfigStore((state) => state.setVoiceModeEnabled);
    const summarizeMessageTTS = useConfigStore((state) => state.summarizeMessageTTS);
    const setSummarizeMessageTTS = useConfigStore((state) => state.setSummarizeMessageTTS);
    const summarizeVoiceConversation = useConfigStore((state) => state.summarizeVoiceConversation);
    const setSummarizeVoiceConversation = useConfigStore((state) => state.setSummarizeVoiceConversation);
    const summarizeCharacterThreshold = useConfigStore((state) => state.summarizeCharacterThreshold);
    const setSummarizeCharacterThreshold = useConfigStore((state) => state.setSummarizeCharacterThreshold);
    const summarizeMaxLength = useConfigStore((state) => state.summarizeMaxLength);
    const setSummarizeMaxLength = useConfigStore((state) => state.setSummarizeMaxLength);

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
        if (!voiceModeEnabled || (voiceProvider !== 'openai' && voiceProvider !== 'openai-compatible')) {
            setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            return;
        }

        const checkOpenAIAvailability = async () => {
            try {
                const response = await fetch('/api/tts/status');
                const data = await response.json();
                const hasServerKey = data.available;
                const hasSettingsKey = openaiApiKey.trim().length > 0;
                setIsOpenAIAvailable(hasServerKey || hasSettingsKey);
            } catch {
                setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            }
        };

        checkOpenAIAvailability();
    }, [openaiApiKey, voiceModeEnabled, voiceProvider]);

    useEffect(() => {
        if (!voiceModeEnabled) {
            setIsSayAvailable(false);
            setSayVoices([]);
            return;
        }

        fetch('/api/tts/say/status')
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
    }, [voiceModeEnabled]);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.currentTime = 0;
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        try {
            const response = await fetch('/api/tts/say/speak', {
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
            const audio = new Audio(url);

            audio.onended = () => {
                URL.revokeObjectURL(url);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            if (previewAudio) {
                previewAudio.pause();
            }
        };
    }, [previewAudio]);

    const previewOpenAIVoice = useCallback(async () => {
        if (openaiPreviewAudio) {
            openaiPreviewAudio.pause();
            openaiPreviewAudio.currentTime = 0;
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
            return;
        }

        setIsOpenAIPreviewPlaying(true);
        try {
            const response = await fetch('/api/tts/speak', {
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
            const audio = new Audio(url);

            audio.onended = () => {
                URL.revokeObjectURL(url);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            setOpenaiPreviewAudio(audio);
            await audio.play();
        } catch {
            setIsOpenAIPreviewPlaying(false);
        }
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey, t]);

    useEffect(() => {
        return () => {
            if (openaiPreviewAudio) {
                openaiPreviewAudio.pause();
            }
        };
    }, [openaiPreviewAudio]);

    const previewCompatibleVoice = useCallback(async () => {
        if (compatiblePreviewAudio) {
            compatiblePreviewAudio.pause();
            compatiblePreviewAudio.currentTime = 0;
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
            return;
        }

        if (!openaiCompatibleUrl.trim()) return;

        setIsCompatiblePreviewPlaying(true);
        try {
            const response = await fetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.customServerLine'),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);

            audio.onended = () => {
                URL.revokeObjectURL(url);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            setCompatiblePreviewAudio(audio);
            await audio.play();
        } catch {
            setIsCompatiblePreviewPlaying(false);
        }
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, speechRate, compatiblePreviewAudio, t]);

    useEffect(() => {
        return () => {
            if (compatiblePreviewAudio) {
                compatiblePreviewAudio.pause();
            }
        };
    }, [compatiblePreviewAudio]);

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";

    return (
        <div className="space-y-8">

            {/* Voice Setup */}
            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        {t('settings.voice.page.section.voiceSetup')}
                    </h3>
                </div>

                <section className="px-2 pb-2 pt-0 space-y-0">

                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={voiceModeEnabled}
                        onClick={() => setVoiceModeEnabled(!voiceModeEnabled)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setVoiceModeEnabled(!voiceModeEnabled); } }}
                    >
                        <Checkbox checked={voiceModeEnabled} onChange={setVoiceModeEnabled} ariaLabel={t('settings.voice.page.field.enableVoiceModeAria')} />
                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.enableVoiceMode')}</span>
                    </div>

                    {voiceModeEnabled && (
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

                            {/* Voice Selection */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.voice')}</span>
                                <div className="flex items-center gap-2 w-fit">
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
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Pitch */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechPitch')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Volume */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechVolume')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    {isMobile ? (
                                        <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className="w-16 tabular-nums" />
                                    ) : (
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3rem] text-right">
                                            {Math.round(speechVolume * 100)}%
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Language */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.language')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    <Select value={language} onValueChange={setLanguage} disabled={!isSupported}>
                                        <SelectTrigger className="w-fit">
                                            <SelectValue placeholder={t('settings.voice.page.field.selectLanguagePlaceholder')} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {LANGUAGE_OPTIONS.map((lang) => (
                                                <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        </>
                    )}
                </section>
            </div>

            {/* Speech Recognition */}
            {voiceModeEnabled && (
                <div className="mb-8">
                    <div className="mb-1 px-1">
                        <h3 className="typography-ui-header font-medium text-foreground">
                            {t('settings.voice.page.section.speechRecognition')}
                        </h3>
                    </div>

                    <section className="px-2 pb-2 pt-0 space-y-0">
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
                                                <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.sttBrowser')}</li>
                                                <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>
                                            </ul>
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                    <Button
                                        variant="chip"
                                        size="xs"
                                        aria-pressed={sttProvider === 'browser'}
                                        onClick={() => setSttProvider('browser')}
                                        className="!font-normal"
                                    >
                                        {t('settings.voice.page.provider.browser')}
                                    </Button>
                                    <Button
                                        variant="chip"
                                        size="xs"
                                        aria-pressed={sttProvider === 'server'}
                                        onClick={() => setSttProvider('server')}
                                        className="!font-normal"
                                    >
                                        {t('settings.voice.page.provider.server')}
                                    </Button>
                                    <Button
                                        variant="chip"
                                        size="xs"
                                        aria-pressed={sttProvider === 'wasm'}
                                        onClick={() => setSttProvider('wasm')}
                                        className="!font-normal"
                                    >
                                        {t('settings.voice.page.provider.wasm')}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        {sttProvider === 'server' && (
                            <div className="py-1.5 space-y-2">
                                <div
                                    className="group flex cursor-pointer items-center gap-2 py-1.5"
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={sttTranscribeOnStop}
                                    onClick={() => setSttTranscribeOnStop(!sttTranscribeOnStop)}
                                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSttTranscribeOnStop(!sttTranscribeOnStop); } }}
                                >
                                    <Checkbox checked={sttTranscribeOnStop} onChange={setSttTranscribeOnStop} ariaLabel={t('settings.voice.page.field.transcribeOnStopAria')} />
                                    <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.transcribeOnStop')}</span>
                                </div>

                                {!audioStreamService.isSupported() && (
                                    <p className="typography-meta text-[var(--status-error)]">
                                        {t('settings.voice.page.field.sttBrowserSupportError')}
                                    </p>
                                )}
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
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceThreshold')}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={-60} max={-20} step={1} value={sttSilenceThresholdDb} onChange={(e) => setSttSilenceThresholdDb(Number(e.target.value))} className={sliderClass} />}
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3.5rem] text-right">
                                            {sttSilenceThresholdDb} dB
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceHold')}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={500} max={3000} step={100} value={sttSilenceHoldMs} onChange={(e) => setSttSilenceHoldMs(Number(e.target.value))} className={sliderClass} />}
                                        <NumberInput value={sttSilenceHoldMs} onValueChange={setSttSilenceHoldMs} min={500} max={3000} step={100} className="w-20 tabular-nums" />
                                        <span className="typography-meta text-muted-foreground">{t('settings.voice.page.field.millisecondsUnit')}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {sttProvider === 'wasm' && (
                            <div className="py-1.5 space-y-2">
                                <div>
                                    <span className="typography-ui-label text-muted-foreground">
                                        {t('settings.voice.page.stt.wasmModel')}
                                    </span>
                                    <Select value={wasmSttModel} onValueChange={setWasmSttModel}>
                                        <SelectTrigger className="mt-0.5">
                                            <SelectValue placeholder={t('settings.voice.page.stt.wasmModel')} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {WASM_MODELS.map((m) => (
                                                <SelectItem key={m.id} value={m.id}>
                                                    <div className="flex flex-col">
                                                        <span>{m.name}</span>
                                                        <span className="typography-ui-compact text-muted-foreground">
                                                            {m.size} · {m.languages}
                                                        </span>
                                                    </div>
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="typography-ui-compact text-muted-foreground mt-0.5">
                                        {WASM_MODELS.find((m) => m.id === wasmSttModel)?.description}
                                    </p>
                                </div>
                                {/* Model status indicator */}
                                <WasmModelStatusIndicator modelId={wasmSttModel} />
                            </div>
                        )}
                    </section>
                </div>
            )}

            {/* Playback & Summarization */}
            <div className="mb-8">
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

                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={summarizeMessageTTS}
                        onClick={() => setSummarizeMessageTTS(!summarizeMessageTTS)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSummarizeMessageTTS(!summarizeMessageTTS); } }}
                    >
                        <Checkbox checked={summarizeMessageTTS} onChange={setSummarizeMessageTTS} ariaLabel={t('settings.voice.page.field.summarizeBeforePlaybackAria')} />
                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.summarizeBeforePlayback')}</span>
                    </div>

                    {voiceModeEnabled && (
                        <div
                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                            role="button"
                            tabIndex={0}
                            aria-pressed={summarizeVoiceConversation}
                            onClick={() => setSummarizeVoiceConversation(!summarizeVoiceConversation)}
                            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSummarizeVoiceConversation(!summarizeVoiceConversation); } }}
                        >
                            <Checkbox checked={summarizeVoiceConversation} onChange={setSummarizeVoiceConversation} ariaLabel={t('settings.voice.page.field.summarizeVoiceModeResponsesAria')} />
                            <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.summarizeVoiceModeResponses')}</span>
                        </div>
                    )}

                    {(summarizeMessageTTS || summarizeVoiceConversation) && (
                        <>
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.summarizationThreshold')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeCharacterThreshold} onChange={(e) => setSummarizeCharacterThreshold(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={summarizeCharacterThreshold} onValueChange={setSummarizeCharacterThreshold} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.summaryMaxLength')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeMaxLength} onChange={(e) => setSummarizeMaxLength(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={summarizeMaxLength} onValueChange={setSummarizeMaxLength} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                </div>
                            </div>
                        </>
                    )}
                </section>

                {voiceModeEnabled && isSupported && (
                    <div className="mt-2 px-2">
                        <p className="typography-meta text-muted-foreground">
                            {t('settings.voice.page.hint.shiftClickPrefix')}
                            {' '}
                            <kbd className="px-1 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Shift</kbd>
                            {' + '}
                            <kbd className="px-1 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Click</kbd>
                            {' '}
                            {t('settings.voice.page.hint.shiftClickSuffix')}
                        </p>
                    </div>
                )}
            </div>

        </div>
    );
};
