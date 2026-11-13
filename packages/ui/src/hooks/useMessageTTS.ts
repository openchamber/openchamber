/**
 * useMessageTTS Hook
 * 
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { type SpeechPart, useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { GEMINI_FAILURE_MESSAGE_KEYS, useGeminiTTS } from './useGeminiTTS';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { startFocusedReading } from '@/lib/voice/readingAudioFocus';
import { ensureLineTerminalPunctuation, sanitizeForTTS } from '@/lib/voice/summarize';
import { type SpeechSegment, splitTablesForSpeech } from '@/lib/voice/speechTables';
import { requestSmallModel } from '@/lib/smallModelRequest';
import {
    isCurrentReading,
    stopActiveReading,
    stopReadingUnderKey,
    useIsReading,
} from '@/lib/voice/activeReading';

// Below this length the reply is comfortable to listen to as-is; summarizing
// would only add latency.
const TTS_SUMMARIZE_MIN_CHARS = 600;
// Enough of the reply for the server to judge its language.
const LANGUAGE_SAMPLE_CHARS = 2000;

const SUMMARIZE_SYSTEM_PROMPT = 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.';

const DESCRIBE_TABLE_SYSTEM_PROMPT = 'You describe one table from an assistant reply for someone listening, not reading. Reply with ONE short spoken sentence, at most 30 words, in the same language as the context (or the table when there is no context), that tells the listener what the table shows and its single most important takeaway. Natural speech, like a colleague pointing at the screen: e.g. "Na tabela dá para ver o tempo de cada provedor, e a OpenAI é a mais lenta." Never list columns or read cells. No markdown.';

interface PreferredModel {
    providerID?: string;
    modelID?: string;
}

async function generateSpokenText(
    prompt: string,
    system: string,
    preferred: PreferredModel,
    requestOptions: Parameters<typeof requestSmallModel>[1],
): Promise<string | null> {
    try {
        const response = await requestSmallModel({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                system,
                // A replay of the same reply asks again; the server answers from its cache.
                cache: true,
                ...(preferred.providerID ? { preferredProviderID: preferred.providerID } : {}),
                ...(preferred.modelID ? { preferredModelID: preferred.modelID } : {}),
            }),
        }, requestOptions);
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null) as { text?: unknown } | null;
        return typeof payload?.text === 'string' && payload.text.trim() ? payload.text.trim() : null;
    } catch {
        return null;
    }
}

// No small model is not an error here: the original reply is spoken.
const summarizeForSpeech = (text: string, preferred: PreferredModel) =>
    generateSpokenText(text, SUMMARIZE_SYSTEM_PROMPT, preferred, { silentStatuses: [404] });

// A table without a description is skipped, so a failure needs no toast.
const describeTableForSpeech = async (
    table: { markdown: string; context: string },
    preferred: PreferredModel,
): Promise<string | null> => {
    const prompt = `Context before the table:\n${table.context || '(none)'}\n\nTable:\n${table.markdown}`;
    const description = await generateSpokenText(prompt, DESCRIBE_TABLE_SYSTEM_PROMPT, preferred, { notifyOnError: false });
    return description ? sanitizeForTTS(description) : null;
};

/** The reply as server speech parts: tables become small-model descriptions written while the prose plays. */
const toServerSpeechParts = (segments: readonly SpeechSegment[], preferred: PreferredModel): SpeechPart[] =>
    segments.map((segment): SpeechPart => {
        if (segment.kind === 'prose') return { kind: 'text', text: sanitizeForTTS(segment.text) };
        // The agent wrote the description with the reply: no model call, no wait.
        if (segment.description) return { kind: 'text', text: sanitizeForTTS(segment.description) };
        return { kind: 'late', text: describeTableForSpeech(segment, preferred) };
    });

