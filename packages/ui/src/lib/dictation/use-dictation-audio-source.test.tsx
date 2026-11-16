import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDictationAudioSource, type DictationAudioSource } from './use-dictation-audio-source';

const node = () => ({ connect: () => {}, disconnect: () => {} });

// Records what start() does synchronously, inside the click that called it.
const events: string[] = [];
let closeResult: Promise<void> = Promise.resolve();

class FakeAudioContext {
    state = 'suspended';
    sampleRate = 48_000;
    destination = node();
    constructor() {
        events.push('context');
    }
    resume() {
        events.push('resume');
        this.state = 'running';
        return Promise.resolve();
    }
    close() {
        events.push('close');
        return closeResult;
    }
    createMediaStreamSource() {
        return node();
    }
    createScriptProcessor() {
        events.push('processor');
        return { ...node(), onaudioprocess: null };
    }
    createGain() {
        return { ...node(), gain: { value: 1 } };
    }
}

let grantMicrophone: (() => void) | null = null;
const stoppedTracks: string[] = [];

const stream = () => ({ getTracks: () => [{ stop: () => stoppedTracks.push('track') }] });

let dom: Window;
let root: Root;
let audio: DictationAudioSource;

const Probe = () => {
    audio = useDictationAudioSource({ onPcmSegment: () => {} });
    return null;
};

beforeEach(async () => {
    events.length = 0;
    stoppedTracks.length = 0;
    closeResult = Promise.resolve();
    grantMicrophone = null;
    dom = new Window();
    Object.assign(dom, { AudioContext: FakeAudioContext });
    Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: () => {
                events.push('getUserMedia');
                return new Promise((resolve) => {
                    grantMicrophone = () => resolve(stream());
                });
            },
        },
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Probe />));
});

afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
});

test('creates and resumes the audio context in the click, before the microphone answers', async () => {
    const started = audio.start();

    expect(events).toEqual(['context', 'resume', 'getUserMedia']);

    grantMicrophone?.();
    expect(await started).toBe(true);
    expect(events).toContain('processor');
    await audio.stop();
});

test('releases a microphone that is granted after the capture was stopped', async () => {
    const started = audio.start();
    await audio.stop();

    grantMicrophone?.();
    expect(await started).toBe(false);

    expect(stoppedTracks).toEqual(['track']);
    expect(events).not.toContain('processor');
});

test('stopping does not wait for the audio context to close', async () => {
    const started = audio.start();
    grantMicrophone?.();
    expect(await started).toBe(true);
    let finishClose!: () => void;
    closeResult = new Promise((resolve) => {
        finishClose = resolve;
    });

    // stop() runs while close() is still pending. A stop() that waits for
    // close can only settle after close does, so the order shows it.
    const order: string[] = [];
    const stopped = audio.stop().then(() => order.push('stopped'));
    const closed = closeResult.then(() => order.push('closed'));
    expect(events).toContain('close');
    finishClose();
    await Promise.all([stopped, closed]);

    expect(order).toEqual(['stopped', 'closed']);
    expect(stoppedTracks).toEqual(['track']);
});
