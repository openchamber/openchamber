import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useDictationAudioSource, type DictationAudioSource } from './use-dictation-audio-source';

class AudioNodeFake {
    connect() {}
    disconnect() {}
}
class ProcessorFake extends AudioNodeFake {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
}
const contexts: AudioContextFake[] = [];
class AudioContextFake {
    state = 'running';
    sampleRate = 16000;
    destination = new AudioNodeFake();
    processor = new ProcessorFake();
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return new AudioNodeFake(); }
    createScriptProcessor() { return this.processor; }
    createGain() { return Object.assign(new AudioNodeFake(), { gain: { value: 1 } }); }
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
}
const stream = () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    return { track, getTracks: () => [track] };
};

let browser: Window;
let root: Root;
let captured: DictationAudioSource | null = null;
let pcm: ((text: string) => void) | undefined;
const saved = new Map<string, PropertyDescriptor | undefined>();
function Harness() {
    captured = useDictationAudioSource({ onPcmSegment: pcm });
    return null;
}
function audio() {
    if (!captured) throw new Error('Audio hook not mounted');
    return captured;
}
beforeEach(async () => {
    browser = new Window({ url: 'http://localhost/' });
    pcm = undefined;
    contexts.length = 0;
    const globals = { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [key, value] of Object.entries(globals)) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: AudioContextFake });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
});
afterEach(async () => {
    await act(async () => root.unmount());
    captured = null;
    await browser.happyDOM.close();
    for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
});

test('level-only capture emits signal and silence, then releases the mic on stop', async () => {
    const input = stream();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => input } });
    const levels: number[] = [];
    audio().subscribeLevel((level) => levels.push(level));
    await audio().start();
    const context = contexts[0];
    context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) } });
    context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(levels).toEqual([0.5, 0]);
    await audio().stop();
    expect(input.track.stopped).toBe(true);
    expect(context.state).toBe('closed');
    expect(context.processor.onaudioprocess).toBeNull();
});

test('cancel before the permission promise resolves closes the late microphone stream', async () => {
    const input = stream();
    let allow: (value: ReturnType<typeof stream>) => void = () => { throw new Error('Permission request missing'); };
    const permission = new Promise<ReturnType<typeof stream>>((resolve) => { allow = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => permission } });
    const starting = audio().start();
    await audio().stop();
    allow(input);
    await starting;
    expect(input.track.stopped).toBe(true);
    expect(contexts.length).toBe(0);
});

test('the server capture path still emits PCM when a segment callback is supplied', async () => {
    const chunks: string[] = [];
    pcm = (text) => chunks.push(text);
    await act(async () => root.render(<Harness />));
    const input = stream();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => input } });
    await audio().start();
    contexts[0].processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(16000).fill(0.25) } });
    expect(chunks.length).toBe(1);
    expect(atob(chunks[0]).length).toBe(32000);
    await audio().stop();
    expect(input.track.stopped).toBe(true);
});
