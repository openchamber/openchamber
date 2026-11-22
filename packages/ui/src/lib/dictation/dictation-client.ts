
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { delay } from '@/lib/timing/delay';

export interface DictationStartOptions {
    provider?: 'local' | 'openai-compatible';
    language?: string;
    localModel?: string;
    correct?: boolean;
    openaiCompatible?: {
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        endpointPath?: string;
        prompt?: string;
    };
}

export interface DictationServerMessage {
    type: string;
    dictationId?: string;
    ackSeq?: number;
    text?: string;
    timeoutMs?: number;
    error?: string;
    retryable?: boolean;
    reasonCode?: string;
}

export type DictationClientMessage =
    | { type: 'start'; dictationId: string; format: string; options: DictationStartOptions }
    | { type: 'chunk'; dictationId: string; seq: number; audio: string }
    | { type: 'finish'; dictationId: string; finalSeq: number }
    | { type: 'cancel'; dictationId: string };

interface DictationStreamError extends Error {
    retryable: boolean;
    reasonCode?: string;
}

const createStreamError = (message: string, retryable: boolean, reasonCode?: string): DictationStreamError => {
    const error: DictationStreamError = Object.assign(new Error(message), { retryable });
    error.name = 'DictationStreamError';
    if (reasonCode) {
        error.reasonCode = reasonCode;
    }
    return error;
};

const CONNECT_TIMEOUT_MS = 10000;
const START_TIMEOUT_MS = 30000;
const IDLE_CLOSE_DELAY_MS = 30000;
const DEFAULT_FINISH_TIMEOUT_MS = 60000;
const RECONNECT_DELAYS_MS = [200, 500, 1000, 2000, 5000];
const RECONNECT_BUDGET_MS = 15000;
const CONNECTION_LOST = 'Dictation connection lost';
const COMPLETED_FINAL_TTL_MS = 60000;

type ConnectionStatusListener = (connected: boolean) => void;
type PartialListener = (dictationId: string, text: string) => void;
type StreamErrorListener = (dictationId: string, error: DictationStreamError) => void;

interface PendingStart {
    resolve: (ackSeq: number) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    format: string;
    options: DictationStartOptions;
    needsResend: boolean;
}

export interface DictationReconnectPolicy {
    delaysMs: readonly number[];
    budgetMs: number;
}

interface StartRequest {
    promise: Promise<{ ackSeq: number }>;
    cancel: () => void;
}

interface PendingFinish {
    resolve: (result: { text: string }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout> | null;
    finalSeq: number;
    needsResend: boolean;
}

export class DictationClient {
    private socket: RelayTunnelWebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectPromise: Promise<void> | null = null;
    private reconnectGeneration = 0;
    private readonly pendingStarts = new Map<string, PendingStart>();
    private readonly startRequests = new Map<string, StartRequest>();
    private readonly pendingFinishes = new Map<string, PendingFinish>();
    private readonly completedFinals = new Map<string, { text: string; at: number }>();
    private readonly connectionListeners = new Set<ConnectionStatusListener>();
    private readonly partialListeners = new Set<PartialListener>();
    private readonly streamErrorListeners = new Set<StreamErrorListener>();
    private readonly activeIds = new Set<string>();
    private activeDictations = 0;

    constructor(
        private readonly openSocket: () => Promise<RelayTunnelWebSocket> = openDictationSocket,
        private readonly reconnectPolicy: DictationReconnectPolicy = { delaysMs: RECONNECT_DELAYS_MS, budgetMs: RECONNECT_BUDGET_MS },
    ) {}

