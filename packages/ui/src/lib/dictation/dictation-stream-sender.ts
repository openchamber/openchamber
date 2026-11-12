/**
 * Small, non-React state machine for dictation streaming.
 *
 * Responsibilities:
 * - Maintain an ordered buffer of base64 PCM segments
 * - Start/restart a dictation stream (dictationId)
 * - Send missing segments (seq) when connected
 * - Finish/cancel the stream
 *
 * Segments are retained until the dictation completes, which enables replay
 * after a connection drop (`resetStreamForReplay()` + `finish()`).
 */

import type { DictationClient, DictationStartOptions } from './dictation-client';

const MAX_CHUNKS_PER_FLUSH_TURN = 128;

const PCM_DICTATION_FORMAT = 'audio/pcm;rate=16000;bits=16';

const waitForNextFlushTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const createDictationIdDefault = (): string => {
    const rand = Math.random().toString(36).slice(2, 10);
    return `dic_${Date.now().toString(16)}${rand}`;
};

export interface DictationFinishResult {
    dictationId: string;
    text: string;
}

export class DictationStreamSender {
    private readonly client: DictationClient;
    private readonly format: string;
    private readonly createDictationId: () => string;
    private getStartOptions: () => DictationStartOptions;

    private dictationId: string | null = null;
    private sendSeq = 0;
    private segments: string[] = [];
    private streamReady = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private drainWaiters: Array<() => void> = [];
    /** Text the server already finished while this sender was cut off. */
    private completedText: string | null = null;

    private startGeneration = 0;
    private startPromise: Promise<void> | null = null;
    private resumePromise: Promise<void> | null = null;

    constructor(params: {
        client: DictationClient;
        getStartOptions: () => DictationStartOptions;
        format?: string;
        createDictationId?: () => string;
    }) {
        this.client = params.client;
        this.format = params.format ?? PCM_DICTATION_FORMAT;
        this.getStartOptions = params.getStartOptions;
        this.createDictationId = params.createDictationId ?? createDictationIdDefault;
    }

    getDictationId(): string | null {
        return this.dictationId;
    }

    getFinalSeq(): number {
        return this.segments.length - 1;
    }

    hasSegments(): boolean {
        return this.segments.length > 0;
    }

    clearAll(): void {
        this.clearScheduledFlush();
        this.dictationId = null;
        this.sendSeq = 0;
        this.segments = [];
        this.streamReady = false;
        this.completedText = null;
        this.startPromise = null;
        this.resumePromise = null;
        this.startGeneration += 1;
    }

    resetStreamForReplay(): void {
        this.clearScheduledFlush();
        this.dictationId = null;
        this.sendSeq = 0;
        this.streamReady = false;
        this.completedText = null;
        this.startPromise = null;
        this.resumePromise = null;
        this.startGeneration += 1;
    }

    enqueueSegment(base64Pcm: string): void {
        this.segments.push(base64Pcm);

        if (!this.client.isConnected) {
            // The socket is gone but the server still holds this dictation.
            // One resume per outage, shared by every segment that arrives
            // meanwhile: the first call sets resumePromise and the next
            // segments join it instead of starting their own. Not a retry
            // loop: the client itself retries the connection and reports when
            // it gives up.
            if (this.dictationId && this.segments.length > 0 && !this.startPromise && !this.resumePromise) {
                void this.resumeStream().catch(() => {
                    // Segments stay buffered; finish() retries the stream.
                });
            }
            return;
        }

        if (!this.dictationId) {
            if (!this.startPromise) {
                void this.restartStream().catch(() => {
                    // Start failures surface through finish(); segments are retained.
                });
            }
            return;
        }

        this.flush();
    }

    flush(): number {
        const dictationId = this.dictationId;
        if (!this.client.isConnected || !dictationId || !this.streamReady) {
            return 0;
        }

        let sent = 0;
        while (this.sendSeq < this.segments.length && sent < MAX_CHUNKS_PER_FLUSH_TURN) {
            const seq = this.sendSeq;
            const audio = this.segments[seq];
            if (!this.client.sendDictationStreamChunk(dictationId, seq, audio)) {
                break;
            }
            this.sendSeq = seq + 1;
            sent += 1;
        }
        if (this.hasPendingSegments()) {
            this.scheduleFlush();
        } else {
            this.resolveDrainWaiters();
        }
        return sent;
    }

