import { describe, expect, test } from 'bun:test';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { DictationClient, type DictationClientMessage, type DictationServerMessage } from './dictation-client';
import { DictationStreamSender } from './dictation-stream-sender';

function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

/**
 * Socket-level tests for the reconnect bookkeeping: a start or a finish whose
 * frame died with the socket must be sent again once, and a `final` that
 * arrives before anyone waits for it must not be lost.
 */

class FakeSocket implements RelayTunnelWebSocket {
    readyState = 0;
    sent: DictationClientMessage[] = [];
    onopen: RelayTunnelWebSocket['onopen'] = null;
    onmessage: RelayTunnelWebSocket['onmessage'] = null;
    onclose: RelayTunnelWebSocket['onclose'] = null;
    onerror: RelayTunnelWebSocket['onerror'] = null;
    started = deferred();

    send(data: string): void {
        const message: DictationClientMessage = JSON.parse(data);
        this.sent.push(message);
        if (message.type === 'start') this.started.resolve();
    }

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.();
        this.emit({ type: 'ready' });
    }

    emit(message: DictationServerMessage): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    /** The socket dies without the peer answering. */
    drop(): void {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: '' });
    }
}

const FORMAT = 'audio/pcm;rate=16000;bits=16';

function setup() {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const reconnected = deferred();
    let connections = 0;
    const client = new DictationClient(async () => {
        const socket = connections++ === 0 ? first : second;
        queueMicrotask(() => queueMicrotask(() => {
            socket.open();
            if (socket === second) reconnected.resolve();
        }));
        return socket;
    });
    return { client, first, second, reconnected: reconnected.promise };
}

async function startedClient({ client, first }: ReturnType<typeof setup>, dictationId: string) {
    const started = client.startDictationStream(dictationId, FORMAT, { provider: 'local' });
    await first.started.promise;
    return { started, socket: first };
}

describe('DictationClient reconnect', () => {
    test('sends a start whose frame died with the socket again after the reconnect', async () => {
        const fixtures = setup();
        const { client, second } = fixtures;
        const { started, socket } = await startedClient(fixtures, 'd1');

        // The start went into a socket that died before the ack came.
        socket.drop();
        await second.started.promise;
        const resent = second.sent.find((message) => message.type === 'start');
        expect(resent?.dictationId).toBe('d1');
        expect(resent?.format).toBe(FORMAT);

        // One ack from the server resolves the original start promise.
        second.emit({ type: 'ack', dictationId: 'd1', ackSeq: 4 });
        expect(await started).toEqual({ ackSeq: 4 });

        client.cancelDictationStream('d1');
    });

    test('sends an open finish again after the reconnect, and takes the final', async () => {
        const fixtures = setup();
        const { client, second, reconnected } = fixtures;
        const { started, socket } = await startedClient(fixtures, 'd1');
        socket.emit({ type: 'ack', dictationId: 'd1', ackSeq: 2 });
        await started;

        const finished = client.finishDictationStream('d1', 2);
        expect(socket.sent.filter((message) => message.type === 'finish').length).toBe(1);

        // The finish frame died with the socket: the server never answered.
        socket.drop();
        await reconnected;

        // The sender re-attaches the stream with a resumed start, replays what
        // is missing, and only then resends the finish.
        const resumed = client.startDictationStream('d1', FORMAT, { provider: 'local' });
        await second.started.promise;
        second.emit({ type: 'ack', dictationId: 'd1', ackSeq: 2 });
        await resumed;

        expect(client.hasPendingFinish('d1')).toBe(true);
        expect(client.resendPendingFinish('d1')).toBe(true);
        expect(second.sent.filter((message) => message.type === 'finish').length).toBe(1);
        // Only once per reconnect.
        expect(client.resendPendingFinish('d1')).toBe(false);

        second.emit({ type: 'final', dictationId: 'd1', text: 'hello world' });
        expect(await finished).toEqual({ text: 'hello world' });
        expect(client.hasPendingFinish('d1')).toBe(false);
    });

    test('holds a final that arrives before the finish was asked for', async () => {
        const fixtures = setup();
        const { client } = fixtures;
        const { started, socket } = await startedClient(fixtures, 'd1');
        socket.emit({ type: 'ack', dictationId: 'd1', ackSeq: 1 });
        await started;

        // The server answered a resumed start of a dictation it had already
        // finished. The sender is still on its way to finish().
        socket.emit({ type: 'final', dictationId: 'd1', text: 'already done' });

        const finished = client.finishDictationStream('d1', 1);
        expect(await finished).toEqual({ text: 'already done' });
        // Nothing is sent into a stream that no longer exists.
        expect(socket.sent.filter((message) => message.type === 'finish').length).toBe(0);
    });

    test('reports an error frame that no open start or finish is waiting for', async () => {
        const fixtures = setup();
        const { client } = fixtures;
        const seen: Array<{ dictationId: string; message: string; retryable: boolean }> = [];
        const unsubscribe = client.subscribeStreamError((dictationId, error) => {
            seen.push({ dictationId, message: error.message, retryable: error.retryable });
        });

        const { started, socket } = await startedClient(fixtures, 'd1');
        socket.emit({ type: 'ack', dictationId: 'd1', ackSeq: 0 });
        await started;

        // Nothing is pending: the dictation is running, the stream is dead.
        socket.emit({ type: 'error', dictationId: 'd1', error: 'Dictation stream not started', retryable: true });

        expect(seen).toEqual([
            { dictationId: 'd1', message: 'Dictation stream not started', retryable: true },
        ]);

        unsubscribe();
        client.cancelDictationStream('d1');
    });
});

