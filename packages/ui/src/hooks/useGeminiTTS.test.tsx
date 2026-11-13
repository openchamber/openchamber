import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useGeminiTTS } from './useGeminiTTS';

let dom: Window;
let root: Root;
let tts: ReturnType<typeof useGeminiTTS>;
let starts: number;
let decodes: number;
let pauses: number;
let resumes: number;
const originals = new Map<string, PropertyDescriptor | undefined>();

const deferred = () => {
    let settle: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    return { promise, resolve: () => settle?.() };
};

mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: async () => new Response(new Uint8Array([1])),
}));

class FakeAudioContext {
    state = 'running';
    destination = {};
    async decodeAudioData() { decodes += 1; return {}; }
    async suspend() { pauses += 1; this.state = 'suspended'; }
    async resume() { resumes += 1; this.state = 'running'; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource(): {
        buffer: null;
        detune: { value: number };
        connect: () => void;
        start: () => void;
        stop: () => void;
        onended: (() => void) | null;
    } {
        return {
            buffer: null,
            detune: { value: 0 },
            connect() {},
            start() { starts += 1; queueMicrotask(() => this.onended?.()); },
            stop() {},
            onended: null,
        };
    }
}

const Probe = () => {
    tts = useGeminiTTS();
    return null;
};

beforeEach(async () => {
    starts = 0; decodes = 0; pauses = 0; resumes = 0;
    dom = new Window({ url: 'http://localhost' });
    for (const [name, value] of Object.entries({
        window: dom, document: dom.document, AudioContext: FakeAudioContext, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
});

afterEach(async () => {
    act(() => root.unmount());
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
});

test('waits for playback eligibility after synthesis and supplies audio-focus controls', async () => {
    const reached = deferred();
    const allowed = deferred();
    const speaking = tts.speak('Reading', {
        voice: 'Kore',
        beforePlayback: async (playback) => {
            expect(decodes).toBe(1);
            await playback.pause();
            await playback.resume();
            reached.resolve();
            await allowed.promise;
        },
    });
    await reached.promise;
    expect(starts).toBe(0);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    allowed.resolve();
    expect(await speaking).toEqual({ status: 'played' });
    expect(starts).toBe(1);
});

test('does not start a reading stopped while its playback guard is pending', async () => {
    const reached = deferred();
    const allowed = deferred();
    const speaking = tts.speak('Reading', {
        voice: 'Kore',
        beforePlayback: async () => { reached.resolve(); await allowed.promise; },
    });
    await reached.promise;
    tts.stop();
    allowed.resolve();
    expect(await speaking).toEqual({ status: 'stopped' });
    expect(starts).toBe(0);
});

test('propagates an ineligible playback guard without reporting a synthesis failure', async () => {
    const failure = new DOMException('Backgrounded', 'AbortError');
    const speaking = tts.speak('Reading', {
        voice: 'Kore',
        beforePlayback: async () => { throw failure; },
    });
    await expect(speaking).rejects.toThrow('Backgrounded');
    expect(starts).toBe(0);
});
