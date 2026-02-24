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

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";

    return (
        <div className="space-y-8">

            {/* Voice Setup */}
            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        Voice Setup
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
                        <Checkbox checked={voiceModeEnabled} onChange={setVoiceModeEnabled} ariaLabel="Enable voice mode" />
                        <span className="typography-ui-label text-foreground">Enable Voice Mode</span>
                    </div>

                    {voiceModeEnabled && (
                        <>
                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
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
                                    <div className="flex flex-wrap items-center gap-1">
                                        <ButtonSmall
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
                                            Browser
                                        </ButtonSmall>
                                        <ButtonSmall
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
                                            OpenAI
                                        </ButtonSmall>
                                        {isSayAvailable && (
                                            <ButtonSmall
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
                                                Say
                                            </ButtonSmall>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className="py-1.5">
                                    <span className={cn("typography-ui-label text-foreground", !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                        API Key
                                    </span>
                                    <span className={cn("typography-meta ml-2", !isOpenAIAvailable ? "text-[var(--status-error)]/80" : "text-muted-foreground")}>
                                        {isOpenAIAvailable && !openaiApiKey ? 'Using key from configuration' : !isOpenAIAvailable ? 'OpenAI TTS requires an API key' : 'Provide your OpenAI key'}
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
                                                <RiCloseLine className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Voice Selection */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Voice</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder="Select voice" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="ghost" className="h-7 w-7 px-0" onClick={previewOpenAIVoice} title="Preview">
                                                {isOpenAIPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </ButtonSmall>
                                        </>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder="Select voice" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="ghost" className="h-7 w-7 px-0" onClick={previewVoice} title="Preview">
                                                {isPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </ButtonSmall>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '__auto__'} onValueChange={(value) => setBrowserVoice(value === '__auto__' ? '' : value)}>
                                                <SelectTrigger className="w-fit max-w-[200px]">
                                                    <SelectValue placeholder="Auto" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__auto__">Auto</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <ButtonSmall variant="ghost" className="h-7 w-7 px-0" onClick={previewBrowserVoice} title="Preview">
                                                {isBrowserPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </ButtonSmall>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Speech Rate */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Speech Rate</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Pitch */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Speech Pitch</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} disabled={!isSupported} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            {/* Speech Volume */}
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Speech Volume</span>
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
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Language</span>
                                <div className="flex items-center gap-2 w-fit">
                                    <Select value={language} onValueChange={setLanguage} disabled={!isSupported}>
                                        <SelectTrigger className="w-fit">
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
                </section>
            </div>

            {/* Playback & Summarization */}
            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        Playback & Summarization
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
                        <Checkbox checked={showMessageTTSButtons} onChange={setShowMessageTTSButtons} ariaLabel="Message read aloud button" />
                        <span className="typography-ui-label text-foreground">Message Read Aloud Button</span>
                    </div>

                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={summarizeMessageTTS}
                        onClick={() => setSummarizeMessageTTS(!summarizeMessageTTS)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSummarizeMessageTTS(!summarizeMessageTTS); } }}
                    >
                        <Checkbox checked={summarizeMessageTTS} onChange={setSummarizeMessageTTS} ariaLabel="Summarize before playback" />
                        <span className="typography-ui-label text-foreground">Summarize Before Playback</span>
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
                            <Checkbox checked={summarizeVoiceConversation} onChange={setSummarizeVoiceConversation} ariaLabel="Summarize voice mode responses" />
                            <span className="typography-ui-label text-foreground">Summarize Voice Mode Responses</span>
                        </div>
                    )}

                    {(summarizeMessageTTS || summarizeVoiceConversation) && (
                        <>
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Summarization Threshold</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeCharacterThreshold} onChange={(e) => setSummarizeCharacterThreshold(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={summarizeCharacterThreshold} onValueChange={setSummarizeCharacterThreshold} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">Summary Max Length</span>
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
                            Press <kbd className="px-1 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Shift</kbd> + <kbd className="px-1 py-0.5 mx-0.5 rounded border border-[var(--interactive-border)] bg-background typography-mono text-[10px]">Click</kbd> on the mic button to toggle continuous mode
                        </p>
                    </div>
                )}
            </div>

        </div>
    );
};
