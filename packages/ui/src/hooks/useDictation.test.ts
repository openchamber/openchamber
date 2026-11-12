import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { dictationClient } from '@/lib/dictation/dictation-client';
import { useConfigStore } from '@/stores/useConfigStore';
import { getDictationStartOptions, useDictation, type UseDictationResult } from './useDictation';

// The microphone is not the subject here: the test feeds PCM itself.
let audioConfig: { onPcmSegment: (base64Pcm: string) => void } | null = null;
const audioSource = {
    start: async () => {},
    stop: async () => {},
    subscribeLevel: () => () => {},
};

mock.module('@/lib/dictation/use-dictation-audio-source', () => ({
    useDictationAudioSource: (config: { onPcmSegment: (base64Pcm: string) => void }) => {
        audioConfig = config;
        return audioSource;
    },
}));

describe('getDictationStartOptions', () => {
    const original = {
        sttProvider: useConfigStore.getState().sttProvider,
        sttServerUrl: useConfigStore.getState().sttServerUrl,
        sttModel: useConfigStore.getState().sttModel,
        sttLanguage: useConfigStore.getState().sttLanguage,
        sttEndpointPath: useConfigStore.getState().sttEndpointPath,
    };

    afterEach(() => {
        useConfigStore.setState(original);
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

    test('leaves the path out when the setting is empty', () => {
        useConfigStore.setState({
            sttProvider: 'openai-compatible',
            sttServerUrl: 'http://127.0.0.1:9/v1',
            sttModel: 'whisper-1',
            sttLanguage: '',
            sttEndpointPath: '',
        });

        expect(getDictationStartOptions()).toEqual({
            provider: 'openai-compatible',
            openaiCompatible: {
                baseUrl: 'http://127.0.0.1:9/v1',
                model: 'whisper-1',
                endpointPath: undefined,
            },
        });
    });
});

/** A connected socket that acks starts, so the sender opens a stream. */
class FakeSocket {
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    /** Off: a start stays pending until the test answers it. */
    ackStarts = true;

    send(data: string): void {
        const message = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(message);
        if (message.type === 'start' && this.ackStarts) {
            setTimeout(() => {
                this.emit({ type: 'ack', dictationId: message.dictationId, ackSeq: -1 });
            }, 0);
        }
    }

    close(): void {
        this.readyState = 3;
    }

    emit(message: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

describe('useDictation stream errors', () => {
    let root: Root | null = null;
    let host: HTMLElement;
    let latest: UseDictationResult | null = null;
    let socket: FakeSocket;
    let transcripts: string[];
    let errors: Error[];

    const Probe: React.FC = () => {
        latest = useDictation({
            onTranscript: (text) => transcripts.push(text),
            onError: (error) => errors.push(error),
        });
        return null;
    };

    beforeEach(() => {
        audioConfig = null;
        latest = null;
        transcripts = [];
        errors = [];
        const dom = new Window({ url: 'http://localhost' });
        Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
        Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
        Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: dom.navigator });
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

        // The real client, wired to a socket that is already open: no network,
        // no reconnect loop, but the real message handling and bookkeeping.
        socket = new FakeSocket();
        const client = dictationClient as unknown as {
            socket: FakeSocket | null;
            handleMessage: (message: Record<string, unknown>) => void;
        };
        client.socket = socket;
        socket.onmessage = (event) => client.handleMessage(JSON.parse(event.data));

        host = document.createElement('div');
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root?.unmount());
        root = null;
        (dictationClient as unknown as { socket: FakeSocket | null }).socket = null;
        Reflect.deleteProperty(globalThis, 'window');
        Reflect.deleteProperty(globalThis, 'document');
        Reflect.deleteProperty(globalThis, 'navigator');
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
            audioConfig?.onPcmSegment('AAAA');
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

        // The salvaged text can be taken instead of losing the dictation.
        let accepted: string | null = null;
        await act(async () => {
            accepted = latest?.acceptPartialTranscript() ?? null;
        });
        expect(accepted).toBe('salvage text');
        expect(transcripts).toEqual(['salvage text']);
        expect(latest?.status).toBe('idle');
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