export interface PlayMessageTTSOptions {
    /** Rechecked immediately before the first audio starts, after preparation. */
    canStart?: () => boolean;
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
    const geminiVoice = useConfigStore((state) => state.geminiVoice);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const openaiCompatibleTtsEndpointPath = useConfigStore((state) => state.openaiCompatibleTtsEndpointPath);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const autoReadAloudEnabled = useConfigStore((state) => state.autoReadAloudEnabled);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);

    const isServerProvider = voiceProvider === 'openai' || voiceProvider === 'openai-compatible';
    // Auto-read can be on while the per-message buttons are hidden; both
    // paths still need the selected provider's availability.
    const voicePlaybackEnabled = showMessageTTSButtons || autoReadAloudEnabled;
    const shouldCheckOpenAIAvailability = voicePlaybackEnabled && isServerProvider;
    const shouldCheckSayAvailability = voicePlaybackEnabled && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, isAvailable: isServerTTSAvailable } = useServerTTS({
        enabled: shouldCheckOpenAIAvailability,
        availabilityMode: voiceProvider === 'openai-compatible' ? 'openai-compatible' : 'openai',
    });
    const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS } = useLocalTTS();
    const { speak: speakGeminiTTS, stop: stopGeminiTTS } = useGeminiTTS();
    const { t } = useI18n();
    
    const stopPlayback = useCallback(() => {
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        stopGeminiTTS();
        browserVoiceService.cancelSpeech();
    }, [stopServerTTS, stopSayTTS, stopLocalTTS, stopGeminiTTS]);

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
        
        const { token, finish, beforePlayback } = startFocusedReading(key, stopPlayback, options?.canStart);
        ownTokenRef.current = token;
        
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

            // Tables are never read cell by cell. Every voice speaks the
            // description the agent wrote above a table; without one the
            // server voices ask the small model and the others skip it.
            const segments = splitTablesForSpeech(sourceText);
            const hasTables = segments.some((segment) => segment.kind === 'table');
            const proseText = segments
                .flatMap((segment) => segment.kind === 'prose' ? [segment.text] : segment.description ? [segment.description] : [])
                .join('\n');
            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(proseText);
            const speaksServerParts = isServerProvider && isServerTTSAvailable && (shouldUseRaw || hasTables);
            if (!sanitizedText && !speaksServerParts) {
                finish();
                return;
            }
            
            if (isServerProvider && isServerTTSAvailable) {
                const voice = voiceProvider === 'openai-compatible' ? openaiCompatibleVoice : openaiVoice;
                const baseURL = voiceProvider === 'openai-compatible' ? openaiCompatibleUrl : undefined;
                const model = voiceProvider === 'openai-compatible' ? openaiCompatibleTtsModel : undefined;
                const endpointPath = voiceProvider === 'openai-compatible' ? openaiCompatibleTtsEndpointPath : undefined;
                const { currentProviderId, currentModelId } = useConfigStore.getState();
                const speechParts: SpeechPart[] = shouldUseRaw
                    ? [{ kind: 'text', text: sourceText }]
                    : toServerSpeechParts(segments, {
                        providerID: currentProviderId || undefined,
                        modelID: currentModelId || undefined,
                    });
                await speakServerTTS(speechParts, {
                    voice,
                    model,
                    speed: speechRate,
                    pitch: speechPitch,
                    volume: speechVolume,
                    summarize: false,
                    baseURL,
                    beforePlayback,
                    endpointPath,
                    onEnd: finish,
                    onError: finish,
                });
            } else if (voiceProvider === 'gemini') {
                const result = await speakGeminiTTS(sanitizedText, {
                    beforePlayback,
                    voice: geminiVoice,
                    languageSample: text.slice(0, LANGUAGE_SAMPLE_CHARS),
                    pitch: speechPitch,
                    volume: speechVolume,
                });
                if (result.status !== 'failed') {
                    finish();
                    return;
                }
                if (!isCurrentReading(token)) return;
                // The day's free quota, a missing key or an outage must not
                // leave the button silent: read with the local voice instead.
                toast.info(t(GEMINI_FAILURE_MESSAGE_KEYS[result.code]));
                await speakLocalTTS(sanitizedText, {
                    model: localTtsModelId,
                    speakerId: localTtsVoiceId,
                    speed: speechRate,
                    language: 'auto',
                    beforePlayback,
                    onEnd: finish,
                    onError: finish,
                });
            } else if (voiceProvider === 'local') {
                await speakLocalTTS(sanitizedText, {
                    model: localTtsModelId,
                    speakerId: localTtsVoiceId,
                    speed: speechRate,
                    language: ttsFollowTextLanguage ? 'auto' : undefined,
                    beforePlayback,
                    onEnd: finish,
                    onError: finish,
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(ensureLineTerminalPunctuation(sanitizedText), {
                    voice: sayVoice,
                    rate: wordsPerMinute,
                    language: ttsFollowTextLanguage ? 'auto' : undefined,
                    beforePlayback,
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
                        beforePlayback,
                        onError: finish,
                    }
                );
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                finish();
                return;
            }
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
        geminiVoice,
        speakGeminiTTS,
        t,
        openaiCompatibleVoice,
        openaiCompatibleUrl,
        openaiCompatibleTtsModel,
        openaiCompatibleTtsEndpointPath,
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
