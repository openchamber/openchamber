/**
 * useMessageTTS Hook
 * 
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { ensureLineTerminalPunctuation, sanitizeForTTS } from '@/lib/voice/summarize';
import { requestSmallModel } from '@/lib/smallModelRequest';
import {
    finishReading,
    isCurrentReading,
    startReading,
    stopActiveReading,
    stopReadingUnderKey,
    useIsReading,
} from '@/lib/voice/activeReading';

// Below this length the reply is comfortable to listen to as-is; summarizing
// would only add latency.
const TTS_SUMMARIZE_MIN_CHARS = 600;

const SUMMARIZE_SYSTEM_PROMPT = 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.';

async function summarizeForSpeech(
    text: string,
    preferred: { providerID?: string; modelID?: string },
): Promise<string | null> {
    try {
        const response = await requestSmallModel({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: text,
                system: SUMMARIZE_SYSTEM_PROMPT,
                ...(preferred.providerID ? { preferredProviderID: preferred.providerID } : {}),
                ...(preferred.modelID ? { preferredModelID: preferred.modelID } : {}),
            }),
        // No small model is not an error here: the original reply is spoken.
        }, { silentStatuses: [404] });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null) as { text?: unknown } | null;
        return typeof payload?.text === 'string' && payload.text.trim() ? payload.text.trim() : null;
    } catch {
        return null;
    }
}

export interface PlayMessageTTSOptions {
    /** False reads the text as-is even when the voice settings ask for a summary. */
    summarize?: boolean;
}

export interface UseMessageTTSReturn {
    /** Whether a reading under this hook's key is playing */
    isPlaying: boolean;
    /** Play the text, replacing any reading in progress */
    play: (text: string, options?: PlayMessageTTSOptions) => Promise<void>;
    /** Stop the reading under this hook's key */
    stop: () => void;
}

/**
 * @param readingKey Hooks passing the same key share one reading; without a
 * key the reading is private to this hook.
 */
export function useMessageTTS(readingKey?: string): UseMessageTTSReturn {
    const instanceKey = useId();
    const key = readingKey ?? instanceKey;
    const isPlaying = useIsReading(key);
    const ownTokenRef = useRef<symbol | null>(null);
    
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const localTtsVoiceId = useConfigStore((state) => state.localTtsVoiceId);
    const localTtsModelId = useConfigStore((state) => state.localTtsModelId);
    const ttsFollowTextLanguage = useConfigStore((state) => state.ttsFollowTextLanguage);
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

    const { speak: speakServerTTS, stop: stopServerTTS, isAvailable: isServerTTSAvailable } = useServerTTS({
        enabled: shouldCheckOpenAIAvailability,
        availabilityMode: voiceProvider === 'openai-compatible' ? 'openai-compatible' : 'openai',
    });
    const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS } = useLocalTTS();
    
    const stopPlayback = useCallback(() => {
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        browserVoiceService.cancelSpeech();
    }, [stopServerTTS, stopSayTTS, stopLocalTTS]);

    const stop = useCallback(() => stopReadingUnderKey(key), [key]);

    // The players above go silent when this hook unmounts; a reading it
    // started must not stay marked as playing.
    useEffect(() => () => {
        const token = ownTokenRef.current;
        if (token && isCurrentReading(token)) {
            stopActiveReading();
        }
    }, []);
    
    const play = useCallback(async (text: string, options?: PlayMessageTTSOptions) => {
        if (!text.trim()) return;
        
        const token = startReading(key, stopPlayback);
        ownTokenRef.current = token;
        const finish = () => finishReading(token);
        
        try {
            // Summarized mode: replace long replies with a short spoken-prose
            // summary from the small model; fall back to the sanitized
            // original when summarization is unavailable.
            let sourceText = text;
            const shouldSummarize = options?.summarize !== false
                && ttsInputMode === 'summarized'
                && text.length >= TTS_SUMMARIZE_MIN_CHARS;
            if (shouldSummarize) {
                const { currentProviderId, currentModelId } = useConfigStore.getState();
                const summary = await summarizeForSpeech(text, {
                    providerID: currentProviderId || undefined,
                    modelID: currentModelId || undefined,
                });
                // Stopped or replaced while the summary was being written.
                if (!isCurrentReading(token)) return;
                if (summary) {
                    sourceText = summary;
                }
            }

            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(sourceText);
            const textToSpeak = shouldUseRaw ? sourceText : sanitizedText;
            
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
                    onEnd: finish,
                    onError: finish,
                });
            } else if (voiceProvider === 'local') {
                await speakLocalTTS(sanitizedText, {
                    model: localTtsModelId,
                    speakerId: localTtsVoiceId,
                    speed: speechRate,
                    language: ttsFollowTextLanguage ? 'auto' : undefined,
                    onEnd: finish,
                    onError: finish,
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(ensureLineTerminalPunctuation(sanitizedText), {
                    voice: sayVoice,
                    rate: wordsPerMinute,
                    language: ttsFollowTextLanguage ? 'auto' : undefined,
                    onEnd: finish,
                    onError: finish,
                });
            } else {
                // Browser TTS
                await browserVoiceService.waitForVoices();
                await browserVoiceService.resumeAudioContext();
                if (!isCurrentReading(token)) return;
                await browserVoiceService.speakText(
                    ensureLineTerminalPunctuation(sanitizedText),
                    navigator.language || 'en-US',
                    finish,
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
            finish();
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
        localTtsModelId,
        ttsFollowTextLanguage,
        key,
        stopPlayback,
    ]);
    
    return {
        isPlaying,
        play,
        stop,
    };
}
