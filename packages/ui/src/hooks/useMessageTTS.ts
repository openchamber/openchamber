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
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { summarizeText, shouldSummarize, sanitizeForTTS } from '@/lib/voice/summarize';

export interface UseMessageTTSReturn {
    /** Whether TTS is currently playing for this message */
    isPlaying: boolean;
    /** Play the message text */
    play: (text: string) => Promise<void>;
    /** Stop playback */
    stop: () => void;
}

export function useMessageTTS(): UseMessageTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);
    
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const summarizeMessageTTS = useConfigStore((state) => state.summarizeMessageTTS);
    const summarizeCharacterThreshold = useConfigStore((state) => state.summarizeCharacterThreshold);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);

    const shouldCheckOpenAIAvailability = showMessageTTSButtons && voiceProvider === 'openai';
    const shouldCheckSayAvailability = showMessageTTSButtons && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, isAvailable: isServerTTSAvailable } = useServerTTS({
        enabled: shouldCheckOpenAIAvailability,
    });
    const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    
    const stop = useCallback(() => {
        setIsPlaying(false);
        stopServerTTS();
        stopSayTTS();
        browserVoiceService.cancelSpeech();
    }, [stopServerTTS, stopSayTTS]);
    
    const play = useCallback(async (text: string) => {
        if (!text.trim()) return;
        
        // Stop any existing playback
        stop();
        
        setIsPlaying(true);
        
        try {
            // Summarize text if enabled and over threshold
            let textToSpeak = text;
            if (summarizeMessageTTS && shouldSummarize(text, 'message')) {
                textToSpeak = await summarizeText(text, {
                    threshold: summarizeCharacterThreshold,
                });
            } else {
                // Still sanitize for TTS even when not summarizing
                textToSpeak = sanitizeForTTS(text);
            }
            
            if (voiceProvider === 'openai' && isServerTTSAvailable) {
                await speakServerTTS(textToSpeak, {
                    voice: openaiVoice,
                    speed: speechRate,
                    summarize: false, // We already summarized client-side
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(textToSpeak, {
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
                    textToSpeak,
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
        speechRate,
        speechPitch,
        speechVolume,
        sayVoice,
        browserVoice,
        openaiVoice,
        summarizeMessageTTS,
        summarizeCharacterThreshold,
        isServerTTSAvailable,
        isSayTTSAvailable,
        speakServerTTS,
        speakSayTTS,
        stop,
    ]);
    
    return {
        isPlaying,
        play,
        stop,
    };
}