    get isConnected(): boolean {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    subscribeConnectionStatus(listener: ConnectionStatusListener): () => void {
        this.connectionListeners.add(listener);
        return () => {
            this.connectionListeners.delete(listener);
        };
    }

    onPartial(listener: PartialListener): () => void {
        this.partialListeners.add(listener);
        return () => {
            this.partialListeners.delete(listener);
        };
    }

    subscribeStreamError(listener: StreamErrorListener): () => void {
        this.streamErrorListeners.add(listener);
        return () => {
            this.streamErrorListeners.delete(listener);
        };
    }

    async ensureConnected(timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<void> {
        if (this.isConnected) {
            return;
        }
        if (this.connectPromise) {
            await this.connectPromise;
            return;
        }

        const generation = this.reconnectGeneration;
        const attempt = new Promise<void>((resolve, reject) => {
            let settled = false;
            let opened: RelayTunnelWebSocket | null = null;

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try {
                        opened?.close();
                    } catch {
                        void 0;
                    }
                    reject(new Error('Dictation connection timed out'));
                }
            }, Math.max(250, timeoutMs));

            this.openSocket().then((socket) => {
                if (settled) {
                    try {
                        socket.close();
                    } catch {
                        void 0;
                    }
                    return;
                }
                opened = socket;

                socket.onmessage = (event) => {
                    let message: DictationServerMessage;
                    try {
                        message = JSON.parse(String(event.data));
                    } catch {
                        return;
                    }
                    if (!settled && message.type === 'ready') {
                        settled = true;
                        clearTimeout(timeout);
                        if (this.reconnectGeneration !== generation) {
                            try {
                                socket.close(1000, 'runtime switch');
                            } catch {
                                void 0;
                            }
                            reject(new Error('Runtime changed'));
                            return;
                        }
                        this.socket = socket;
                        this.resendPendingStarts();
                        this.notifyConnection(true);
                        resolve();
                        return;
                    }
                    this.handleMessage(message);
                };

                socket.onerror = () => {
                    window.setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error('Dictation connection failed'));
                    }, 250);
                };

                socket.onclose = (event) => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        const detail = event?.reason ? `: ${event.reason}` : '';
                        reject(new Error(`Dictation connection failed${detail}`));
                        return;
                    }
                    if (this.socket !== socket) {
                        return;
                    }
                    this.socket = null;
                    if (this.activeDictations > 0) {
                        this.markPendingForResend();
                        this.startReconnect();
                        return;
                    }
                    this.rejectAllPending(new Error(CONNECTION_LOST));
                    this.notifyConnection(false);
                };
            }, (error: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });

        this.connectPromise = attempt;
        try {
            await attempt;
        } finally {
            if (this.connectPromise === attempt) {
                this.connectPromise = null;
            }
        }
    }

    private startReconnect(): void {
        if (this.reconnectPromise) {
            return;
        }
        const generation = this.reconnectGeneration;
        const startedAt = Date.now();
        const { delaysMs, budgetMs } = this.reconnectPolicy;
        const nothingToRecover = () => this.activeDictations === 0 && this.pendingFinishes.size === 0;

        const attempt = (async () => {
            for (const retryDelay of delaysMs) {
                if (this.isConnected || nothingToRecover()) {
                    return;
                }
                const remaining = budgetMs - (Date.now() - startedAt);
                if (remaining <= retryDelay) {
                    break;
                }
                await delay(retryDelay);
                if (this.reconnectGeneration !== generation) {
                    return;
                }
                if (this.isConnected || nothingToRecover()) {
                    return;
                }
                try {
                    await this.ensureConnected(budgetMs - (Date.now() - startedAt));
                } catch {
                    continue;
                }
            }
            if (this.isConnected || nothingToRecover()) {
                return;
            }
            throw new Error(CONNECTION_LOST);
        })();

        this.reconnectPromise = attempt;
        void attempt.then(
            () => {
                if (this.reconnectPromise === attempt) {
                    this.reconnectPromise = null;
                }
            },
            (error) => {
                if (this.reconnectPromise === attempt) {
                    this.reconnectPromise = null;
                }
                if (this.reconnectGeneration !== generation) {
                    return;
                }
                const lost = error instanceof Error ? error : new Error(String(error));
                const stranded = Array.from(this.activeIds);
                this.rejectAllPending(lost);
                this.notifyConnection(false);
                for (const dictationId of stranded) {
                    this.notifyStreamError(dictationId, createStreamError(lost.message, true));
                }
            },
        );
    }

    startDictationStream(
        dictationId: string,
        format: string,
        options: DictationStartOptions,
    ): Promise<{ ackSeq: number }> {
        const inFlight = this.startRequests.get(dictationId);
        if (inFlight) {
            return inFlight.promise;
        }
        let cancelled = false;
        const request: StartRequest = {
            promise: this.requestStart(dictationId, format, options, () => cancelled),
            cancel: () => {
                cancelled = true;
            },
        };
        this.startRequests.set(dictationId, request);
        const forget = () => {
            if (this.startRequests.get(dictationId) === request) {
                this.startRequests.delete(dictationId);
            }
        };
        request.promise.then(forget, forget);
        return request.promise;
    }

    private async requestStart(
        dictationId: string,
        format: string,
        options: DictationStartOptions,
        isCancelled: () => boolean,
    ): Promise<{ ackSeq: number }> {
        await this.ensureConnected();
        if (isCancelled()) {
            throw new Error('Dictation cancelled');
        }
        if (!this.activeIds.has(dictationId)) {
            this.activeIds.add(dictationId);
            this.activeDictations += 1;
        }
        this.clearIdleCloseTimer();

        return new Promise<{ ackSeq: number }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingStarts.delete(dictationId);
                this.releaseDictation(dictationId);
                reject(new Error('Dictation start timed out'));
            }, START_TIMEOUT_MS);

            this.pendingStarts.set(dictationId, {
                resolve: (ackSeq: number) => {
                    clearTimeout(timeout);
                    resolve({ ackSeq });
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    this.releaseDictation(dictationId);
                    reject(error);
                },
                timeout,
                format,
                options,
                needsResend: false,
            });

            if (!this.send({ type: 'start', dictationId, format, options })) {
                clearTimeout(timeout);
                this.pendingStarts.delete(dictationId);
                this.releaseDictation(dictationId);
                reject(new Error(CONNECTION_LOST));
            }
        });
    }

    sendDictationStreamChunk(dictationId: string, seq: number, audioBase64: string): boolean {
        return this.send({ type: 'chunk', dictationId, seq, audio: audioBase64 });
    }

    finishDictationStream(dictationId: string, finalSeq: number): Promise<{ text: string }> {
        return new Promise<{ text: string }>((resolve, reject) => {
            const pending: PendingFinish = {
                resolve: (result) => {
                    if (pending.timeout) {
                        clearTimeout(pending.timeout);
                    }
                    this.releaseDictation(dictationId);
                    resolve(result);
                },
                reject: (error) => {
                    if (pending.timeout) {
                        clearTimeout(pending.timeout);
                    }
                    this.releaseDictation(dictationId);
                    reject(error);
                },
                timeout: null,
                finalSeq,
                needsResend: false,
            };
            pending.timeout = setTimeout(() => {
                this.pendingFinishes.delete(dictationId);
                this.releaseDictation(dictationId);
                reject(new Error('Timed out waiting for transcription'));
            }, DEFAULT_FINISH_TIMEOUT_MS);

            this.pendingFinishes.set(dictationId, pending);

            const completed = this.takeCompletedFinal(dictationId);
            if (completed !== null) {
                this.pendingFinishes.delete(dictationId);
                pending.resolve({ text: completed });
                return;
            }

            if (!this.send({ type: 'finish', dictationId, finalSeq })) {
                this.pendingFinishes.delete(dictationId);
                pending.reject(new Error(CONNECTION_LOST));
            }
        });
    }

    hasPendingFinish(dictationId: string): boolean {
        return this.pendingFinishes.has(dictationId);
    }

    resendPendingFinish(dictationId: string): boolean {
        const pending = this.pendingFinishes.get(dictationId);
        if (!pending || !pending.needsResend) {
            return false;
        }
        if (!this.send({ type: 'finish', dictationId, finalSeq: pending.finalSeq })) {
            return false;
        }
        pending.needsResend = false;
        return true;
    }

    takeCompletedFinal(dictationId: string): string | null {
        const entry = this.completedFinals.get(dictationId);
        if (!entry) {
            return null;
        }
        this.completedFinals.delete(dictationId);
        if (Date.now() - entry.at > COMPLETED_FINAL_TTL_MS) {
            return null;
        }
        return entry.text;
    }

    isStreamActive(dictationId: string): boolean {
        return this.activeIds.has(dictationId);
    }

    abandonDictationStream(dictationId: string): void {
        this.completedFinals.delete(dictationId);
        this.releaseDictation(dictationId);
    }

    cancelDictationStream(dictationId: string): void {
        this.send({ type: 'cancel', dictationId });
        this.completedFinals.delete(dictationId);
        const request = this.startRequests.get(dictationId);
        if (request) {
            request.cancel();
            this.startRequests.delete(dictationId);
        }
        const start = this.pendingStarts.get(dictationId);
        if (start) {
            this.pendingStarts.delete(dictationId);
            start.reject(new Error('Dictation cancelled'));
        }
        const finish = this.pendingFinishes.get(dictationId);
        if (finish) {
            this.pendingFinishes.delete(dictationId);
            finish.reject(new Error('Dictation cancelled'));
        }
        this.releaseDictation(dictationId);
        this.scheduleIdleCloseIfReady();
    }

    private handleMessage(message: DictationServerMessage): void {
        const dictationId = message.dictationId;
        if (!dictationId) {
            return;
        }

        switch (message.type) {
            case 'ack': {
                const pendingStart = this.pendingStarts.get(dictationId);
                if (pendingStart) {
                    this.pendingStarts.delete(dictationId);
                    pendingStart.resolve(Number.isFinite(message.ackSeq) ? message.ackSeq ?? -1 : -1);
                }
                return;
            }
            case 'partial': {
                for (const listener of this.partialListeners) {
                    listener(dictationId, message.text ?? '');
                }
                return;
            }
            case 'finish_accepted': {
                const pendingFinish = this.pendingFinishes.get(dictationId);
                if (pendingFinish && typeof message.timeoutMs === 'number') {
                    if (pendingFinish.timeout) {
                        clearTimeout(pendingFinish.timeout);
                    }
                    pendingFinish.timeout = setTimeout(() => {
                        this.pendingFinishes.delete(dictationId);
                        pendingFinish.reject(new Error('Timed out waiting for transcription'));
                    }, message.timeoutMs + 5000);
                }
                return;
            }
            case 'final': {
                const text = message.text ?? '';
                const pendingFinish = this.pendingFinishes.get(dictationId);
                if (pendingFinish) {
                    this.pendingFinishes.delete(dictationId);
                    pendingFinish.resolve({ text });
                } else {
                    this.rememberCompletedFinal(dictationId, text);
                }
                const pendingStart = this.pendingStarts.get(dictationId);
                if (pendingStart) {
                    this.pendingStarts.delete(dictationId);
                    pendingStart.resolve(-1);
                }
                this.scheduleIdleCloseIfReady();
                return;
            }
            case 'error': {
                const error = createStreamError(
                    message.error || 'Dictation failed',
                    message.retryable !== false,
                    message.reasonCode,
                );
                const pendingStart = this.pendingStarts.get(dictationId);
                if (pendingStart) {
                    this.pendingStarts.delete(dictationId);
                    pendingStart.reject(error);
                }
                const pendingFinish = this.pendingFinishes.get(dictationId);
                if (pendingFinish) {
                    this.pendingFinishes.delete(dictationId);
                    pendingFinish.reject(error);
                }
                this.notifyStreamError(dictationId, error);
                this.scheduleIdleCloseIfReady();
                return;
            }
            default:
        }
    }

    private send(message: DictationClientMessage): boolean {
        if (!this.isConnected || !this.socket) {
            return false;
        }
        try {
            this.socket.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    private notifyStreamError(dictationId: string, error: DictationStreamError): void {
        for (const listener of this.streamErrorListeners) {
            listener(dictationId, error);
        }
    }

    private notifyConnection(connected: boolean): void {
        for (const listener of this.connectionListeners) {
            listener(connected);
        }
    }

    private rememberCompletedFinal(dictationId: string, text: string): void {
        const now = Date.now();
        for (const [id, entry] of this.completedFinals) {
            if (now - entry.at > COMPLETED_FINAL_TTL_MS) {
                this.completedFinals.delete(id);
            }
        }
        this.completedFinals.set(dictationId, { text, at: now });
    }

    private markPendingForResend(): void {
        for (const pending of this.pendingStarts.values()) {
            pending.needsResend = true;
        }
        for (const pending of this.pendingFinishes.values()) {
            pending.needsResend = true;
        }
    }

    private resendPendingStarts(): void {
        for (const [dictationId, pending] of this.pendingStarts) {
            if (!pending.needsResend) {
                continue;
            }
            if (
                this.send({
                    type: 'start',
                    dictationId,
                    format: pending.format,
                    options: pending.options,
                })
            ) {
                pending.needsResend = false;
            }
        }
    }

    private rejectAllPending(error: Error): void {
        for (const [dictationId, pending] of this.pendingStarts) {
            this.pendingStarts.delete(dictationId);
            pending.reject(error);
        }
        for (const [dictationId, pending] of this.pendingFinishes) {
            this.pendingFinishes.delete(dictationId);
            pending.reject(error);
        }
        this.completedFinals.clear();
        this.activeIds.clear();
        this.activeDictations = 0;
    }

    private releaseDictation(dictationId?: string): void {
        if (dictationId !== undefined) {
            if (!this.activeIds.delete(dictationId)) {
                return;
            }
        }
        this.activeDictations = Math.max(0, this.activeDictations - 1);
        this.scheduleIdleCloseIfReady();
    }

    private scheduleIdleCloseIfReady(): void {
        if (this.activeDictations > 0 || this.pendingFinishes.size > 0 || this.pendingStarts.size > 0) {
            return;
        }
        this.clearIdleCloseTimer();
        this.idleCloseTimer = setTimeout(() => {
            if (this.activeDictations === 0 && this.pendingFinishes.size === 0 && this.pendingStarts.size === 0) {
                const socket = this.socket;
                this.socket = null;
                if (socket) {
                    try {
                        socket.close(1000, 'idle');
                    } catch {
                        // ignore
                    }
                    this.notifyConnection(false);
                }
            }
        }, IDLE_CLOSE_DELAY_MS);
    }

    cancelAllForRuntimeSwitch(): void {
        this.clearIdleCloseTimer();
        this.reconnectGeneration += 1;
        const socket = this.socket;
        this.socket = null;
        this.connectPromise = null;
        const stranded = Array.from(this.activeIds);
        this.rejectAllPending(new Error('Runtime changed'));
        for (const dictationId of stranded) {
            this.notifyStreamError(dictationId, createStreamError('Runtime changed', false));
        }
        if (socket) {
            try {
                socket.close(1000, 'runtime switch');
            } catch {
                // ignore
            }
            this.notifyConnection(false);
        }
    }

    private clearIdleCloseTimer(): void {
        if (this.idleCloseTimer) {
            clearTimeout(this.idleCloseTimer);
            this.idleCloseTimer = null;
        }
    }
}

async function openDictationSocket(): Promise<RelayTunnelWebSocket> {
    await refreshRuntimeUrlAuthToken().catch(() => undefined);
    try {
        return openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/dictation/ws'));
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
    }
}

export const dictationClient = new DictationClient();

if (typeof window !== 'undefined') {
    window.addEventListener('openchamber:runtime-endpoint-changed', () => {
        dictationClient.cancelAllForRuntimeSwitch();
    });
}
