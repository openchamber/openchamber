/**
 * useLocalTTS Hook
 *
 * React hook for local (Kokoro via sherpa-onnx) text-to-speech playback.
 * Synthesis runs on the OpenChamber server in the dictation worker.
 *
 * Long texts are pipelined by sentence chunks: the first chunk starts playing
 * as soon as it is synthesized while the next chunk synthesizes in the
 * background, so time-to-first-audio stays ~1 chunk regardless of message
 * length.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface LocalTTSSpeakOptions {
    /** Kokoro speaker id (0-10) */
    speakerId?: number;
    /** Playback speed multiplier (1.0 = normal) */
    speed?: number;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (error: string) => void;
}

export interface UseLocalTTSReturn {
    isPlaying: boolean;
    error: string | null;
    speak: (text: string, options?: LocalTTSSpeakOptions) => Promise<void>;
    stop: () => void;
    /** Unlock audio for mobile Safari - call this on user gesture */
    unlockAudio: () => Promise<void>;
}

/** Target chunk size: big enough to amortize requests, small enough for low latency. */
const MIN_CHUNK_CHARS = 60;
const MAX_CHUNK_CHARS = 400;

/**
 * Split text into sentence-aligned chunks for pipelined synthesis.
 * Sentences are merged until MIN_CHUNK_CHARS and hard-split at
 * MAX_CHUNK_CHARS so a single run-on sentence cannot stall the pipeline.
 */
export function splitTextForSynthesis(text: string): string[] {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return [];
    }

    const sentences = normalized.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [normalized];

    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
        for (let offset = 0; offset < sentence.length; offset += MAX_CHUNK_CHARS) {
            const piece = sentence.slice(offset, offset + MAX_CHUNK_CHARS);
            if (current && current.length + piece.length > MAX_CHUNK_CHARS) {
                chunks.push(current.trim());
                current = '';
            }
            current += piece;
            if (current.length >= MIN_CHUNK_CHARS && /[.!?…]["')\]]*\s*$/.test(current)) {
                chunks.push(current.trim());
                current = '';
            }
        }
    }
    if (current.trim()) {
        chunks.push(current.trim());
    }

    // Latency trim for the FIRST chunk only: if the opening sentence is long,
    // split it at a clause boundary (comma/semicolon/colon) so the first
    // audio starts sooner. Only the first chunk gets this treatment — comma
    // splits inside every sentence would chop the prosody, and after playback
    // starts the pipeline hides synthesis time anyway.
    if (chunks.length > 0 && chunks[0].length > 120) {
        const first = chunks[0];
        const clauseBreak = /[,;:]\s/g;
        let bestBreak = -1;
        let match: RegExpExecArray | null;
        while ((match = clauseBreak.exec(first)) !== null) {
            const end = match.index + 1;
            if (end < 40) {
                continue;
            }
            if (end > 160) {
                break;
            }
            bestBreak = end;
            break;
        }
        if (bestBreak > 0) {
            const head = first.slice(0, bestBreak).trim();
            const tail = first.slice(bestBreak).trim();
            chunks.splice(0, 1, head, tail);
        }
    }

    return chunks;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
    if (!sharedAudioContext) {
        sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    return sharedAudioContext;
}

interface PlaybackSession {
    cancelled: boolean;
    abort: AbortController;
}

export function useLocalTTS(): UseLocalTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
    const sessionRef = useRef<PlaybackSession | null>(null);

    const unlockAudio = useCallback(async (): Promise<void> => {
        try {
            const ctx = getAudioContext();
            if (ctx.state === 'suspended') {
                await ctx.resume();
            }
            const buffer = ctx.createBuffer(1, 1, 22050);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(0);
        } catch {
            // Unlocking is best-effort.
        }
    }, []);

    const stop = useCallback(() => {
        const session = sessionRef.current;
        if (session) {
            session.cancelled = true;
            session.abort.abort();
            sessionRef.current = null;
        }
        if (audioSourceRef.current) {
            try {
                audioSourceRef.current.onended = null;
                audioSourceRef.current.stop();
            } catch {
                // Already stopped
            }
            audioSourceRef.current = null;
        }
        setIsPlaying(false);
    }, []);

    const speak = useCallback(async (text: string, options?: LocalTTSSpeakOptions): Promise<void> => {
        stop();

        const chunks = splitTextForSynthesis(text);
        if (chunks.length === 0) {
            setError('No text to speak');
            options?.onError?.('No text to speak');
            return;
        }

        setError(null);

        const session: PlaybackSession = { cancelled: false, abort: new AbortController() };
        sessionRef.current = session;

        const fetchChunk = async (chunk: string): Promise<ArrayBuffer> => {
            const response = await runtimeFetch('/api/dictation/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: chunk,
                    ...(typeof options?.speakerId === 'number' ? { speakerId: options.speakerId } : {}),
                    ...(typeof options?.speed === 'number' ? { speed: options.speed } : {}),
                }),
                signal: session.abort.signal,
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            return (await response.blob()).arrayBuffer();
        };

        const playBuffer = async (arrayBuffer: ArrayBuffer): Promise<void> => {
            const ctx = getAudioContext();
            if (ctx.state === 'suspended') {
                await ctx.resume();
            }
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
            if (session.cancelled) {
                return;
            }
            await new Promise<void>((resolve) => {
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                audioSourceRef.current = source;
                source.onended = () => {
                    if (audioSourceRef.current === source) {
                        audioSourceRef.current = null;
                    }
                    resolve();
                };
                source.start(0);
            });
        };

        try {
            setIsPlaying(true);
            options?.onStart?.();

            // Pipelined: synthesize chunk N+1 while chunk N is playing.
            let nextFetch: Promise<ArrayBuffer> = fetchChunk(chunks[0]);
            for (let i = 0; i < chunks.length; i += 1) {
                const buffer = await nextFetch;
                if (session.cancelled) {
                    return;
                }
                if (i + 1 < chunks.length) {
                    nextFetch = fetchChunk(chunks[i + 1]);
                }
                await playBuffer(buffer);
                if (session.cancelled) {
                    return;
                }
            }

            setIsPlaying(false);
            options?.onEnd?.();
        } catch (err) {
            if ((err as Error).name === 'AbortError' || session.cancelled) {
                return;
            }
            const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
            setError(errorMsg);
            options?.onError?.(errorMsg);
            setIsPlaying(false);
        } finally {
            if (sessionRef.current === session) {
                sessionRef.current = null;
            }
        }
    }, [stop]);

    useEffect(() => {
        return () => {
            stop();
        };
    }, [stop]);

    return {
        isPlaying,
        error,
        speak,
        stop,
        unlockAudio,
    };
}
