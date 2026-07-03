/**
 * Microphone capture for dictation (ported from paseo's web audio source).
 *
 * Captures mono audio via getUserMedia, taps it with a ScriptProcessorNode
 * (universally supported, including iOS WKWebView), resamples Float32 to
 * 16 kHz PCM16LE, and emits ~1-second base64 chunks plus a normalized RMS
 * volume for the level meter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface DictationAudioSourceConfig {
    onPcmSegment: (base64Pcm: string) => void;
    onError?: (error: Error) => void;
}

export interface DictationAudioSource {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    volume: number;
}

const OUTPUT_RATE = 16000;
const CHUNK_SAMPLES = OUTPUT_RATE; // ~1s per chunk

const getAudioContextCtor = (): typeof AudioContext | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    const win = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    return win.AudioContext || win.webkitAudioContext || null;
};

const floatToInt16 = (sample: number): number => {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
};

const resampleToPcm16 = (input: Float32Array, inputRate: number, outputRate: number): Int16Array => {
    if (input.length === 0) {
        return new Int16Array(0);
    }
    if (inputRate === outputRate) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            out[i] = floatToInt16(input[i]);
        }
        return out;
    }

    const ratio = inputRate / outputRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const out = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
        const sourceIndex = i * ratio;
        const i0 = Math.floor(sourceIndex);
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = sourceIndex - i0;
        out[i] = floatToInt16(input[i0] * (1 - frac) + input[i1] * frac);
    }
    return out;
};

const concatInt16 = (a: Int16Array, b: Int16Array): Int16Array => {
    if (a.length === 0) {
        return b;
    }
    if (b.length === 0) {
        return a;
    }
    const out = new Int16Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
};

const int16ToBase64 = (pcm: Int16Array): string => {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

interface CaptureGraph {
    stream: MediaStream | null;
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    processor: ScriptProcessorNode | null;
    gain: GainNode | null;
    pending: Int16Array;
    started: boolean;
}

const emptyGraph = (): CaptureGraph => ({
    stream: null,
    context: null,
    source: null,
    processor: null,
    gain: null,
    pending: new Int16Array(0),
    started: false,
});

const safeDisconnect = (node: AudioNode | null): void => {
    if (!node) {
        return;
    }
    try {
        node.disconnect();
    } catch {
        // no-op
    }
};

export const isDictationCaptureSupported = (): boolean => {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') {
        return false;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return false;
    }
    return getAudioContextCtor() !== null;
};

export function useDictationAudioSource(config: DictationAudioSourceConfig): DictationAudioSource {
    const [volume, setVolume] = useState(0);

    const onPcmSegmentRef = useRef(config.onPcmSegment);
    const onErrorRef = useRef(config.onError);
    useEffect(() => {
        onPcmSegmentRef.current = config.onPcmSegment;
        onErrorRef.current = config.onError;
    }, [config.onPcmSegment, config.onError]);

    const graphRef = useRef<CaptureGraph>(emptyGraph());

    const start = useCallback(async () => {
        if (graphRef.current.started) {
            return;
        }

        if (
            typeof navigator === 'undefined' ||
            !navigator.mediaDevices ||
            typeof navigator.mediaDevices.getUserMedia !== 'function'
        ) {
            throw new Error('Microphone capture is not supported in this environment');
        }

        const AudioContextCtor = getAudioContextCtor();
        if (!AudioContextCtor) {
            throw new Error('AudioContext unavailable');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true,
            },
        });

        const context = new AudioContextCtor();
        try {
            if (context.state === 'suspended') {
                await context.resume().catch(() => undefined);
            }

            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const gain = context.createGain();
            gain.gain.value = 0;

            graphRef.current = {
                stream,
                context,
                source,
                processor,
                gain,
                pending: new Int16Array(0),
                started: true,
            };

            processor.onaudioprocess = (event) => {
                const graph = graphRef.current;
                if (!graph.started) {
                    return;
                }
                const input = event.inputBuffer.getChannelData(0);

                let sumSquares = 0;
                for (let i = 0; i < input.length; i++) {
                    sumSquares += input[i] * input[i];
                }
                const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
                setVolume(Math.min(1, Math.max(0, rms * 2)));

                const next = resampleToPcm16(input, context.sampleRate, OUTPUT_RATE);
                graph.pending = concatInt16(graph.pending, next);

                while (graph.pending.length >= CHUNK_SAMPLES) {
                    const chunk = graph.pending.slice(0, CHUNK_SAMPLES);
                    graph.pending = graph.pending.slice(CHUNK_SAMPLES);
                    onPcmSegmentRef.current(int16ToBase64(chunk));
                }
            };

            source.connect(processor);
            processor.connect(gain);
            gain.connect(context.destination);
        } catch (error) {
            stream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    // no-op
                }
            });
            try {
                await context.close();
            } catch {
                // no-op
            }
            graphRef.current = emptyGraph();
            throw error instanceof Error ? error : new Error(String(error));
        }
    }, []);

    const stop = useCallback(async () => {
        const graph = graphRef.current;
        graph.started = false;
        setVolume(0);

        if (graph.processor) {
            try {
                graph.processor.onaudioprocess = null;
            } catch {
                // no-op
            }
        }
        safeDisconnect(graph.processor);
        safeDisconnect(graph.source);
        safeDisconnect(graph.gain);
        if (graph.stream) {
            graph.stream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    // no-op
                }
            });
        }
        if (graph.context) {
            try {
                await graph.context.close();
            } catch {
                // no-op
            }
        }

        const pending = graph.pending;
        graphRef.current = emptyGraph();

        if (pending.length > 0) {
            onPcmSegmentRef.current(int16ToBase64(pending));
        }
    }, []);

    useEffect(() => {
        return () => {
            void stop().catch((err) => {
                onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
            });
        };
    }, [stop]);

    return useMemo(
        () => ({
            start: async () => {
                try {
                    await start();
                } catch (err) {
                    const normalized = err instanceof Error ? err : new Error(String(err));
                    onErrorRef.current?.(normalized);
                    throw normalized;
                }
            },
            stop,
            volume,
        }),
        [start, stop, volume],
    );
}
