import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DictationClient, type DictationClientMessage, type DictationServerMessage } from '@/lib/dictation/dictation-client';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { useConfigStore } from '@/stores/useConfigStore';
import { applySettingsToStores } from '@/lib/settings/registry';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { setTranscriptionPrompt } from '@/stores/useTranscriptionPromptStore';
import { getDictationStartOptions, useDictation, type UseDictationResult } from './useDictation';

const node = () => ({ connect: () => {}, disconnect: () => {} });

// The microphone is not the subject here: the test pushes PCM through the
// ScriptProcessorNode the real capture source installs. Stubbing the capture
// module instead would replace it for every later test file in the same bun
// process, and use-dictation-audio-source.test.tsx then tests the stub.
const PROCESSOR_SAMPLES = 4096;
const SAMPLES_PER_CHUNK = 16_000; // the capture source's 16 kHz output rate
/** Microphone tracks stopped so far: a stopped capture stops its tracks. */
let stoppedTracks = 0;
let processor: {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
} | null = null;

class FakeAudioContext {
    state = 'running';
    sampleRate = SAMPLES_PER_CHUNK;
    destination = node();
    resume() {
        return Promise.resolve();
    }
    close() {
        return Promise.resolve();
    }
    createMediaStreamSource() {
        return node();
    }
    createScriptProcessor() {
        processor = { ...node(), onaudioprocess: null };
        return processor;
    }
    createGain() {
        return { ...node(), gain: { value: 1 } };
    }
}

/** One second of audio, delivered the way the microphone delivers it. */
const speakOneSecond = () => {
    const callbacks = Math.ceil(SAMPLES_PER_CHUNK / PROCESSOR_SAMPLES);
    for (let i = 0; i < callbacks; i++) {
        processor?.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array(PROCESSOR_SAMPLES) },
        });
    }
};

const restoreGlobal = (key: 'window' | 'document', descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
    } else {
        Reflect.deleteProperty(globalThis, key);
    }
};