/**
 * The sender and the client together, through the client's own pending-start
 * map: the races between a start resent on reconnect and the sender's resume
 * live in the space between the two.
 */
describe('DictationClient with the stream sender', () => {
    const startFrames = (socket: FakeSocket, dictationId: string) =>
        socket.sent.filter((message) => message.type === 'start' && message.dictationId === dictationId);

    test('a resume after the reconnect joins the start that was resent, not a second one', async () => {
        const fixtures = setup();
        const { client, first, second, reconnected } = fixtures;
        const sender = new DictationStreamSender({
            client,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'd1',
        });

        const opened = sender.restartStream();
        await first.started.promise;
        // The start died with the socket before its ack.
        first.drop();
        await reconnected;

        // The connection listener resumes the stream, as useDictation does.
        const resumed = sender.resumeStream();
        expect(startFrames(second, 'd1').length).toBe(1);

        second.emit({ type: 'ack', dictationId: 'd1', ackSeq: -1 });
        await Promise.all([opened, resumed]);

        sender.enqueueSegment('AAAA');
        expect(sender.getDictationId()).toBe('d1');
        expect(second.sent.filter((message) => message.type === 'chunk').map((message) => message.dictationId)).toEqual(['d1']);
        client.cancelDictationStream('d1');
    });

    test('a cancel while the socket is down ends the dictation without a resend or an error', async () => {
        const fixtures = setup();
        const { client, first, second } = fixtures;
        const errors: string[] = [];
        client.subscribeStreamError((_, error) => errors.push(error.message));
        const sender = new DictationStreamSender({
            client,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'd1',
        });

        const opened = sender.restartStream();
        await first.started.promise;
        first.drop();

        sender.cancel();
        await opened;

        // A connection that comes back anyway carries nothing for it.
        await client.ensureConnected();
        expect(second.sent).toEqual([]);
        expect(errors).toEqual([]);
    });
});

describe('DictationClient runtime switch', () => {
    test('a dial still opening when the runtime switches never becomes the socket', async () => {
        const socket = new FakeSocket();
        const client = new DictationClient(async () => socket);

        const connecting = client.ensureConnected();
        await Promise.resolve();
        client.cancelAllForRuntimeSwitch();
        socket.open();

        await expect(connecting).rejects.toThrow('Runtime changed');
        expect(client.isConnected).toBe(false);
        expect(socket.readyState).toBe(3);
    });
});

