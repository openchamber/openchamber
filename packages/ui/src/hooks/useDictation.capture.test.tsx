import { afterEach, beforeEach, expect, spyOn, test, type Spy } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DictationStreamSender } from '@/lib/dictation/dictation-stream-sender';
import { useDictation, type UseDictationResult } from './useDictation';

const node = () => ({ connect: () => {}, disconnect: () => {} });

class FakeAudioContext {
    state = 'running';
    sampleRate = 48_000;
    destination = node();
    resume() {
        return Promise.resolve();
    }
    close() {
        return closeResult;
    }
    createMediaStreamSource() {
        return node();
    }
    createScriptProcessor() {
        return { ...node(), onaudioprocess: null };
    }
    createGain() {
        return { ...node(), gain: { value: 1 } };
    }
}

// Each getUserMedia call waits for the test to answer the permission prompt.
const prompts: Array<{ grant: () => void; deny: () => void }> = [];
const stoppedTracks: string[] = [];
const errors: Error[] = [];
let closeResult: Promise<void> = Promise.resolve();

let dom: Window;
let root: Root;
let mounted: boolean;
let dictation: UseDictationResult;
let restartStream: Spy<DictationStreamSender['restartStream']>;
let setIntervalSpy: ReturnType<typeof spyOn<typeof globalThis, 'setInterval'>>;

const Probe = () => {
    dictation = useDictation({ onError: (error) => errors.push(error) });
    return null;
};

const durationTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000).length;

beforeEach(async () => {
    prompts.length = 0;
    stoppedTracks.length = 0;
    errors.length = 0;
    closeResult = Promise.resolve();
    dom = new Window();
    Object.assign(dom, { AudioContext: FakeAudioContext });
    Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: () => new Promise((resolve, reject) => {
                prompts.push({
                    grant: () => resolve({ getTracks: () => [{ stop: () => stoppedTracks.push('track') }] }),
                    deny: () => reject(new Error('Permission denied')),
                });
            }),
        },
    });
    restartStream = spyOn(DictationStreamSender.prototype, 'restartStream').mockResolvedValue(undefined);
    setIntervalSpy = spyOn(globalThis, 'setInterval');
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Probe />));
    mounted = true;
});

afterEach(async () => {
    if (mounted) {
        await act(async () => dictation.cancelDictation());
        await act(async () => root.unmount());
    }
    restartStream.mockRestore();
    setIntervalSpy.mockRestore();
    await dom.happyDOM.close();
});

const startWhilePromptOpen = () => {
    let started!: Promise<void>;
    act(() => {
        started = dictation.startDictation();
    });
    expect(prompts).toHaveLength(1);
    expect(dictation.status).toBe('recording');
    return started;
};

for (const [ending, end] of [
    ['Cancel', () => dictation.cancelDictation()],
    ['Finish', () => dictation.confirmDictation()],
] as const) {
    test(`a microphone granted after ${ending} starts no timer or stream and leaves the next recording intact`, async () => {
        const started = startWhilePromptOpen();
        await act(async () => {
            await end();
        });
        expect(dictation.status).toBe('idle');

        await act(async () => {
            prompts[0].grant();
            await started;
        });

        expect(stoppedTracks).toEqual(['track']);
        expect(durationTimers()).toBe(0);
        expect(restartStream).not.toHaveBeenCalled();
        expect(dictation.status).toBe('idle');
        expect(errors).toEqual([]);

        await act(async () => {
            const next = dictation.startDictation();
            prompts[1].grant();
            await next;
        });

        expect(dictation.status).toBe('recording');
        expect(durationTimers()).toBe(1);
        expect(restartStream).toHaveBeenCalledTimes(1);
    });
}

test('a microphone denied after Cancel reports no error', async () => {
    const started = startWhilePromptOpen();
    await act(async () => {
        await dictation.cancelDictation();
    });

    await act(async () => {
        prompts[0].deny();
        await started;
    });

    expect(errors).toEqual([]);
    expect(dictation.error).toBeNull();
    expect(dictation.status).toBe('idle');
});

test('a denied microphone reports nothing new after Cancel while the audio context closes slowly', async () => {
    let releaseClose!: () => void;
    closeResult = new Promise((resolve) => {
        releaseClose = resolve;
    });
    const started = startWhilePromptOpen();

    await act(async () => {
        prompts[0].deny();
        await Promise.resolve();
    });
    await act(async () => {
        await dictation.cancelDictation();
    });
    const reported = errors.length;
    const shown = dictation.error;
    await act(async () => {
        releaseClose();
        await started;
    });

    expect(errors).toHaveLength(reported);
    expect(dictation.error).toBe(shown);
    expect(dictation.status).toBe('idle');
});

test('a microphone granted after unmount is released and starts no timer or stream', async () => {
    const started = startWhilePromptOpen();
    await act(async () => root.unmount());
    mounted = false;

    prompts[0].grant();
    await started;

    expect(stoppedTracks).toEqual(['track']);
    expect(durationTimers()).toBe(0);
    expect(restartStream).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
});
