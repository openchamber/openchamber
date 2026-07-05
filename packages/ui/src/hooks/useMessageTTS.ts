/**
 * useMessageTTS Hook
 * 
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useCallback, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { sanitizeForTTS } from '@/lib/voice/summarize';

export interface UseMessageTTSReturn {
    /** Whether TTS is currently playing for this message */
    isPlaying: boolean;
    /** Whether TTS is currently paused */
    isPaused: boolean;
    /** Play the message text */
    play: (text: string) => Promise<void>;
    /** Stop playback */
    stop: () => void;
    /** Pause playback (keeps connection alive) */
    pause: () => void;
    /** Resume playback */
    resume: () => void;
}

export function useMessageTTS(): UseMessageTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const localTtsVoiceId = useConfigStore((state) => state.localTtsVoiceId);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);

    const isServerProvider = voiceProvider === 'openai' || voiceProvider === 'openai-compatible';
    const shouldCheckOpenAIAvailability = showMessageTTSButtons && isServerProvider;
    const shouldCheckSayAvailability = showMessageTTSButtons && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, pause: pauseServerTTS, resume: resumeServerTTS, isAvailable: isServerTTSAvailable } = useServerTTS({
        enabled: shouldCheckOpenAIAvailability,
        availabilityMode: voiceProvider === 'openai-compatible' ? 'openai-compatible' : 'openai',
    });
    const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS } = useLocalTTS();
    
    const stop = useCallback(() => {
        setIsPlaying(false);
        setIsPaused(false);
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        browserVoiceService.cancelSpeech();
    }, [stopServerTTS, stopSayTTS, stopLocalTTS]);

    const pause = useCallback(() => {
        if (isServerProvider) {
            pauseServerTTS();
            setIsPaused(true);
        }
    }, [isServerProvider, pauseServerTTS]);

    const resume = useCallback(() => {
        if (isServerProvider) {
            resumeServerTTS();
            setIsPaused(false);
        }
    }, [isServerProvider, resumeServerTTS]);
    
    const play = useCallback(async (text: string) => {
        if (!text.trim()) return;
        
        // Stop any existing playback
        stop();
        
        setIsPlaying(true);
        
        try {
            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(text);
            const textToSpeak = shouldUseRaw ? text : sanitizedText;
            
            if (isServerProvider && isServerTTSAvailable) {
                const voice = voiceProvider === 'openai-compatible' ? openaiCompatibleVoice : openaiVoice;
                const baseURL = voiceProvider === 'openai-compatible' ? openaiCompatibleUrl : undefined;
                const model = voiceProvider === 'openai-compatible' ? openaiCompatibleTtsModel : undefined;
                await speakServerTTS(textToSpeak, {
                    voice,
                    model,
                    speed: speechRate,
                    pitch: speechPitch,
                    volume: speechVolume,
                    summarize: false,
                    baseURL,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else if (voiceProvider === 'local') {
                await speakLocalTTS(sanitizedText, {
                    speakerId: localTtsVoiceId,
                    speed: speechRate,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(sanitizedText, {
                    voice: sayVoice,
                    rate: wordsPerMinute,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else {
                // Browser TTS
                await browserVoiceService.waitForVoices();
                await browserVoiceService.resumeAudioContext();
                await browserVoiceService.speakText(
                    sanitizedText,
                    navigator.language || 'en-US',
                    () => setIsPlaying(false),
                    {
                        rate: speechRate,
                        pitch: speechPitch,
                        volume: speechVolume,
                        voiceName: browserVoice || undefined,
                    }
                );
            }
        } catch (err) {
            console.error('[useMessageTTS] Playback error:', err);
            setIsPlaying(false);
        }
    }, [
        voiceProvider,
        isServerProvider,
        speechRate,
        speechPitch,
        speechVolume,
        sayVoice,
        browserVoice,
        openaiVoice,
        openaiCompatibleVoice,
        openaiCompatibleUrl,
        openaiCompatibleTtsModel,
        isServerTTSAvailable,
        isSayTTSAvailable,
        ttsInputMode,
        speakServerTTS,
        speakSayTTS,
        speakLocalTTS,
        localTtsVoiceId,
        stop,
    ]);
    
    return {
        isPlaying,
        isPaused,
        play,
        stop,
        pause,
        resume,
    };
}