describe('DictationClient reconnect budget', () => {
    test('a recording with nothing pending hears that the connection is gone for good', async () => {
        const first = new FakeSocket();
        let dials = 0;
        const client = new DictationClient(async () => {
            dials += 1;
            if (dials > 1) {
                throw new Error('offline');
            }
            queueMicrotask(() => queueMicrotask(() => first.open()));
            return first;
        }, { delaysMs: [0, 0], budgetMs: 1000 });
        const lost = new Promise<string>((resolve) => {
            client.subscribeStreamError((dictationId, error) => resolve(`${dictationId}: ${error.message}`));
        });

        const started = client.startDictationStream('d1', FORMAT, { provider: 'local' });
        await first.started.promise;
        first.emit({ type: 'ack', dictationId: 'd1', ackSeq: -1 });
        await started;

        first.drop();

        expect(await lost).toBe('d1: Dictation connection lost');
        expect(dials).toBe(3);
    });

    test('a token fetch that never answers still ends the recording within the budget', async () => {
        const first = new FakeSocket();
        let dials = 0;
        const client = new DictationClient(() => {
            dials += 1;
            if (dials > 1) {
                return new Promise<RelayTunnelWebSocket>(() => {});
            }
            queueMicrotask(() => queueMicrotask(() => first.open()));
            return Promise.resolve(first);
        }, { delaysMs: [0, 0], budgetMs: 300 });
        const lost = new Promise<string>((resolve) => {
            client.subscribeStreamError((dictationId, error) => resolve(`${dictationId}: ${error.message}`));
        });

        const started = client.startDictationStream('d1', FORMAT, { provider: 'local' });
        await first.started.promise;
        first.emit({ type: 'ack', dictationId: 'd1', ackSeq: -1 });
        await started;

        first.drop();

        expect(await lost).toBe('d1: Dictation connection lost');
    });
});

describe('DictationClient and sender after the stream is given up', () => {
    async function recording(openAfterFirst: () => Promise<RelayTunnelWebSocket>) {
        const first = new FakeSocket();
        let dials = 0;
        const client = new DictationClient(() => {
            dials += 1;
            if (dials > 1) {
                return openAfterFirst();
            }
            queueMicrotask(() => queueMicrotask(() => first.open()));
            return Promise.resolve(first);
        }, { delaysMs: [0], budgetMs: 1000 });
        const sender = new DictationStreamSender({
            client,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'd1',
        });
        const streamError = new Promise<string>((resolve) => {
            client.subscribeStreamError((_, error) => resolve(error.message));
        });
        const started = sender.restartStream();
        await first.started.promise;
        first.emit({ type: 'ack', dictationId: 'd1', ackSeq: -1 });
        await started;
        sender.enqueueSegment('a');
        return { client, sender, streamError, first, dials: () => dials };
    }

    // A resume dials synchronously inside enqueueSegment, so the dial count
    // right after it shows whether the segment reopened the connection.

    test('a mic tail after the reconnect gave up stays in the buffer, no new dial', async () => {
        let offline = true;
        const { client, sender, streamError, first, dials } = await recording(() => {
            if (offline) return Promise.reject(new Error('offline'));
            return Promise.resolve(new FakeSocket());
        });

        first.drop();
        expect(await streamError).toBe('Dictation connection lost');
        const dialsAfterLoss = dials();

        // The host is reachable again when the mic flushes its tail on stop.
        offline = false;
        sender.enqueueSegment('tail');

        expect(dials()).toBe(dialsAfterLoss);
        expect(client.isConnected).toBe(false);
        expect(sender.getFinalSeq()).toBe(1);
    });

    test('a runtime switch ends the recording and keeps its audio off the new host', async () => {
        const { client, sender, streamError, dials } = await recording(() => Promise.resolve(new FakeSocket()));

        client.cancelAllForRuntimeSwitch();
        expect(await streamError).toBe('Runtime changed');

        sender.enqueueSegment('b');

        expect(dials()).toBe(1);
    });
});
