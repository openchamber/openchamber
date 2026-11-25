
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

type StreamClient = Pick<DictationClient,
    'isConnected' | 'startDictationStream' | 'sendDictationStreamChunk' | 'finishDictationStream'
    | 'hasPendingFinish' | 'resendPendingFinish' | 'takeCompletedFinal' | 'cancelDictationStream'
    | 'isStreamActive' | 'runtimeGeneration'>;

export class DictationStreamSender {
    private readonly client: StreamClient;
    private readonly format: string;
    private readonly createDictationId: () => string;
    private getStartOptions: () => DictationStartOptions;

    private dictationId: string | null = null;
    private sendSeq = 0;
    private segments: string[] = [];
    private streamReady = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private drainWaiters: Array<() => void> = [];
    private completedText: string | null = null;
    private reopenOnNextSegment = false;
    private releases = 0;
    private releasedFrom = 0;

    private startGeneration = 0;
    private startPromise: Promise<void> | null = null;
    private resumePromise: Promise<void> | null = null;

    constructor(params: {
        client: StreamClient;
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
        this.cancel();
        this.segments = [];
    }

    cancel(): void {
        if (this.dictationId) {
            this.client.cancelDictationStream(this.dictationId);
        }
        this.clearScheduledFlush();
        this.dictationId = null;
        this.sendSeq = 0;
        this.streamReady = false;
        this.completedText = null;
        this.startPromise = null;
        this.resumePromise = null;
        this.reopenOnNextSegment = false;
        this.startGeneration += 1;
        this.resolveDrainWaiters();
    }

    markReleased(): void {
        this.streamReady = false;
        this.reopenOnNextSegment = true;
        this.releases += 1;
        this.releasedFrom = this.client.runtimeGeneration;
        this.resolveDrainWaiters();
    }

    stopWaitingForDrain(): void {
        this.resolveDrainWaiters();
    }

    enqueueSegment(base64Pcm: string): void {
        this.segments.push(base64Pcm);

        if (this.reopenOnNextSegment) {
            if (!this.startPromise) {
                void this.reopenStream().catch(() => {
                });
            }
            return;
        }
        if (!this.client.isConnected) {
            if (this.dictationId && this.client.isStreamActive(this.dictationId)
                && !this.startPromise && !this.resumePromise) {
                void this.resumeStream().catch(() => {
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

    get runtimeChanged(): boolean {
        return this.reopenOnNextSegment && this.client.runtimeGeneration !== this.releasedFrom;
    }

    private async reopenStream(): Promise<void> {
        if (this.runtimeChanged) {
            throw new Error('Runtime changed');
        }
        this.cancel();
        const restart = this.restartStream();
        const generation = this.startGeneration;
        try {
            await restart;
        } catch (error) {
            if (this.startGeneration === generation) {
                this.reopenOnNextSegment = true;
            }
            throw error;
        }
    }

    async resumeStream(): Promise<void> {
        if (this.reopenOnNextSegment) {
            return;
        }
        const dictationId = this.dictationId;
        if (!dictationId) {
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
            const completed = this.client.takeCompletedFinal(dictationId);
            if (completed !== null) {
                this.completedText = completed;
                this.streamReady = false;
                return;
            }
            this.sendSeq = ackSeq + 1;
            this.streamReady = true;
            this.flush();
        })().catch((error) => {
            if (this.startGeneration !== generation || this.dictationId !== dictationId) {
                return;
            }
            this.streamReady = false;
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

        if (this.startGeneration === generation && this.dictationId === dictationId
            && this.streamReady && this.client.hasPendingFinish(dictationId)) {
            try {
                await this.waitForFlushDrain();
            } catch {
                return;
            }
            this.client.resendPendingFinish(dictationId);
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
                if (this.startGeneration !== generation || this.dictationId !== dictationId) {
                    return;
                }
                this.dictationId = null;
                this.streamReady = false;
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
        if (this.reopenOnNextSegment) {
            await this.reopenStream();
        }
        const releases = this.releases;
        try {
            return await this.finishStream(finalSeq);
        } catch (error) {
            if (this.releases === releases || !this.reopenOnNextSegment) {
                throw error;
            }
            await this.reopenStream();
            return this.finishStream(finalSeq);
        }
    }

    private async finishStream(finalSeq: number): Promise<DictationFinishResult> {
        if (finalSeq >= this.segments.length) {
            throw new Error('Dictation cancelled');
        }
        if (!this.dictationId) {
            await this.restartStream();
        } else if (!this.client.isConnected || this.resumePromise) {
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
            const text = this.completedText;
            this.completedText = null;
            return { dictationId, text };
        }
        if (!this.streamReady) {
            throw new Error('Failed to start dictation stream');
        }

        this.flush();
        await this.waitForFlushDrain();
        if (this.dictationId !== dictationId || !this.streamReady) {
            throw new Error('Dictation stream is gone');
        }
        const result = await this.client.finishDictationStream(dictationId, finalSeq);
        if (this.dictationId === dictationId) {
            this.dictationId = null;
            this.streamReady = false;
        }
        return { dictationId, text: result.text };
    }

    private hasPendingSegments(): boolean {
        return this.sendSeq < this.segments.length;
    }

    private scheduleFlush(): void {
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
