import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationDictation } from '@/components/browser/AnnotationDictation';
import type { AnnotationVoiceChannel } from '@/components/browser/useAnnotationVoiceRun';
import { I18nProvider } from '@/lib/i18n';
import { DictationClient, type DictationClientMessage } from '@/lib/dictation/dictation-client';
import { setWindowClosePending, startFieldDictation, useFieldDictationStore, useFieldPanelOpen } from '@/lib/dictation/fieldDictation';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { FieldDictationHost } from './FieldDictationHost';

const node = () => ({ connect: () => {}, disconnect: () => {} });
interface FakeProcessor {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
}

let processor: FakeProcessor = { onaudioprocess: null };
const speak = () => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(16_000) } });

class FakeAudioContext {
    state = 'running';
    sampleRate = 16_000;
    destination = node();
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    createScriptProcessor() {
        processor = { onaudioprocess: null };
        return Object.assign(processor, node());
    }
}

/** Acks every start and answers a finish at once, with the text or an error. */
class FakeSocket implements RelayTunnelWebSocket {
    readyState = 1;
    failFinish = false;
    sent: DictationClientMessage[] = [];
    onopen: RelayTunnelWebSocket['onopen'] = null;
    onmessage: RelayTunnelWebSocket['onmessage'] = null;
    onclose: RelayTunnelWebSocket['onclose'] = null;
    onerror: RelayTunnelWebSocket['onerror'] = null;

    send(data: string): void {
        const message: DictationClientMessage = JSON.parse(data);
        this.sent.push(message);
        const { dictationId } = message;
        if (message.type === 'start') this.answer({ type: 'ack', dictationId, ackSeq: -1 });
        if (message.type === 'finish') {
            this.answer(this.failFinish
                ? { type: 'error', dictationId, error: 'server gone', retryable: true }
                : { type: 'final', dictationId, text: 'spoken' });
        }
    }

    answer(message: { type: string; dictationId?: string; ackSeq?: number; text?: string; error?: string; retryable?: boolean }): void {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(message) }));
    }

    close(): void { this.readyState = 3; }
}

let dom: Window;
let root: Root;
let socket: FakeSocket;
let client: DictationClient;
let written: string[];
let stoppedTracks: number;
let descriptors: Record<string, PropertyDescriptor | undefined>;

const Panel = ({ open }: { open: boolean }) => {
    useFieldPanelOpen('panel', open);
    return null;
};
const show = (open: boolean, key = 'same') => act(async () => root.render(
    <I18nProvider><FieldDictationHost client={client} /><Panel key={key} open={open} /></I18nProvider>,
));
const record = (fieldKey: string) => act(async () => {
    startFieldDictation({ fieldKey, panelKey: 'panel', insert: (text) => { written.push(`${fieldKey}: ${text}`); } });
});
const settle = () => act(async () => { await new Promise((resolve) => { queueMicrotask(() => setImmediate(resolve)); }); });
const recordings = () => useFieldDictationStore.getState().recordings.map(({ fieldKey, view }) => `${fieldKey} ${view.status}`);

beforeEach(async () => {
    dom = new Window({ url: 'http://localhost' });
    Object.assign(dom, { AudioContext: FakeAudioContext });
    descriptors = {};
    const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
    for (const [key, value] of Object.entries(globals)) {
        descriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    descriptors.mediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] }) },
    });
    written = [];
    stoppedTracks = 0;
    socket = new FakeSocket();
    client = new DictationClient(async () => {
        queueMicrotask(() => socket.answer({ type: 'ready' }));
        return socket;
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await show(true);
    await record('note');
    await settle();
    await act(async () => speak());
    expect(recordings()).toEqual(['note recording']);
});

