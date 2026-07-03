/**
 * WebSocket client for the OpenChamber dictation endpoint (/api/dictation/ws).
 *
 * One shared client per app. The socket is opened lazily when a dictation
 * starts and closed after an idle delay. URLs are resolved at connect time via
 * the runtime URL resolver so runtime switches never leak a stale endpoint.
 */

import { getRuntimeUrlResolver } from '@/lib/runtime-url';

export interface DictationStartOptions {
    provider?: 'local' | 'openai-compatible';
    language?: string;
    localModel?: string;
    openaiCompatible?: {
        baseUrl?: string;
        model?: string;
        apiKey?: string;
    };
}

interface DictationServerMessage {
    type: string;
    dictationId?: string;
    ackSeq?: number;
    text?: string;
    timeoutMs?: number;
    error?: string;
    retryable?: boolean;
    reasonCode?: string;
}

interface DictationStreamError extends Error {
    retryable: boolean;
    reasonCode?: string;
}

const createStreamError = (message: string, retryable: boolean, reasonCode?: string): DictationStreamError => {
    const error = new Error(message) as DictationStreamError;
    error.name = 'DictationStreamError';
    error.retryable = retryable;
    if (reasonCode) {
        error.reasonCode = reasonCode;
    }
    return error;
};

const CONNECT_TIMEOUT_MS = 10000;
const START_TIMEOUT_MS = 15000;
const IDLE_CLOSE_DELAY_MS = 30000;
const DEFAULT_FINISH_TIMEOUT_MS = 30000;

type ConnectionStatusListener = (connected: boolean) => void;
type PartialListener = (dictationId: string, text: string) => void;

interface PendingStart {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface PendingFinish {
    resolve: (result: { text: string }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout> | null;
}

export class DictationClient {
    private socket: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly pendingStarts = new Map<string, PendingStart>();
    private readonly pendingFinishes = new Map<string, PendingFinish>();
    private readonly connectionListeners = new Set<ConnectionStatusListener>();
    private readonly partialListeners = new Set<PartialListener>();
    private activeDictations = 0;

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

    async ensureConnected(): Promise<void> {
        if (this.isConnected) {
            return;
        }
        if (this.connectPromise) {
            await this.connectPromise;
            return;
        }

        this.connectPromise = new Promise<void>((resolve, reject) => {
            let settled = false;
            let socket: WebSocket;
            try {
                const url = getRuntimeUrlResolver().websocket('/api/dictation/ws');
                socket = new WebSocket(url);
            } catch (error) {
                this.connectPromise = null;
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    this.connectPromise = null;
                    try {
                        socket.close();
                    } catch {
                        // ignore
                    }
                    reject(new Error('Dictation connection timed out'));
                }
            }, CONNECT_TIMEOUT_MS);

            socket.onopen = () => {
                // Wait for the server 'ready' frame before resolving.
            };

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
                    this.socket = socket;
                    this.connectPromise = null;
                    this.notifyConnection(true);
                    resolve();
                    return;
                }
                this.handleMessage(message);
            };

            socket.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    this.connectPromise = null;
                    reject(new Error('Dictation connection failed'));
                }
            };

            socket.onclose = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    this.connectPromise = null;
                    reject(new Error('Dictation connection closed'));
                    return;
                }
                if (this.socket === socket) {
                    this.socket = null;
                    this.rejectAllPending(new Error('Dictation connection lost'));
                    this.notifyConnection(false);
                }
            };
        });

        await this.connectPromise;
    }

    /**
     * Start a dictation stream. Resolves once the server acks the stream.
     */
    async startDictationStream(
        dictationId: string,
        format: string,
        options: DictationStartOptions,
    ): Promise<void> {
        await this.ensureConnected();
        this.activeDictations += 1;
        this.clearIdleCloseTimer();

        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingStarts.delete(dictationId);
                this.releaseDictation();
                reject(new Error('Dictation start timed out'));
            }, START_TIMEOUT_MS);

            this.pendingStarts.set(dictationId, {
                resolve: () => {
                    clearTimeout(timeout);
                    resolve();
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    this.releaseDictation();
                    reject(error);
                },
            timeout });

            if (!this.send({ type: 'start', dictationId, format, options })) {
                clearTimeout(timeout);
                this.pendingStarts.delete(dictationId);
                this.releaseDictation();
                reject(new Error('Dictation connection lost'));
            }
        });
    }

    sendDictationStreamChunk(dictationId: string, seq: number, audioBase64: string): boolean {
        return this.send({ type: 'chunk', dictationId, seq, audio: audioBase64 });
    }

    /**
     * Finish a dictation stream. Resolves with the final transcript.
     */
    finishDictationStream(dictationId: string, finalSeq: number): Promise<{ text: string }> {
        return new Promise<{ text: string }>((resolve, reject) => {
            const pending: PendingFinish = {
                resolve: (result) => {
                    if (pending.timeout) {
                        clearTimeout(pending.timeout);
                    }
                    this.releaseDictation();
                    resolve(result);
                },
                reject: (error) => {
                    if (pending.timeout) {
                        clearTimeout(pending.timeout);
                    }
                    this.releaseDictation();
                    reject(error);
                },
                timeout: null,
            };
            pending.timeout = setTimeout(() => {
                this.pendingFinishes.delete(dictationId);
                this.releaseDictation();
                reject(new Error('Timed out waiting for transcription'));
            }, DEFAULT_FINISH_TIMEOUT_MS);

            this.pendingFinishes.set(dictationId, pending);

            if (!this.send({ type: 'finish', dictationId, finalSeq })) {
                this.pendingFinishes.delete(dictationId);
                pending.reject(new Error('Dictation connection lost'));
            }
        });
    }

    cancelDictationStream(dictationId: string): void {
        this.send({ type: 'cancel', dictationId });
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
        this.releaseDictation();
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
                    pendingStart.resolve();
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
                const pendingFinish = this.pendingFinishes.get(dictationId);
                if (pendingFinish) {
                    this.pendingFinishes.delete(dictationId);
                    pendingFinish.resolve({ text: message.text ?? '' });
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
                this.scheduleIdleCloseIfReady();
                return;
            }
            default:
        }
    }

    private send(message: object): boolean {
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

    private notifyConnection(connected: boolean): void {
        for (const listener of this.connectionListeners) {
            listener(connected);
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
        this.activeDictations = 0;
    }

    private releaseDictation(): void {
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

    /**
     * Runtime switch: close the socket and fail all in-flight dictations so
     * nothing keeps streaming to the previous runtime.
     */
    cancelAllForRuntimeSwitch(): void {
        this.clearIdleCloseTimer();
        const socket = this.socket;
        this.socket = null;
        this.connectPromise = null;
        this.rejectAllPending(new Error('Runtime changed'));
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

export const dictationClient = new DictationClient();

if (typeof window !== 'undefined') {
    window.addEventListener('openchamber:runtime-endpoint-changed', () => {
        // Drop the socket so the next dictation reconnects to the new runtime.
        dictationClient.cancelAllForRuntimeSwitch();
    });
}