describe('getDictationStartOptions', () => {
    const original = {
        sttProvider: useConfigStore.getState().sttProvider,
        sttServerUrl: useConfigStore.getState().sttServerUrl,
        sttModel: useConfigStore.getState().sttModel,
        sttLanguage: useConfigStore.getState().sttLanguage,
        sttEndpointPath: useConfigStore.getState().sttEndpointPath,
        sttKeyProvider: useConfigStore.getState().sttKeyProvider,
    };

    afterEach(() => {
        useConfigStore.setState(original);
        setTranscriptionPrompt('');
    });

    test('passes the custom stt endpoint path to the server', () => {
        useConfigStore.setState({
            sttProvider: 'openai-compatible',
            sttServerUrl: 'http://127.0.0.1:9/v1',
            sttModel: 'whisper-1',
            sttLanguage: 'en',
            sttEndpointPath: '/speech_to_text',
        });

        expect(getDictationStartOptions()).toEqual({
            provider: 'openai-compatible',
            language: 'en',
            openaiCompatible: {
                baseUrl: 'http://127.0.0.1:9/v1',
                model: 'whisper-1',
                endpointPath: '/speech_to_text',
            },
        });
    });

    test('passes the key provider the user chose, even none, and nothing before they chose', () => {
        const options = () => getDictationStartOptions().openaiCompatible;
        useConfigStore.setState({
            sttProvider: 'openai-compatible',
            sttServerUrl: 'http://127.0.0.1:9/v1',
            sttModel: 'whisper-1',
            sttEndpointPath: '',
            sttKeyProvider: undefined,
        });
        expect(JSON.stringify(options())).not.toContain('keyProvider');

        useConfigStore.setState({ sttKeyProvider: 'gateway' });
        expect(options()?.keyProvider).toBe('gateway');

        useConfigStore.setState({ sttKeyProvider: '' });
        expect(JSON.stringify(options())).toContain('"keyProvider":""');

        useConfigStore.setState({ sttProvider: 'local' });
        expect(JSON.stringify(getDictationStartOptions())).not.toContain('keyProvider');
    });

    test('leaves the path out when the setting is empty', () => {
        useConfigStore.setState({
            sttProvider: 'openai-compatible',
            sttServerUrl: 'http://127.0.0.1:9/v1',
            sttModel: 'whisper-1',
            sttLanguage: '',
            sttEndpointPath: '',
        });
        setTranscriptionPrompt('  \n ');

        expect(getDictationStartOptions()).toEqual({
            provider: 'openai-compatible',
            openaiCompatible: {
                baseUrl: 'http://127.0.0.1:9/v1',
                model: 'whisper-1',
                endpointPath: undefined,
            },
        });
    });

    test('sends the trimmed transcription prompt to a server provider only', () => {
        useConfigStore.setState({
            sttProvider: 'openai-compatible',
            sttServerUrl: 'http://127.0.0.1:9/v1',
            sttModel: 'whisper-1',
            sttLanguage: '',
            sttEndpointPath: '',
        });
        setTranscriptionPrompt('  Español e inglés.\nTérminos: OpenChamber  ');

        expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Español e inglés.\nTérminos: OpenChamber');

        useConfigStore.setState({ sttProvider: 'local' });
        expect(JSON.stringify(getDictationStartOptions())).not.toContain('prompt');
    });

    test('does not send the previous host\'s prompt after switching to a host that never saved one', () => {
        const previousApiBaseUrl = getRuntimeApiBaseUrl();
        const previousRuntimeKey = getRuntimeKey();
        useConfigStore.setState({ sttProvider: 'openai-compatible', sttServerUrl: 'https://stt.example/v1', sttModel: 'whisper-1' });
        try {
            switchRuntimeEndpoint({ apiBaseUrl: 'https://host-a.example', runtimeKey: 'host-a' });
            applySettingsToStores({ sttPrompt: 'Host A vocabulary' });
            expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Host A vocabulary');

            switchRuntimeEndpoint({ apiBaseUrl: 'https://host-b.example', runtimeKey: 'host-b' });
            applySettingsToStores({ sttLanguage: 'es' });
            expect(getDictationStartOptions().openaiCompatible).not.toHaveProperty('prompt');

            applySettingsToStores({ sttPrompt: 'Host B vocabulary' });
            applySettingsToStores({ sttLanguage: 'en' });
            expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Host B vocabulary');
        } finally {
            switchRuntimeEndpoint({ apiBaseUrl: previousApiBaseUrl, runtimeKey: previousRuntimeKey });
        }
    });
});

/** A connected socket that acks starts, so the sender opens a stream. */
class FakeSocket implements RelayTunnelWebSocket {
    readyState = 1;
    sent: DictationClientMessage[] = [];
    onopen: RelayTunnelWebSocket['onopen'] = null;
    onmessage: RelayTunnelWebSocket['onmessage'] = null;
    onclose: RelayTunnelWebSocket['onclose'] = null;
    onerror: RelayTunnelWebSocket['onerror'] = null;
    /** Off: a start stays pending until the test answers it. */
    ackStarts = true;
    private sentWaiters: Array<{ type: DictationClientMessage['type']; resolve: () => void }> = [];

    /** Resolves once a frame of `type` is sent. */
    nextSent(type: DictationClientMessage['type']): Promise<void> {
        return new Promise((resolve) => this.sentWaiters.push({ type, resolve }));
    }

    send(data: string): void {
        const message: DictationClientMessage = JSON.parse(data);
        this.sent.push(message);
        this.sentWaiters = this.sentWaiters.filter((waiter) => {
            if (waiter.type !== message.type) return true;
            waiter.resolve();
            return false;
        });
        if (message.type === 'start' && this.ackStarts) {
            queueMicrotask(() => {
                this.emit({ type: 'ack', dictationId: message.dictationId, ackSeq: -1 });
            });
        }
    }

