/**
 * Microphone capture for dictation.
 *
 * Captures mono audio via getUserMedia, taps it with a ScriptProcessorNode
 * (universally supported, including iOS WKWebView), resamples Float32 to
 * 16 kHz PCM16LE, and emits ~1-second base64 chunks plus a normalized RMS
 * level for the waveform.
 *
 * The level is delivered by subscription rather than React state: it updates
 * on every audio callback (~12 Hz), and routing that through state re-rendered
 * the whole dictation overlay at the same rate.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface DictationAudioSourceConfig {
    onPcmSegment: (base64Pcm: string) => void;
    onError?: (error: Error) => void;
}

export type DictationLevelListener = (level: number) => void;

export interface DictationAudioSource {
    /**
     * Resolves true when this call started capture, false when it did not:
     * capture was already running, or stop() retired it while the microphone
     * prompt was open. A retired start never rejects.
     */
    start: () => Promise<boolean>;
    stop: () => Promise<void>;
    /** Subscribe to the normalized (0..1) mic level. Returns an unsubscribe. */
    subscribeLevel: (listener: DictationLevelListener) => () => void;
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

const stopTracks = (stream: MediaStream | null): void => {
    stream?.getTracks().forEach((track) => {
        try {
            track.stop();
        } catch {
            // no-op
        }
    });
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
    const levelListenersRef = useRef(new Set<DictationLevelListener>());
    const emitLevel = useCallback((level: number) => {
        for (const listener of levelListenersRef.current) {
            listener(level);
        }
    }, []);
    const subscribeLevel = useCallback((listener: DictationLevelListener) => {
        levelListenersRef.current.add(listener);
        return () => {
            levelListenersRef.current.delete(listener);
        };
    }, []);

    const onPcmSegmentRef = useRef(config.onPcmSegment);
    const onErrorRef = useRef(config.onError);
    useEffect(() => {
        onPcmSegmentRef.current = config.onPcmSegment;
        onErrorRef.current = config.onError;
    }, [config.onPcmSegment, config.onError]);

    const graphRef = useRef<CaptureGraph>(emptyGraph());

    const start = useCallback(async (): Promise<boolean> => {
        if (graphRef.current.started || graphRef.current.context) {
            return false;
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

        // Create and resume the context while still inside the user's click:
        // iOS Safari and WKWebView keep a context created after the
        // microphone prompt suspended, and capture then delivers no audio.
        const context = new AudioContextCtor();
        const graph = emptyGraph();
        graph.context = context;
        graphRef.current = graph;
        try {
            const resumed = context.state === 'suspended'
                ? context.resume().catch(() => undefined)
                : Promise.resolve();
            const acquired = navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    noiseSuppression: true,
                    echoCancellation: true,
                    autoGainControl: true,
                },
            }).then((stream) => {
                graph.stream = stream;
                return stream;
            });
            const [stream] = await Promise.all([acquired, resumed]);
            // Stopped while the microphone prompt was open: stop() has closed
            // the context, but the stream arrived after it and is released here.
            if (graphRef.current !== graph) {
                stopTracks(stream);
                return false;
            }

            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const gain = context.createGain();
            gain.gain.value = 0;

            graph.source = source;
            graph.processor = processor;
            graph.gain = gain;
            graph.started = true;

            processor.onaudioprocess = (event) => {
                if (!graph.started) {
                    return;
                }
                const input = event.inputBuffer.getChannelData(0);

                let sumSquares = 0;
                for (let i = 0; i < input.length; i++) {
                    sumSquares += input[i] * input[i];
                }
                const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
                emitLevel(Math.min(1, Math.max(0, rms * 2)));

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
            return true;
        } catch (error) {
            graph.started = false;
            stopTracks(graph.stream);
            // A capture stopped meanwhile has nobody left to report to.
            if (graphRef.current !== graph) {
                return false;
            }
            graphRef.current = emptyGraph();
            // Not awaited: a Cancel or unmount during a slow close must not
            // find this start still pending and get its error afterwards.
            void context.close().catch(() => undefined);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }, [emitLevel]);

    const stop = useCallback(async () => {
        const graph = graphRef.current;
        // Retire the graph at once, including a start still waiting for the
        // microphone, so its late stream is stopped and a new start is free.
        graphRef.current = emptyGraph();
        graph.started = false;
        emitLevel(0);

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
        stopTracks(graph.stream);
        const pending = graph.pending;
        graph.pending = new Int16Array(0);
        if (pending.length > 0) {
            onPcmSegmentRef.current(int16ToBase64(pending));
        }

        // The microphone is off and the tail is flushed. Closing the context
        // can take about a second on mobile, so it does not hold up the
        // transcription or the next start.
        if (graph.context) {
            void graph.context.close().catch(() => undefined);
        }
    }, [emitLevel]);

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
                    return await start();
                } catch (err) {
                    const normalized = err instanceof Error ? err : new Error(String(err));
                    onErrorRef.current?.(normalized);
                    throw normalized;
                }
            },
            stop,
            subscribeLevel,
        }),
        [start, stop, subscribeLevel],
    );
}
