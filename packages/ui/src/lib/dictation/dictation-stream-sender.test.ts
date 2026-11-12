import { describe, expect, test } from 'bun:test';

import type { DictationClient } from './dictation-client';
import { DictationStreamSender } from './dictation-stream-sender';

/**
 * Stands in for the socket client. A real start opens the connection, so a
 * resume attempt flips the fake to connected, exactly like ensureConnected().
 */
class FakeClient {
    isConnected = true;
    ackSeq = -1;
    starts: Array<{ dictationId: string; format: string; options: unknown }> = [];
    chunks: Array<{ dictationId: string; seq: number; audio: string }> = [];
    finishes: Array<{ dictationId: string; finalSeq: number }> = [];
    /** A finish the server never answered, as after a dropped socket. */
    pendingFinish: { dictationId: string; finalSeq: number } | null = null;
    resends = 0;
    /** A `final` the server sent with a resumed start. */
    completedFinal: string | null = null;
    events: string[] = [];
    /** Holds a start before it counts as connected, as a slow reconnect does. */
    beforeStart: (() => Promise<void>) | null = null;

    async startDictationStream(
        dictationId: string,
        format: string,
        options: unknown,
    ): Promise<{ ackSeq: number }> {
        this.starts.push({ dictationId, format, options });
        this.events.push('start');
        if (this.beforeStart) {
            await this.beforeStart();
        }
        this.isConnected = true;
        return { ackSeq: this.ackSeq };
    }

    sendDictationStreamChunk(dictationId: string, seq: number, audio: string): boolean {
        if (!this.isConnected) {
            return false;
        }
        this.chunks.push({ dictationId, seq, audio });
        this.events.push(`chunk:${seq}`);
        return true;
    }

    async finishDictationStream(dictationId: string, finalSeq: number): Promise<{ text: string }> {
        this.finishes.push({ dictationId, finalSeq });
        this.events.push('finish');
        return { text: '' };
    }

    hasPendingFinish(dictationId: string): boolean {
        return this.pendingFinish?.dictationId === dictationId;
    }

    resendPendingFinish(dictationId: string): boolean {
        if (this.pendingFinish?.dictationId !== dictationId) {
            return false;
        }
        this.pendingFinish = null;
        this.resends += 1;
        this.events.push('resend-finish');
        return true;
    }

    takeCompletedFinal(): string | null {
        const text = this.completedFinal;
        this.completedFinal = null;
        return text;
    }

    cancelDictationStream(): void {}
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
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

describe('DictationStreamSender resume', () => {
    test('resumes at the server ack and replays only the missing segments', async () => {
        const client = new FakeClient();
        const sender = new DictationStreamSender({
            client: client as unknown as DictationClient,
            getStartOptions: () => ({ provider: 'local', localModel: 'parakeet' }),
            createDictationId: () => 'dic_fixed',
        });

        sender.enqueueSegment('a');
        sender.enqueueSegment('b');
        sender.enqueueSegment('c');
        await waitFor(() => client.chunks.length === 3);
        expect(client.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
        // The socket drops while the server already holds seq 0 to 2.
        client.isConnected = false;
        client.ackSeq = 2;
        sender.enqueueSegment('d');
        sender.enqueueSegment('e');

        await waitFor(() => client.chunks.length === 5);

        expect(client.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3, 4]);
        expect(client.chunks.map((chunk) => chunk.audio)).toEqual(['a', 'b', 'c', 'd', 'e']);
        // Segments 1 and 2 are not sent a second time.
        expect(client.chunks.filter((chunk) => chunk.seq <= 2).length).toBe(3);
        // The resume reuses the dictation id instead of starting over.
        expect(client.starts.length).toBe(2);
        expect(client.starts[1].dictationId).toBe('dic_fixed');
        expect(client.starts[0].dictationId).toBe('dic_fixed');
    });

    test('starts one resume per outage, not one per segment', async () => {
        const client = new FakeClient();
        const sender = new DictationStreamSender({
            client: client as unknown as DictationClient,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'dic_fixed',
        });

        sender.enqueueSegment('a');
        await waitFor(() => client.chunks.length === 1);

        // The socket drops and the resume is still waiting for the reconnect
        // while the next two segments arrive.
        client.isConnected = false;
        client.ackSeq = 0;
        let releaseStart: () => void = () => {};
        client.beforeStart = () =>
            new Promise<void>((resolve) => {
                releaseStart = resolve;
            });

        sender.enqueueSegment('b');
        sender.enqueueSegment('c');
        // The initial start and exactly one resume, although two segments came
        // in during the outage.
        expect(client.starts.length).toBe(2);

        releaseStart();
        await waitFor(() => client.chunks.length === 3);
        expect(client.starts.length).toBe(2);
        expect(client.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    });

    test('replays from zero when the server no longer knows the stream', async () => {
        const client = new FakeClient();
        const sender = new DictationStreamSender({
            client: client as unknown as DictationClient,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'dic_fixed',
        });

        sender.enqueueSegment('a');
        await waitFor(() => client.chunks.length === 1);

        client.isConnected = false;
        client.ackSeq = -1;
        sender.enqueueSegment('b');

        await waitFor(() => client.chunks.length === 3);
        // A fresh stream on the server: everything is replayed from seq 0.
        expect(client.chunks.map((chunk) => chunk.seq)).toEqual([0, 0, 1]);
        expect(client.chunks.map((chunk) => chunk.audio)).toEqual(['a', 'a', 'b']);
        expect(client.starts[1].dictationId).toBe('dic_fixed');
    });
});

describe('DictationStreamSender finish across a reconnect', () => {
    test('sends an open finish again after the socket is back and the audio is replayed', async () => {
        const client = new FakeClient();
        const sender = new DictationStreamSender({
            client: client as unknown as DictationClient,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'dic_fixed',
        });

        sender.enqueueSegment('a');
        sender.enqueueSegment('b');
        await waitFor(() => client.chunks.length === 2);

        // The socket drops after the finish frame went out and the server
        // never answered it; one segment was never acked.
        client.isConnected = false;
        client.ackSeq = 0;
        client.pendingFinish = { dictationId: 'dic_fixed', finalSeq: 1 };

        await sender.resumeStream();

        expect(client.resends).toBe(1);
        // The missing segment is replayed first, the finish goes last: the
        // server must not wait for audio it has not received yet.
        expect(client.events.slice(-2)).toEqual(['chunk:1', 'resend-finish']);
        expect(client.pendingFinish).toBeNull();
    });

    test('takes the finished text when the server was done before the reconnect', async () => {
        const client = new FakeClient();
        const sender = new DictationStreamSender({
            client: client as unknown as DictationClient,
            getStartOptions: () => ({ provider: 'local' }),
            createDictationId: () => 'dic_fixed',
        });

        sender.enqueueSegment('a');
        await waitFor(() => client.chunks.length === 1);

        client.isConnected = false;
        client.ackSeq = -1;
        client.completedFinal = 'already transcribed';
        const chunksBefore = client.chunks.length;

        const result = await sender.finish(0);

        expect(result).toEqual({ dictationId: 'dic_fixed', text: 'already transcribed' });
        // Nothing is replayed into a stream that is gone, and no second finish
        // is sent for a dictation the server already answered.
        expect(client.chunks.length).toBe(chunksBefore);
        expect(client.finishes.length).toBe(0);
    });
});