    close(): void {
        this.readyState = 3;
    }

    emit(message: DictationServerMessage): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

interface ReplacedGlobals {
    window: PropertyDescriptor | undefined;
    document: PropertyDescriptor | undefined;
    mediaDevices: PropertyDescriptor | undefined;
}

describe('useDictation stream errors', () => {
    let root: Root | null = null;
    let host: HTMLElement;
    let latest: UseDictationResult | null = null;
    let socket: FakeSocket;
    let client: DictationClient;
    let transcripts: string[];
    let errors: Error[];
    let replaced: ReplacedGlobals;

    const Probe: React.FC = () => {
        latest = useDictation({
            onTranscript: (text) => transcripts.push(text),
            onError: (error) => errors.push(error),
        }, client);
        return null;
    };

    beforeEach(async () => {
        processor = null;
        stoppedTracks = 0;
        latest = null;
        transcripts = [];
        errors = [];
        const dom = new Window({ url: 'http://localhost' });
        Object.assign(dom, { AudioContext: FakeAudioContext });
        replaced = {
            window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
            document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
            mediaDevices: Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices'),
        };
        Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
        Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
        // Granted at once: no test here waits on the microphone prompt.
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] }),
            },
        });

        socket = new FakeSocket();
        client = new DictationClient(async () => {
            queueMicrotask(() => queueMicrotask(() => socket.emit({ type: 'ready' })));
            return socket;
        });
        await client.ensureConnected();

        host = document.createElement('div');
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root?.unmount());
        root = null;
        client.cancelAllForRuntimeSwitch();
        // Give back what this file replaced: the next test file in the same
        // process reads the global window, document and navigator.
        restoreGlobal('window', replaced.window);
        restoreGlobal('document', replaced.document);
        if (replaced.mediaDevices) {
            Object.defineProperty(globalThis.navigator, 'mediaDevices', replaced.mediaDevices);
        } else {
            Reflect.deleteProperty(globalThis.navigator, 'mediaDevices');
        }
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    const mount = () => act(async () => root?.render(React.createElement(Probe)));

    test('an error frame while recording fails the dictation and keeps the salvaged text', async () => {
        await mount();
        expect(latest?.status).toBe('idle');

        await act(async () => {
            await latest?.startDictation();
        });
        expect(latest?.status).toBe('recording');

        const start = socket.sent.find((message) => message.type === 'start');
        const dictationId = String(start?.dictationId);
        expect(dictationId.startsWith('dic_')).toBe(true);

        // One second of audio is buffered, so the dictation is salvageable.
        await act(async () => {
            speakOneSecond();
        });
        // The server has already transcribed a segment.
        await act(async () => {
            socket.emit({ type: 'partial', dictationId, text: 'salvage text' });
        });
        expect(latest?.partialTranscript).toBe('salvage text');

        // The stream died: the server reports an error while nothing is
        // waiting for an ack or a final.
        await act(async () => {
            socket.emit({
                type: 'error',
                dictationId,
                error: 'Dictation stream not started',
                retryable: true,
            });
        });

        expect(latest?.status).toBe('failed');
        expect(latest?.error).toBe('Dictation stream not started');
        expect(latest?.partialTranscript).toBe('salvage text');
        // The microphone is off once the dictation failed.
        expect(stoppedTracks).toBe(1);

        // The salvaged text can be taken instead of losing the dictation.
        let accepted: string | null = null;
        await act(async () => {
            accepted = latest?.acceptPartialTranscript() ?? null;
        });
        expect(accepted).toBe('salvage text');
        expect(transcripts).toEqual(['salvage text']);
        expect(latest?.status).toBe('idle');

        // The next dictation gets the microphone again.
        await act(async () => {
            await latest?.startDictation();
        });
        expect(latest?.status).toBe('recording');
        expect(socket.sent.filter((message) => message.type === 'start').length).toBe(2);
    });

    test('an error frame during the upload is reported once', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        const dictationId = String(socket.sent.find((message) => message.type === 'start')?.dictationId);
        await act(async () => {
            speakOneSecond();
        });

        let confirmed: Promise<string | null> | undefined;
        await act(async () => {
            const finishSent = socket.nextSent('finish');
            confirmed = latest?.confirmDictation();
            await finishSent;
        });
        await act(async () => {
            socket.emit({ type: 'error', dictationId, error: 'Transcription failed', retryable: true });
            await confirmed;
        });

        expect(errors.map((error) => error.message)).toEqual(['Transcription failed']);
        expect(latest?.status).toBe('failed');
    });

    test('a connection that does not come back ends the recording with the audio kept', async () => {
        let dials = 0;
        // Connects once, then the server is gone.
        client = new DictationClient(async () => {
            dials += 1;
            if (dials > 1) {
                throw new Error('offline');
            }
            queueMicrotask(() => queueMicrotask(() => socket.emit({ type: 'ready' })));
            return socket;
        }, { delaysMs: [0], budgetMs: 1000 });
        const gaveUp = new Promise<void>((resolve) => {
            client.subscribeStreamError(() => resolve());
        });
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        await act(async () => {
            speakOneSecond();
        });
        expect(latest?.status).toBe('recording');

        await act(async () => {
            socket.readyState = 3;
            socket.onclose?.({ code: 1006, reason: '' });
            await gaveUp;
        });

        expect(latest?.status).toBe('failed');
        expect(latest?.error).toBe('Dictation connection lost');
        expect(stoppedTracks).toBe(1);
    });

    const started = () => socket.sent.filter((message) => message.type === 'start').map((message) => message.dictationId);
    const cancelled = () => socket.sent.filter((message) => message.type === 'cancel').map((message) => message.dictationId);

    test('every way out of a recording leaves no stream open on the server', async () => {
        await mount();
        const record = async (audio: boolean) => {
            await act(async () => {
                await latest?.startDictation();
            });
            if (audio) {
                await act(async () => speakOneSecond());
            }
        };

        await record(true);
        await act(async () => {
            await latest?.cancelDictation();
        });
        expect(started()).toHaveLength(1);
        expect(cancelled()).toEqual(started());

        await record(false);
        await act(async () => {
            await latest?.confirmDictation();
        });
        expect(cancelled()).toEqual(started());

        await record(true);
        const dictationId = started()[2];
        await act(async () => {
            const finishSent = socket.nextSent('finish');
            const confirmed = latest?.confirmDictation();
            await finishSent;
            socket.emit({ type: 'error', dictationId, error: 'Transcription failed', retryable: true });
            await confirmed;
        });
        expect(latest?.status).toBe('failed');
        expect(cancelled()).toEqual(started());
        await act(async () => latest?.discardFailedDictation());

        await record(true);
        await act(async () => root?.unmount());
        root = null;
        expect(started()).toHaveLength(4);
        expect(cancelled()).toEqual(started());
    });

    test('a recording whose stream the server released replays on the next audio', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        await act(async () => speakOneSecond());
        const before = socket.sent.filter((message) => message.type === 'chunk');
        expect(before.length).toBeGreaterThan(0);

        await act(async () => {
            socket.emit({
                type: 'error', dictationId: started()[0], error: 'released', retryable: true, reasonCode: 'stream_released',
            });
        });
        expect(latest?.status).toBe('recording');
        expect(stoppedTracks).toBe(0);
        expect(started()).toHaveLength(1);

        await act(async () => speakOneSecond());
        expect(started()).toHaveLength(2);
        const sentSinceRelease = socket.sent.filter((message) => message.type === 'chunk').slice(before.length);
        expect(sentSinceRelease.slice(0, before.length)).toEqual(before.map((chunk) => ({ ...chunk, dictationId: started()[1] })));
        expect(sentSinceRelease.length).toBeGreaterThan(before.length);
        expect(errors).toEqual([]);

        await act(async () => {
            socket.emit({
                type: 'error', dictationId: started()[1], error: 'released', retryable: true, reasonCode: 'stream_released',
            });
            client.cancelAllForRuntimeSwitch();
        });
        expect(latest?.status).toBe('failed');
        expect(stoppedTracks).toBe(1);
        expect(started()).toHaveLength(2);
    });

    test('confirming a recording the server released transcribes the kept audio', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        await act(async () => speakOneSecond());
        let confirmed: Promise<string | null> | undefined;
        await act(async () => {
            const firstFinish = socket.nextSent('finish');
            confirmed = latest?.confirmDictation();
            await firstFinish;
            const secondFinish = socket.nextSent('finish');
            for (let i = 0; i < 2; i++) {
                socket.emit({
                    type: 'error', dictationId: started()[0], error: 'released', retryable: true, reasonCode: 'stream_released',
                });
                await Promise.resolve();
            }
            await secondFinish;
            socket.emit({ type: 'final', dictationId: started()[1], text: 'kept' });
            await confirmed;
        });
        expect(transcripts).toEqual(['kept']);
        expect(errors).toEqual([]);
        expect(latest?.status).toBe('idle');
    });

    test('a runtime switch after a failed reopen stops the microphone', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        await act(async () => speakOneSecond());
        await act(async () => {
            socket.emit({
                type: 'error', dictationId: started()[0], error: 'released', retryable: true, reasonCode: 'stream_released',
            });
            socket.ackStarts = false;
            speakOneSecond();
            await Promise.resolve();
            socket.emit({
                type: 'error', dictationId: started()[1], error: 'released', retryable: true, reasonCode: 'stream_released',
            });
        });
        expect(latest?.status).toBe('recording');
        await act(async () => client.cancelAllForRuntimeSwitch());
        await act(async () => speakOneSecond());
        expect(latest?.status).toBe('failed');
        expect(stoppedTracks).toBe(1);
        expect(started()).toHaveLength(2);
    });

    test('a runtime switch while a confirm reopens a released stream sends no audio to the new host', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        await act(async () => speakOneSecond());
        await act(async () => {
            socket.emit({
                type: 'error', dictationId: started()[0], error: 'released', retryable: true, reasonCode: 'stream_released',
            });
            socket.ackStarts = false;
            const reopened = socket.nextSent('start');
            const confirmed = latest?.confirmDictation();
            await reopened;
            const sent = socket.sent.length;
            client.cancelAllForRuntimeSwitch();
            await confirmed;
            expect(socket.sent).toHaveLength(sent);
        });
        expect(latest?.status).toBe('failed');
    });

    test('an error that rejects the start is not reported twice', async () => {
        socket.ackStarts = false;
        await mount();

        let started: Promise<void> | undefined;
        await act(async () => {
            started = latest?.startDictation();
        });
        const dictationId = String(
            socket.sent.find((message) => message.type === 'start')?.dictationId,
        );

        // The stream cannot open; the error rejects the start promise.
        await act(async () => {
            socket.emit({
                type: 'error',
                dictationId,
                error: 'Dictation STT not configured',
                retryable: false,
            });
            await started?.catch(() => undefined);
        });

        // The start path reported it once; the stream-error listener must not
        // fail the same dictation a second time.
        expect(errors.map((error) => error.message)).toEqual(['Dictation STT not configured']);
        expect(latest?.error).toBe('Dictation STT not configured');
    });

    test('a missing model is reported but does not end the recording', async () => {
        await mount();
        await act(async () => {
            await latest?.startDictation();
        });
        const dictationId = String(
            socket.sent.find((message) => message.type === 'start')?.dictationId,
        );

        await act(async () => {
            socket.emit({
                type: 'error',
                dictationId,
                error: 'Dictation model is downloading',
                retryable: true,
                reasonCode: 'model_download_in_progress',
            });
        });

        expect(latest?.status).toBe('recording');
        expect(latest?.errorReason).toBe('model_download_in_progress');
    });
});
