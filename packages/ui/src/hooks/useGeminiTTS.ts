/**
 * Read-aloud through Gemini. The server holds the key, detects the language
 * and calls Gemini once per reading: the free tier allows about ten requests
 * a day, so the text is never split into sentence requests.
 */

import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ReadingPlayback } from '@/lib/voice/readingAudioFocus';

export const GEMINI_VOICE_OPTIONS = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'] as const;

const geminiFailureCodeSchema = z.enum(['key_missing', 'key_rejected', 'quota_exceeded', 'no_credit', 'enterprise_mode', 'upstream_error']);
const geminiFailureSchema = z.object({ code: geminiFailureCodeSchema.catch('upstream_error') });

type GeminiFailureCode = z.infer<typeof geminiFailureCodeSchema>;

/** What to tell the user for each failure, as i18n keys. */
export const GEMINI_FAILURE_MESSAGE_KEYS = {
    key_missing: 'chat.messageBody.tts.gemini.keyMissing',
    key_rejected: 'chat.messageBody.tts.gemini.keyRejected',
    quota_exceeded: 'chat.messageBody.tts.gemini.quotaExceeded',
    no_credit: 'chat.messageBody.tts.gemini.noCredit',
    enterprise_mode: 'chat.messageBody.tts.gemini.enterpriseMode',
    upstream_error: 'chat.messageBody.tts.gemini.unavailable',
} as const satisfies Record<GeminiFailureCode, string>;

export type GeminiSpeakResult =
    | { status: 'played' }
    | { status: 'stopped' }
    | { status: 'failed'; code: GeminiFailureCode };

export interface GeminiSpeakOptions {
    beforePlayback?: (playback: ReadingPlayback) => Promise<void>;
    voice: string;
    /** Whole message, so a short summary still reads with the reply's language. */
    languageSample?: string;
    /** 1 keeps the voice's pitch; 2 is an octave up. */
    pitch?: number;
    volume?: number;
    /** Called once playback has started; the promise settles when it ends. */
    onStart?: () => void;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
    if (!sharedAudioContext) {
        sharedAudioContext = new AudioContext();
    }
    return sharedAudioContext;
}

async function failureCodeOf(response: Response): Promise<GeminiFailureCode> {
    const parsed = geminiFailureSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.code : 'upstream_error';
}

export function useGeminiTTS() {
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const settleRef = useRef<((result: GeminiSpeakResult) => void) | null>(null);

    const stop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        const source = sourceRef.current;
        sourceRef.current = null;
        if (source) {
            source.onended = null;
            try {
                source.stop();
            } catch {
                // Already ended.
            }
        }
        settleRef.current?.({ status: 'stopped' });
        settleRef.current = null;
    }, []);

    const speak = useCallback(async (text: string, options: GeminiSpeakOptions): Promise<GeminiSpeakResult> => {
        stop();
        const controller = new AbortController();
        abortRef.current = controller;

        // Resume inside the click's gesture (iOS Safari), without waiting on
        // it: a page that may not play audio yet never settles the promise,
        // and the request must not hang behind it.
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

        let audio: AudioBuffer;
        try {
            const response = await runtimeFetch('/api/tts/gemini/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: options.voice, languageSample: options.languageSample }),
                signal: controller.signal,
            });
            if (!response.ok) return { status: 'failed', code: await failureCodeOf(response) };
            audio = await ctx.decodeAudioData(await response.arrayBuffer());
        } catch (error) {
            if (controller.signal.aborted) return { status: 'stopped' };
            console.warn('[useGeminiTTS] Request failed:', error);
            return { status: 'failed', code: 'upstream_error' };
        }
        if (controller.signal.aborted) return { status: 'stopped' };

        await options.beforePlayback?.({ pause: () => ctx.suspend(), resume: () => ctx.resume() });
        if (controller.signal.aborted) return { status: 'stopped' };

        const source = ctx.createBufferSource();
        source.buffer = audio;
        source.detune.value = ((options.pitch ?? 1) - 1) * 1200;
        const gain = ctx.createGain();
        gain.gain.value = options.volume ?? 1;
        source.connect(gain);
        gain.connect(ctx.destination);
        sourceRef.current = source;

        return new Promise<GeminiSpeakResult>((resolve) => {
            settleRef.current = resolve;
            source.onended = () => {
                sourceRef.current = null;
                settleRef.current = null;
                resolve({ status: 'played' });
            };
            source.start(0);
            options.onStart?.();
        });
    }, [stop]);

    useEffect(() => stop, [stop]);

    return { speak, stop };
}
