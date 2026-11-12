import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Socket-level tests for the reconnect bookkeeping: a start or a finish whose
 * frame died with the socket must be sent again once, and a `final` that
 * arrives before anyone waits for it must not be lost.
 */

class FakeSocket {
    static all: FakeSocket[] = [];

    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { reason?: string }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public url: string) {
        FakeSocket.all.push(this);
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.();
        this.emit({ type: 'ready' });
    }

    emit(message: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    /** The socket dies without the peer answering. */
    drop(): void {
        this.readyState = 3;
        this.onclose?.({});
    }
}

mock.module('@/lib/runtime-url', () => ({
    getRuntimeUrlResolver: () => ({ websocket: (path: string) => `ws://runtime.test${path}` }),
}));
mock.module('@/lib/runtime-auth', () => ({
    refreshRuntimeUrlAuthToken: async () => {},
}));
mock.module('@/lib/relay/runtime-socket', () => ({
    openRuntimeWebSocket: (url: string) => new FakeSocket(url),
}));

const { DictationClient } = await import('./dictation-client');

const FORMAT = 'audio/pcm;rate=16000;bits=16';

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error('waitFor timed out'));
                return;
            }
            setTimeout(tick, 5);
        };
        tick();
    });
}

/** Start a dictation and open the socket the client just created. */
async function startedClient(client: InstanceType<typeof DictationClient>, dictationId: string) {
    const started = client.startDictationStream(dictationId, FORMAT, { provider: 'local' });
    await waitFor(() => FakeSocket.all.length > 0);
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await waitFor(() => socket.sent.some((message) => message.type === 'start'));
    return { started, socket };
}

describe('DictationClient reconnect', () => {
    beforeEach(() => {
        FakeSocket.all = [];
    });

    test('sends a start whose frame died with the socket again after the reconnect', async () => {
        const client = new DictationClient();
        const { started, socket } = await startedClient(client, 'd1');

        // The start went into a socket that died before the ack came.
        socket.drop();
        await waitFor(() => FakeSocket.all.length === 2);
        const second = FakeSocket.all[1];
        second.open();

        await waitFor(() => second.sent.some((message) => message.type === 'start'));
        const resent = second.sent.find((message) => message.type === 'start');
        expect(resent?.dictationId).toBe('d1');
        expect(resent?.format).toBe(FORMAT);

        // One ack from the server resolves the original start promise.
        second.emit({ type: 'ack', dictationId: 'd1', ackSeq: 4 });
        await expect(started).resolves.toEqual({ ackSeq: 4 });

        client.cancelDictationStream('d1');
    });

    test('sends an open finish again after the reconnect, and takes the final', async () => {
        const client = new DictationClient();
        const { started, socket } = await startedClient(client, 'd1');
        socket.emit({ type: 'ack', dictationId: 'd1', ackSeq: 2 });
        await started;

        const finished = client.finishDictationStream('d1', 2);
        expect(socket.sent.filter((message) => message.type === 'finish').length).toBe(1);

        // The finish frame died with the socket: the server never answered.
        socket.drop();
        await waitFor(() => FakeSocket.all.length === 2);
        const second = FakeSocket.all[1];
        second.open();

        // The sender re-attaches the stream with a resumed start, replays what
        // is missing, and only then resends the finish.
        const resumed = client.startDictationStream('d1', FORMAT, { provider: 'local' });
        await waitFor(() => second.sent.some((message) => message.type === 'start'));
        second.emit({ type: 'ack', dictationId: 'd1', ackSeq: 2 });
        await resumed;

        expect(client.hasPendingFinish('d1')).toBe(true);
        expect(client.resendPendingFinish('d1')).toBe(true);
        expect(second.sent.filter((message) => message.type === 'finish').length).toBe(1);
        // Only once per reconnect.
        expect(client.resendPendingFinish('d1')).toBe(false);

        second.emit({ type: 'final', dictationId: 'd1', text: 'hello world' });
        await expect(finished).resolves.toEqual({ text: 'hello world' });
        expect(client.hasPendingFinish('d1')).toBe(false);
    });

    test('holds a final that arrives before the finish was asked for', async () => {
        const client = new DictationClient();
        const { started, socket } = await startedClient(client, 'd1');
        socket.emit({ type: 'ack', dictationId: 'd1', ackSeq: 1 });
        await started;

        // The server answered a resumed start of a dictation it had already
        // finished. The sender is still on its way to finish().
        socket.emit({ type: 'final', dictationId: 'd1', text: 'already done' });

        const finished = client.finishDictationStream('d1', 1);
        await expect(finished).resolves.toEqual({ text: 'already done' });
        // Nothing is sent into a stream that no longer exists.
        expect(socket.sent.filter((message) => message.type === 'finish').length).toBe(0);
    });

    test('reports an error frame that no open start or finish is waiting for', async () => {
        const client = new DictationClient();
        const seen: Array<{ dictationId: string; message: string; retryable: boolean }> = [];
        const unsubscribe = client.subscribeStreamError((dictationId, error) => {
            seen.push({ dictationId, message: error.message, retryable: error.retryable });
        });

        const { started, socket } = await startedClient(client, 'd1');
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