afterEach(async () => {
    await act(async () => root.unmount());
    useFieldDictationStore.setState({ recordings: [] });
    client.cancelAllForRuntimeSwitch();
    const { mediaDevices, ...globals } = descriptors;
    if (mediaDevices) Object.defineProperty(globalThis.navigator, 'mediaDevices', mediaDevices);
    else Reflect.deleteProperty(globalThis.navigator, 'mediaDevices');
    for (const [key, descriptor] of Object.entries(globals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
});

test('closing the panel finishes the recording into its own field', async () => {
    await show(true, 'the same panel, remounted');
    await settle();
    expect(recordings()).toEqual(['note recording']);

    await show(false, 'the same panel, remounted');
    await settle();
    expect(written).toEqual(['note: spoken']);
    expect(recordings()).toEqual([]);
    expect(stoppedTracks).toBe(1);
});

test('audio whose finish fails after the close is kept and Retry stays in reach', async () => {
    socket.failFinish = true;
    await show(false);
    await settle();
    expect(recordings()).toEqual(['note failed']);
    expect(written).toEqual([]);

    socket.failFinish = false;
    await act(async () => { await useFieldDictationStore.getState().recordings[0].actions?.retryFailedDictation(); });
    await settle();
    expect(written).toEqual(['note: spoken']);
    expect(recordings()).toEqual([]);
});

test('starting in another field finishes the first one into its own field', async () => {
    await record('todo');
    await settle();
    expect(written).toEqual(['note: spoken']);
    expect(recordings()).toEqual(['todo recording']);
});

for (const { name, closing, submitting, attached, kept } of [
    { name: 'stays in the comment box', closing: false, submitting: false, attached: false, kept: [] },
    { name: 'goes to the chat when its window closes', closing: true, submitting: false, attached: false, kept: ['spoken'] },
    { name: 'is left to a queued Attach when its window closes', closing: true, submitting: true, attached: true, kept: [] },
    { name: 'goes to the chat when the queued Attach did not happen', closing: true, submitting: true, attached: false, kept: ['spoken'] },
]) {
    test(`annotation text ${name}`, async () => {
        const saved: string[] = [];
        let listen: Parameters<AnnotationVoiceChannel['subscribe']>[0] = () => {};
        const channel: AnnotationVoiceChannel = {
            fieldKey: 'annotation', panelKey: 'panel',
            send: async (message) => ({ delivered: true, submitting: submitting && message.type === 'insert' }),
            attached: Promise.resolve(attached),
            subscribe: (listener) => { listen = listener; return () => {}; },
            keep: (text) => { saved.push(text); return true; },
            dropAttach: () => {},
        };
        await act(async () => root.render(
            <I18nProvider><FieldDictationHost client={client} /><Panel open /><AnnotationDictation channel={channel} /></I18nProvider>,
        ));
        await act(async () => listen({ type: 'voice', action: 'start' }));
        await settle();
        await act(async () => speak());
        setWindowClosePending(closing);
        await act(async () => listen({ type: 'voice', action: 'finish' }));
        await settle();
        setWindowClosePending(false);
        expect(recordings()).toEqual([]);
        expect(useFieldDictationStore.getState().deliveries).toBe(0);
        expect(saved).toEqual(kept);
    });
}

test('a recovered transcript and the one that follows reach the chat once when the window closes', async () => {
    const saved: string[] = [];
    let listen: Parameters<AnnotationVoiceChannel['subscribe']>[0] = () => {};
    const channel: AnnotationVoiceChannel = {
        fieldKey: 'annotation', panelKey: 'panel',
        send: async () => ({ delivered: true, submitting: false }),
        attached: Promise.resolve(false),
        subscribe: (listener) => { listen = listener; return () => {}; },
        keep: (text) => { saved.push(text); return true; },
        dropAttach: () => {},
    };
    await act(async () => root.render(
        <I18nProvider><FieldDictationHost client={client} /><Panel open /><AnnotationDictation channel={channel} /></I18nProvider>,
    ));
    const say = async (action: 'start' | 'finish') => {
        await act(async () => listen({ type: 'voice', action }));
        await settle();
        if (action === 'start') await act(async () => speak());
    };
    await say('start');
    socket.failFinish = true;
    await say('finish');
    await say('start');
    socket.failFinish = false;
    const failed = useFieldDictationStore.getState().recordings.find((recording) => recording.view.status === 'failed');
    await act(async () => { await failed?.actions?.retryFailedDictation(); });
    await settle();
    expect(saved).toEqual([]);

    setWindowClosePending(true);
    await say('finish');
    setWindowClosePending(false);
    expect(saved).toEqual(['spoken spoken']);
    expect(useFieldDictationStore.getState().deliveries).toBe(0);
});