    /**
     * Continue the stream that is already open on the server under the same
     * dictation id. The server answers with the last seq it acknowledged, so
     * only the audio after it is sent again; nothing already decoded is
     * decoded a second time.
     */
    async resumeStream(): Promise<void> {
        const dictationId = this.dictationId;
        if (!dictationId) {
            // Nothing to resume: the first start belongs to restartStream().
            if (this.segments.length > 0) {
                await this.restartStream();
            }
            return;
        }
        if (this.resumePromise) {
            await this.resumePromise;
            return;
        }

        const generation = this.startGeneration;
        const resume = (async () => {
            this.streamReady = false;
            const { ackSeq } = await this.client.startDictationStream(
                dictationId,
                this.format,
                this.getStartOptions(),
            );
            if (this.startGeneration !== generation || this.dictationId !== dictationId) {
                return;
            }
            // The server was already done before this reconnect: it answered
            // the start with `final`. There is nothing left to send, and
            // replaying the audio would only reach a stream that is gone.
            const completed = this.client.takeCompletedFinal(dictationId);
            if (completed !== null) {
                this.completedText = completed;
                this.streamReady = false;
                return;
            }
            this.sendSeq = ackSeq + 1;
            this.streamReady = true;
            this.flush();
            // An open finish whose frame died with the socket is sent again,
            // after the missing audio and after the socket is attached again.
            if (this.client.hasPendingFinish(dictationId)) {
                await this.waitForFlushDrain().catch(() => undefined);
                this.client.resendPendingFinish(dictationId);
            }
        })().catch((error) => {
            // Keep the id and the segments: the next attempt may find the
            // server stream again, and finish() replays from zero if it does not.
            if (this.startGeneration === generation && this.dictationId === dictationId) {
                this.streamReady = false;
            }
            throw error;
        });

        this.resumePromise = resume;
        try {
            await resume;
        } finally {
            if (this.resumePromise === resume) {
                this.resumePromise = null;
            }
        }
    }

    async restartStream(): Promise<void> {
        this.startGeneration += 1;
        const generation = this.startGeneration;

        const dictationId = this.createDictationId();
        this.dictationId = dictationId;
        this.sendSeq = 0;
        this.streamReady = false;

        const start = (async () => {
            await this.client.startDictationStream(dictationId, this.format, this.getStartOptions());
            if (this.startGeneration !== generation) {
                return;
            }
            if (this.dictationId !== dictationId) {
                return;
            }
            this.streamReady = true;
            this.flush();
        })()
            .catch((error) => {
                // Keep segments for retry, but clear the stream so finish can error cleanly.
                if (this.startGeneration === generation && this.dictationId === dictationId) {
                    this.dictationId = null;
                    this.streamReady = false;
                }
                throw error;
            })
            .finally(() => {
                if (this.startPromise === start) {
                    this.startPromise = null;
                }
            });

        this.startPromise = start;
        await start;
    }

    async finish(finalSeq: number): Promise<DictationFinishResult> {
        if (!this.dictationId) {
            await this.restartStream();
        } else if (!this.client.isConnected || this.resumePromise) {
            // The user stopped while the socket was down: wait for the
            // reconnect and replay only what the server is missing. When that
            // fails, the drain check below reports it as it did before.
            await this.resumeStream().catch(() => undefined);
        }
        if (this.startPromise) {
            await this.startPromise;
        }

        const dictationId = this.dictationId;
        if (!dictationId) {
            throw new Error('Failed to start dictation stream');
        }
        if (this.completedText !== null) {
            // The dictation was finished on the server while the socket was
            // gone; the text is already there, nothing has to be uploaded.
            const text = this.completedText;
            this.completedText = null;
            return { dictationId, text };
        }
        if (!this.streamReady) {
            throw new Error('Failed to start dictation stream');
        }

        this.flush();
        await this.waitForFlushDrain();
        const result = await this.client.finishDictationStream(dictationId, finalSeq);
        return { dictationId, text: result.text };
    }

    cancel(): void {
        const dictationId = this.dictationId;
        if (this.client.isConnected && dictationId) {
            this.client.cancelDictationStream(dictationId);
        }
        this.resetStreamForReplay();
    }

    private hasPendingSegments(): boolean {
        return this.sendSeq < this.segments.length;
    }

    private scheduleFlush(): void {
        // Nothing to send into an unready stream: a timer here would spin
        // until the stream opens, one turn after another.
        if (this.flushTimer || !this.streamReady || !this.dictationId) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 0);
    }

    private clearScheduledFlush(): void {
        if (!this.flushTimer) {
            return;
        }
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }

    private async waitForFlushDrain(): Promise<void> {
        while (this.hasPendingSegments()) {
            if (!this.client.isConnected || !this.dictationId || !this.streamReady) {
                throw new Error('Failed to flush dictation stream');
            }
            await new Promise<void>((resolve) => {
                this.drainWaiters.push(resolve);
            });
            await waitForNextFlushTurn();
        }
    }

    private resolveDrainWaiters(): void {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }
}
