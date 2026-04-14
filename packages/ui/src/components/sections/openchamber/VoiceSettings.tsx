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
import { RiPlayLine, RiStopLine, RiCloseLine, RiAppleLine, RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { audioStreamService } from '@/lib/voice/audioStreamService';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';
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
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const sttSilenceThresholdDb = useConfigStore((state) => state.sttSilenceThresholdDb);
    const setSttSilenceThresholdDb = useConfigStore((state) => state.setSttSilenceThresholdDb);
    const sttSilenceHoldMs = useConfigStore((state) => state.sttSilenceHoldMs);
    const setSttSilenceHoldMs = useConfigStore((state) => state.setSttSilenceHoldMs);
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
        const voiceName = selectedVoice?.name ?? m.voicePreviewTextBrowserFallback();
        const previewText = m.voicePreviewTextBrowser({ voice: voiceName });

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
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying]);

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
                    text: m.voicePreviewTextSay({ voice: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error(m.voicePreviewError());

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
    }, [sayVoice, speechRate, previewAudio]);

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
                    text: m.voicePreviewTextOpenai({ voice: openaiVoice }),
                    voice: openaiVoice,
                    speed: speechRate,
                    apiKey: openaiApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: m.errUnknown() }));
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
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey]);

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
                    text: m.voicePreviewTextCustom(),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: m.errUnknown() }));
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
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, speechRate, compatiblePreviewAudio]);

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
                        {m.voiceTitle()}
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
                        <Checkbox checked={voiceModeEnabled} onChange={setVoiceModeEnabled} ariaLabel={m.voiceEnableAria()} />
                        <span className="typography-ui-label text-foreground">{m.voiceEnable()}</span>
                    </div>

                    {voiceModeEnabled && (
                        <>
                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">{m.voiceProvider()}</span>
                                        <Tooltip delayDuration={1000}>
                                            <TooltipTrigger asChild>
                                                <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                <ul className="space-y-1">
                                                    <li><strong>{m.voiceProviderBrowser()}:</strong> {m.voiceProviderBrowserDesc()}</li>
                                                    <li><strong>{m.voiceProviderOpenai()}:</strong> {m.voiceProviderOpenaiDesc()}</li>
                                                    <li><strong>{m.voiceProviderCustom()}:</strong> {m.voiceProviderCustomDesc()}</li>
                                                    <li><strong>{m.voiceProviderSay()}:</strong> {m.voiceProviderSayDesc()}</li>
                                                </ul>
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1">
                                        <Button
                                            variant="outline"
                                            size="xs"
                                            onClick={() => setVoiceProvider('browser')}
                                            className={cn(
                                                '!font-normal',
                                                voiceProvider === 'browser'
                                                    ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                    : 'text-foreground'
                                            )}
                                        >
                                            {m.voiceProviderBrowser()}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="xs"
                                            onClick={() => setVoiceProvider('openai')}
                                            className={cn(
                                                '!font-normal',
                                                voiceProvider === 'openai'
                                                    ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                    : 'text-foreground'
                                            )}
                                        >
                                            {m.voiceProviderOpenai()}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="xs"
                                            onClick={() => setVoiceProvider('openai-compatible')}
                                            className={cn(
                                                '!font-normal',
                                                voiceProvider === 'openai-compatible'
                                                    ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                    : 'text-foreground'
                                            )}
                                        >
                                            {m.voiceProviderCustom()}
                                        </Button>
                                        {isSayAvailable && (
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                onClick={() => setVoiceProvider('say')}
                                                className={cn(
                                                    '!font-normal',
                                                    voiceProvider === 'say'
                                                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                        : 'text-foreground'
                                                )}
                                            >
                                                <RiAppleLine className="w-3.5 h-3.5 mr-0.5" />
                                                {m.voiceProviderSay()}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className="py-1.5">
                                    <span className={cn("typography-ui-label text-foreground", !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                        {m.voiceApiKey()}
                                    </span>
                                    <span className={cn("typography-meta ml-2", !isOpenAIAvailable ? "text-[var(--status-error)]/80" : "text-muted-foreground")}>
                                        {isOpenAIAvailable && !openaiApiKey ? m.voiceUsingConfigKey() : !isOpenAIAvailable ? m.voiceTtsRequiresKey() : m.voiceProvideKey()}
                                    </span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="password"
                                            value={openaiApiKey}
                                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                                            placeholder={m.voiceApiKeyPlaceholder()}
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {openaiApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <RiCloseLine className="w-3.5 h-3.5" />
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
                                            {m.voiceServerUrl()}
                                        </span>
                                        <span className="typography-meta ml-2 text-muted-foreground">
                                            {m.voiceServerUrlDesc()}
                                        </span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input
                                                type="text"
                                                value={openaiCompatibleUrl}
                                                onChange={(e) => setOpenaiCompatibleUrl(e.target.value)}
                                                placeholder={m.voiceCompatibleServerPlaceholder()}
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleUrl && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleUrl('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <RiCloseLine className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{m.voiceModel()}</span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input
                                                type="text"
                                                value={openaiCompatibleTtsModel}
                                                onChange={(e) => setOpenaiCompatibleTtsModel(e.target.value)}
                                                placeholder={m.voiceCompatibleModelPlaceholder()}
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{m.voiceVoice()}</span>
                                        <span className="typography-meta ml-2 text-muted-foreground">
                                            {m.voiceVoiceIdentifierDesc()}
                                        </span>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <div className="relative max-w-xs flex-1">
                                                <input
                                                    type="text"
                                                    value={openaiCompatibleVoice}
                                                    onChange={(e) => setOpenaiCompatibleVoice(e.target.value)}
                                                    placeholder={m.voiceCompatibleVoicePlaceholder()}
                                                    className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                                />
                                            </div>
                                            <Button size="xs" variant="ghost" onClick={previewCompatibleVoice} title={m.commonPreview()} disabled={!openaiCompatibleUrl.trim()}>
                                                {isCompatiblePreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Voice Selection */}
                            <div className="flex items-center gap-8 py-1.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceVoice()}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={m.voiceSelectVoice()} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewOpenAIVoice} title={m.commonPreview()}>
                                                {isOpenAIPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'openai-compatible' && (
                                        <span className="typography-meta text-muted-foreground">{m.voiceConfiguredAbove()}</span>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={m.voiceSelectVoice()} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewVoice} title={m.commonPreview()}>
                                                {isPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '__auto__'} onValueChange={(value) => setBrowserVoice(value === '__auto__' ? '' : value)}>
                                                <SelectTrigger className="w-fit max-w-[200px]">
                                                    <SelectValue placeholder={m.voiceAuto()} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__auto__">{m.voiceAuto()}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewBrowserVoice} title={m.commonPreview()}>
                                                {isBrowserPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Speech Rate */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSpeechRate()}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Pitch */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSpeechPitch()}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Volume */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSpeechVolume()}</span>
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
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceLanguage()}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    <Select value={language} onValueChange={setLanguage} disabled={!isSupported}>
                                        <SelectTrigger className="w-fit">
                                            <SelectValue placeholder={m.voiceSelectLanguage()} />
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
                            {m.voiceRecognitionTitle()}
                        </h3>
                    </div>

                    <section className="px-2 pb-2 pt-0 space-y-0">
                        <div className="pb-1.5 pt-0.5">
                            <div className="flex min-w-0 flex-col gap-1.5">
                                <div className="flex items-center gap-1.5">
                                    <span className="typography-ui-label text-foreground">{m.voiceSttProvider()}</span>
                                    <Tooltip delayDuration={1000}>
                                        <TooltipTrigger asChild>
                                            <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8} className="max-w-xs">
                                            <ul className="space-y-1">
                                                <li><strong>{m.voiceSttProviderBrowser()}:</strong> {m.voiceSttBrowserDesc()}</li>
                                                <li><strong>{m.voiceSttProviderServer()}:</strong> {m.voiceSttServerDesc()}</li>
                                            </ul>
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        onClick={() => setSttProvider('browser')}
                                        className={cn(
                                            '!font-normal',
                                            sttProvider === 'browser'
                                                ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                : 'text-foreground'
                                        )}
                                    >
                                        {m.voiceSttProviderBrowser()}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="xs"
                                        onClick={() => setSttProvider('server')}
                                        className={cn(
                                            '!font-normal',
                                            sttProvider === 'server'
                                                ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                : 'text-foreground'
                                        )}
                                    >
                                        {m.voiceSttProviderServer()}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        {sttProvider === 'server' && (
                            <div className="py-1.5 space-y-2">
                                {!audioStreamService.isSupported() && (
                                    <p className="typography-meta text-[var(--status-error)]">
                                        {m.voiceMediaRecorderWarning()}
                                    </p>
                                )}
                                <div>
                                    <span className={cn("typography-ui-label text-foreground", !sttServerUrl.trim() && "text-[var(--status-error)]")}>
                                        {m.voiceSttServerUrl()}
                                    </span>
                                    <span className="typography-meta ml-2 text-muted-foreground">
                                        {m.voiceSttServerUrlDesc()}
                                    </span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="text"
                                            value={sttServerUrl}
                                            onChange={(e) => setSttServerUrl(e.target.value)}
                                            placeholder={m.voiceSttServerPlaceholder()}
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttServerUrl && (
                                            <button
                                                type="button"
                                                onClick={() => setSttServerUrl('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <RiCloseLine className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <span className="typography-ui-label text-foreground">{m.voiceModel()}</span>
                                    <div className="relative mt-1.5 max-w-xs">
                                        <input
                                            type="text"
                                            value={sttModel}
                                            onChange={(e) => setSttModel(e.target.value)}
                                            placeholder={m.voiceSttModelPlaceholder()}
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <span className="typography-ui-label text-foreground">{m.voiceLanguage()}</span>
                                    <span className="typography-meta ml-2 text-muted-foreground">
                                        {m.voiceSttLanguageDesc()}
                                    </span>
                                    <div className="relative mt-1.5 max-w-[8rem]">
                                        <input
                                            type="text"
                                            value={sttLanguage}
                                            onChange={(e) => setSttLanguage(e.target.value)}
                                            placeholder={m.voiceAuto()}
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSilenceThreshold()}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={-60} max={-20} step={1} value={sttSilenceThresholdDb} onChange={(e) => setSttSilenceThresholdDb(Number(e.target.value))} className={sliderClass} />}
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3.5rem] text-right">
                                            {sttSilenceThresholdDb} dB
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSilenceHold()}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={500} max={3000} step={100} value={sttSilenceHoldMs} onChange={(e) => setSttSilenceHoldMs(Number(e.target.value))} className={sliderClass} />}
                                        <NumberInput value={sttSilenceHoldMs} onValueChange={setSttSilenceHoldMs} min={500} max={3000} step={100} className="w-20 tabular-nums" />
                                        <span className="typography-meta text-muted-foreground">{m.voiceHoldMs()}</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            )}

            {/* Playback & Summarization */}
            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        {m.voicePlaybackTitle()}                    </h3>
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
                        <Checkbox checked={showMessageTTSButtons} onChange={setShowMessageTTSButtons} ariaLabel={m.voiceMessageReadAloudAria()} />
                        <span className="typography-ui-label text-foreground">{m.voiceMessageReadAloud()}</span>
                    </div>

                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={summarizeMessageTTS}
                        onClick={() => setSummarizeMessageTTS(!summarizeMessageTTS)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSummarizeMessageTTS(!summarizeMessageTTS); } }}
                    >
                        <Checkbox checked={summarizeMessageTTS} onChange={setSummarizeMessageTTS} ariaLabel={m.voiceSummarizeBeforePlaybackAria()} />
                        <span className="typography-ui-label text-foreground">{m.voiceSummarizeBeforePlayback()}</span>
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
                            <Checkbox checked={summarizeVoiceConversation} onChange={setSummarizeVoiceConversation} ariaLabel={m.voiceSummarizeVoiceResponsesAria()} />
                            <span className="typography-ui-label text-foreground">{m.voiceSummarizeVoiceResponses()}</span>
                        </div>
                    )}

                    {(summarizeMessageTTS || summarizeVoiceConversation) && (
                        <>
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSummarizationThreshold()}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeCharacterThreshold} onChange={(e) => setSummarizeCharacterThreshold(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={summarizeCharacterThreshold} onValueChange={setSummarizeCharacterThreshold} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{m.voiceSummaryMaxLength()}</span>
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
                            {m.voiceMicShortcutHint()}
                        </p>
                    </div>
                )}
            </div>

        </div>
    );
};
