import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useLocalTTS, type UseLocalTTSReturn } from './useLocalTTS';

let root: Root;
let tts: UseLocalTTSReturn;
let fetchChunk: (init?: RequestInit) => Promise<Response>;
let requests: number;
let starts: number;
let signal: AbortSignal | null | undefined;

mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: (_url: string, init?: RequestInit) => fetchChunk(init),
}));

class FakeAudioContext {
    state = 'running';
    destination = {};
    async decodeAudioData() { return {}; }
    createBufferSource() {
        return {
            buffer: null,
            connect() {},
            start() {
                starts += 1;
                queueMicrotask(() => this.onended?.());
            },
            stop() {},
            onended: null as (() => void) | null,
        };
    }
}

const Probe = () => {
    tts = useLocalTTS();
    return null;
};

const text = [
    'The first sentence is long enough to become a separate synthesis chunk.',
    'The second sentence is also long enough to become a separate synthesis chunk.',
].join(' ');

beforeEach(async () => {
    requests = 0;
    starts = 0;
    signal = undefined;
    const dom = new Window({ url: 'http://localhost' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    fetchChunk = async (init) => {
        requests += 1;
        if (requests === 1) return new Response(new Uint8Array([1]));
        signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        });
    };
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
});

afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

describe('useLocalTTS cancellation', () => {
    test('still reports a prefetched synthesis failure when playback continues', async () => {
        fetchChunk = async () => {
            requests += 1;
            if (requests === 1) return new Response(new Uint8Array([1]));
            throw new Error('Synthesis failed');
        };
        const errors: string[] = [];
        await act(async () => {
            await tts.speak(text, { onError: (error) => { errors.push(error); } });
        });
        expect(requests).toBe(2);
        expect(starts).toBe(1);
        expect(tts.error).toBe('Synthesis failed');
        expect(tts.isPlaying).toBe(false);
        expect(errors).toEqual(['Synthesis failed']);
    });

    for (const throws of [true, false]) {
        test(`handles the prefetched rejection when beforePlayback stops${throws ? ' and throws' : ''}`, async () => {
            const errors: string[] = [];
            let ends = 0;
            await act(async () => {
                await tts.speak(text, {
                    beforePlayback: async () => {
                        expect(requests).toBe(2);
                        tts.stop();
                        if (throws) throw new DOMException('Backgrounded', 'AbortError');
                    },
                    onError: (error) => { errors.push(error); },
                    onEnd: () => { ends += 1; },
                });
                // Let the runtime report any unhandled rejection from the abandoned fetch.
                await new Promise<void>((resolve) => setImmediate(resolve));
            });
            expect(signal?.aborted).toBe(true);
            expect(starts).toBe(0);
            expect(tts.isPlaying).toBe(false);
            expect(tts.error).toBeNull();
            expect(errors).toEqual([]);
            expect(ends).toBe(0);
        });
    }
});
