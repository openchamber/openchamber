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
import { Switch } from '@/components/ui/switch';
import { ButtonSmall } from '@/components/ui/button-small';
import { NumberInput } from '@/components/ui/number-input';
import { RiPlayLine, RiStopLine, RiCloseLine, RiAppleLine, RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { cn } from '@/lib/utils';

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
    const {
        voiceProvider,
        setVoiceProvider,
        speechRate,
        setSpeechRate,
        speechPitch,
        setSpeechPitch,
        speechVolume,
        setSpeechVolume,
        sayVoice,
        setSayVoice,
        browserVoice,
        setBrowserVoice,
        openaiVoice,
        setOpenaiVoice,
        openaiApiKey,
        setOpenaiApiKey,
        showMessageTTSButtons,
        setShowMessageTTSButtons,
        voiceModeEnabled,
        setVoiceModeEnabled,
        summarizeMessageTTS,
        setSummarizeMessageTTS,
        summarizeVoiceConversation,
        setSummarizeVoiceConversation,
        summarizeCharacterThreshold,
        setSummarizeCharacterThreshold,
        summarizeMaxLength,
        setSummarizeMaxLength,
    } = useConfigStore();

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isOpenAIAvailable, setIsOpenAIAvailable] = useState(false);
    const [isOpenAIPreviewPlaying, setIsOpenAIPreviewPlaying] = useState(false);
    const [openaiPreviewAudio, setOpenaiPreviewAudio] = useState<HTMLAudioElement | null>(null);

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
        const voiceName = selectedVoice?.name ?? 'your browser voice';
        const previewText = `Hello! I'm ${voiceName}. This is how I sound.`;

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
    }, [openaiApiKey]);

    useEffect(() => {
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
    }, []);

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
                    text: `Hello! I'm ${sayVoice}. This is how I sound.`,
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
                    text: `Hello! I'm ${openaiVoice}. This is how I sound.`,
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
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey]);

    useEffect(() => {
        return () => {
            if (openaiPreviewAudio) {
                openaiPreviewAudio.pause();
            }
        };
    }, [openaiPreviewAudio]);

    return (
        <div className="space-y-8">
            
            {/* --- Core Voice Setup --- */}
            <div className="mb-8">
                <div className="mb-3 px-1">
                    <h3 className="typography-ui-header font-semibold text-foreground">
                        Voice Setup
                    </h3>
                    <p className="typography-meta text-muted-foreground mt-0.5">
                        Enable voice features and pick your synthesis provider.
                    </p>
                </div>
                
                <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
                    
                    <label className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30 border-b border-[var(--surface-subtle)]">
                        <div className="flex min-w-0 flex-col">
                            <span className="typography-ui-label text-foreground">Enable Voice Mode</span>
                        </div>
                        <Switch
                            checked={voiceModeEnabled}
                            onCheckedChange={setVoiceModeEnabled}
                            className="data-[state=checked]:bg-[var(--primary-base)]"
                        />
                    </label>

                    {voiceModeEnabled && (
                        <>
                            <div className={cn("px-4 py-3 border-b border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "shrink-0")}>
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">Provider</span>
                                        <Tooltip delayDuration={1000}>
                                            <TooltipTrigger asChild>
                                                <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                <ul className="space-y-1">
                                                    <li><strong>Browser:</strong> Free, offline, limited mobile support.</li>
                                                    <li><strong>OpenAI:</strong> High quality, mobile ready, needs API key.</li>
                                                    <li><strong>Say:</strong> macOS native. Fast, free, offline.</li>
                                                </ul>
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className={cn("flex gap-1 flex-wrap", isMobile ? "w-full" : "justify-end")}>
                                    <ButtonSmall
                                        variant="outline"
                                        onClick={() => setVoiceProvider('browser')}
                                        className={cn(
                                            voiceProvider === 'browser'
                                                ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                : 'text-foreground'
                                        )}
                                    >
                                        Browser
                                    </ButtonSmall>
                                    <ButtonSmall
                                        variant="outline"
                                        onClick={() => setVoiceProvider('openai')}
                                        className={cn(
                                            voiceProvider === 'openai'
                                                ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                : 'text-foreground'
                                        )}
                                    >
                                        OpenAI
                                    </ButtonSmall>
                                    {isSayAvailable && (
                                        <ButtonSmall
                                            variant="outline"
                                            onClick={() => setVoiceProvider('say')}
                                            className={cn(
                                                voiceProvider === 'say'
                                                    ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                    : 'text-foreground'
                                            )}
                                        >
                                            <RiAppleLine className="w-3.5 h-3.5 mr-1" />
                                            Say
                                        </ButtonSmall>
                                    )}
                                </div>
                            </div>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className={cn("flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3", !isOpenAIAvailable && 'bg-[var(--status-error-background)]/20')}>
                                    <div className="flex min-w-0 flex-col">
                                        <span className={cn("typography-ui-label text-foreground", !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                            API Key
                                        </span>
                                        <span className={cn("typography-meta text-muted-foreground", !isOpenAIAvailable && "text-[var(--status-error)]/80")}>
                                            {isOpenAIAvailable && !openaiApiKey ? 'Using key from configuration' : !isOpenAIAvailable ? 'OpenAI TTS requires an API key' : 'Provide your OpenAI key'}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 max-w-xs flex-1 justify-end relative">
                                        <input
                                            type="password"
                                            value={openaiApiKey}
                                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-8 rounded-md border border-[var(--interactive-border)] bg-background px-2 typography-ui text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--primary-base)]"
                                        />
                                        {openaiApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <RiCloseLine className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Voice Selection row (dynamically changes based on provider) */}
                            <div className={cn("px-4 py-3", isMobile ? "flex flex-col gap-3" : "flex items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "shrink-0")}>
                                    <span className="typography-ui-label text-foreground">Voice Selection</span>
                                </div>
                                <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "justify-end flex-1")}>
                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                            <SelectTrigger size="lg" className="w-fit min-w-[120px]">
                                                 <SelectValue placeholder="Select voice" />
                                             </SelectTrigger>
                                             <SelectContent>
                                                 {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="outline" onClick={previewOpenAIVoice} className="px-2" title="Preview">
                                                {isOpenAIPreviewPlaying ? <RiStopLine className="w-4 h-4" /> : <RiPlayLine className="w-4 h-4" />}
                                            </ButtonSmall>
                                        </>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                            <SelectTrigger size="lg" className="w-fit min-w-[120px]">
                                                 <SelectValue placeholder="Select voice" />
                                             </SelectTrigger>
                                             <SelectContent>
                                                 {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="outline" onClick={previewVoice} className="px-2" title="Preview">
                                                {isPreviewPlaying ? <RiStopLine className="w-4 h-4" /> : <RiPlayLine className="w-4 h-4" />}
                                            </ButtonSmall>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '__auto__'} onValueChange={(value) => setBrowserVoice(value === '__auto__' ? '' : value)}>
                                            <SelectTrigger size="lg" className="w-fit min-w-[120px]">
                                                 <SelectValue placeholder="Auto" />
                                             </SelectTrigger>
                                             <SelectContent>
                                                 <SelectItem value="__auto__">Auto</SelectItem>
                                                 {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="outline" onClick={previewBrowserVoice} className="px-2" title="Preview">
                                                {isBrowserPreviewPlaying ? <RiStopLine className="w-4 h-4" /> : <RiPlayLine className="w-4 h-4" />}
                                            </ButtonSmall>
                                        </>
                                    )}
                                </div>
                            </div>
                            
                            {/* Speech Rate/Volume for Browser/Say */}
                            <div className={cn("px-4 py-3 border-t border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex flex-col sm:flex-row sm:items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-1/3 shrink-0")}>
                                    <span className="typography-ui-label text-foreground">Speech Rate</span>
                                </div>
                                <div className={cn("flex items-center gap-3", isMobile ? "w-full" : "flex-1 max-w-xs justify-end")}>
                                    <input
                                        type="range"
                                        min={0.5}
                                        max={2}
                                        step={0.1}
                                        value={speechRate}
                                        onChange={(e) => setSpeechRate(Number(e.target.value))}
                                        disabled={!isSupported}
                                        className="flex-1 min-w-0 h-2 bg-[var(--surface-subtle)] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50"
                                    />
                                    {isMobile ? (
                                        <span className="typography-ui-label font-medium text-foreground tabular-nums rounded-md border border-border bg-background px-3 py-1.5 min-w-[3.75rem] text-center">
                                            {speechRate.toFixed(1)}x
                                        </span>
                                    ) : (
                                        <NumberInput
                                            value={speechRate}
                                            onValueChange={setSpeechRate}
                                            min={0.5}
                                            max={2}
                                            step={0.1}
                                            className="w-16 tabular-nums"
                                        />
                                    )}
                                </div>
                            </div>

                            <div className={cn("px-4 py-3", isMobile ? "flex flex-col gap-3" : "flex flex-col sm:flex-row sm:items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-1/3 shrink-0")}>
                                    <span className="typography-ui-label text-foreground">Speech Pitch</span>
                                </div>
                                <div className={cn("flex items-center gap-3", isMobile ? "w-full" : "flex-1 max-w-xs justify-end")}>
                                    <input
                                        type="range"
                                        min={0.5}
                                        max={2}
                                        step={0.1}
                                        value={speechPitch}
                                        onChange={(e) => setSpeechPitch(Number(e.target.value))}
                                        disabled={!isSupported}
                                        className="flex-1 min-w-0 h-2 bg-[var(--surface-subtle)] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50"
                                    />
                                    {isMobile ? (
                                        <span className="typography-ui-label font-medium text-foreground tabular-nums rounded-md border border-border bg-background px-3 py-1.5 min-w-[3.75rem] text-center">
                                            {speechPitch.toFixed(1)}x
                                        </span>
                                    ) : (
                                        <NumberInput
                                            value={speechPitch}
                                            onValueChange={setSpeechPitch}
                                            min={0.5}
                                            max={2}
                                            step={0.1}
                                            className="w-16 tabular-nums"
                                        />
                                    )}
                                </div>
                            </div>

                            <div className={cn("px-4 py-3", isMobile ? "flex flex-col gap-3" : "flex flex-col sm:flex-row sm:items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-1/3 shrink-0")}>
                                    <span className="typography-ui-label text-foreground">Speech Volume</span>
                                </div>
                                <div className={cn("flex items-center gap-3", isMobile ? "w-full" : "flex-1 max-w-xs justify-end")}>
                                    <input
                                        type="range"
                                        min={0}
                                        max={1}
                                        step={0.1}
                                        value={speechVolume}
                                        onChange={(e) => setSpeechVolume(Number(e.target.value))}
                                        disabled={!isSupported}
                                        className="flex-1 min-w-0 h-2 bg-[var(--surface-subtle)] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50"
                                    />
                                    <span className="typography-ui-label font-medium text-foreground tabular-nums min-w-[3rem] text-right">
                                        {Math.round(speechVolume * 100)}%
                                    </span>
                                </div>
                            </div>
                            
                            <div className={cn("px-4 py-3 border-t border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex items-center justify-between gap-4")}>
                                <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "shrink-0")}>
                                    <span className="typography-ui-label text-foreground">Language</span>
                                </div>
                                <div className={cn("flex", isMobile ? "w-full" : "justify-end flex-1")}>
                                    <Select value={language} onValueChange={setLanguage} disabled={!isSupported}>
                                         <SelectTrigger size="lg" className="w-fit min-w-[120px]">
                                              <SelectValue placeholder="Select language" />
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
                </div>
            </div>

            {/* --- Feature Settings --- */}
            <div className="mb-8">
                <div className="mb-3 px-1">
                    <h3 className="typography-ui-header font-semibold text-foreground">
                        Voice Features
                    </h3>
                    <p className="typography-meta text-muted-foreground mt-0.5">
                        Options for playback and auto-summarization.
                    </p>
                </div>
                
                <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
                    <label className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30 border-b border-[var(--surface-subtle)]">
                        <div className="flex min-w-0 flex-col">
                            <span className="typography-ui-label text-foreground">Message Read Aloud Button</span>
                        </div>
                        <Switch
                            checked={showMessageTTSButtons}
                            onCheckedChange={setShowMessageTTSButtons}
                            className="data-[state=checked]:bg-[var(--primary-base)]"
                        />
                    </label>

                    <label className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30 border-b border-[var(--surface-subtle)]">
                        <div className="flex min-w-0 flex-col">
                            <span className="typography-ui-label text-foreground">Summarize Before Playback</span>
                        </div>
                        <Switch
                            checked={summarizeMessageTTS}
                            onCheckedChange={setSummarizeMessageTTS}
                            className="data-[state=checked]:bg-[var(--primary-base)]"
                        />
                    </label>

                    {voiceModeEnabled && (
                        <label className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30 border-b border-[var(--surface-subtle)]">
                            <div className="flex min-w-0 flex-col">
                                <span className="typography-ui-label text-foreground">Summarize Voice Mode Responses</span>
                            </div>
                            <Switch
                                checked={summarizeVoiceConversation}
                                onCheckedChange={setSummarizeVoiceConversation}
                                className="data-[state=checked]:bg-[var(--primary-base)]"
                            />
                        </label>
                    )}

                    {(summarizeMessageTTS || summarizeVoiceConversation) && (
                        <>
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3">
                                <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                                    <span className="typography-ui-label text-foreground">Summarization Threshold</span>
                                </div>
                                <div className="flex items-center gap-3 flex-1 max-w-xs justify-end">
                                    <input
                                        type="range"
                                        min={50}
                                        max={2000}
                                        step={50}
                                        value={summarizeCharacterThreshold}
                                        onChange={(e) => setSummarizeCharacterThreshold(Number(e.target.value))}
                                        className="flex-1 min-w-0 h-2 bg-[var(--surface-subtle)] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)]"
                                    />
                                    <NumberInput
                                        value={summarizeCharacterThreshold}
                                        onValueChange={setSummarizeCharacterThreshold}
                                        min={50}
                                        max={2000}
                                        step={50}
                                        className="w-16 tabular-nums"
                                    />
                                </div>
                            </div>
                            
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-t border-[var(--surface-subtle)]">
                                <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                                    <span className="typography-ui-label text-foreground">Summary Max Length</span>
                                </div>
                                <div className="flex items-center gap-3 flex-1 max-w-xs justify-end">
                                    <input
                                        type="range"
                                        min={50}
                                        max={2000}
                                        step={50}
                                        value={summarizeMaxLength}
                                        onChange={(e) => setSummarizeMaxLength(Number(e.target.value))}
                                        className="flex-1 min-w-0 h-2 bg-[var(--surface-subtle)] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)]"
                                    />
                                    <NumberInput
                                        value={summarizeMaxLength}
                                        onValueChange={setSummarizeMaxLength}
                                        min={50}
                                        max={2000}
                                        step={50}
                                        className="w-16 tabular-nums"
                                    />
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {voiceModeEnabled && isSupported && (
                    <div className="mt-4 px-3 rounded-lg bg-muted/30 p-3">
                        <p className="typography-meta text-foreground font-medium mb-1">Keyboard Shortcut</p>
                        <p className="typography-meta text-muted-foreground">
                            Press <kbd className="px-1.5 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Shift</kbd> + <kbd className="px-1.5 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Click</kbd> on the mic button to quickly toggle continuous mode
                        </p>
                    </div>
                )}
            </div>
            
        </div>
    );
};
