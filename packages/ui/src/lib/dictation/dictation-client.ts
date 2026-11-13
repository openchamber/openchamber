/**
 * WebSocket client for the OpenChamber dictation endpoint (/api/dictation/ws).
 *
 * One shared client per app. The socket is opened lazily when a dictation
 * starts and closed after an idle delay. URLs are resolved at connect time via
 * the runtime URL resolver so runtime switches never leak a stale endpoint.
 */

import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

export interface DictationStartOptions {
    provider?: 'local' | 'openai-compatible';
    language?: string;
    localModel?: string;
    /** Fix misheard words with the Small Model before the final text. */
    correct?: boolean;
    openaiCompatible?: {
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        endpointPath?: string;
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

export type DictationStreamFailure = DictationStreamError;

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
// The first start of a session also loads the local ONNX engine (measured ~3s
// on an M1, more on slower machines and on first run after boot). 15s left too
// little headroom and surfaced as "Dictation start timed out" before the worker
// was ready.
const START_TIMEOUT_MS = 30000;
const IDLE_CLOSE_DELAY_MS = 30000;
const DEFAULT_FINISH_TIMEOUT_MS = 60000;
// While a dictation runs, a dropped socket is retried instead of failing the
// dictation: the stream lives on the server and is resumed where it stopped.
// Waits between attempts, and the total a single drop may spend reconnecting.
const RECONNECT_DELAYS_MS = [200, 500, 1000, 2000, 5000];
const RECONNECT_BUDGET_MS = 15000;
// A `final` can reach the client before the caller asked for it: the server
// answers the repeated `start` of a dictation it already finished. It is held
// this long, so the `finish` that follows resolves with it instead of timing
// out on a stream that no longer exists.
const COMPLETED_FINAL_TTL_MS = 60000;

const delayMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ConnectionStatusListener = (connected: boolean) => void;
type PartialListener = (dictationId: string, text: string) => void;
type StreamErrorListener = (dictationId: string, error: DictationStreamFailure) => void;

interface PendingStart {
    resolve: (ackSeq: number) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    format: string;
    options: DictationStartOptions;
    /** The start went out on a socket that died before the ack came. */
    needsResend: boolean;
}

interface PendingFinish {
    resolve: (result: { text: string }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout> | null;
    finalSeq: number;
    /** The finish frame went out on a socket that died before the server answered. */
    needsResend: boolean;
}

export class DictationClient {
    private socket: RelayTunnelWebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectPromise: Promise<void> | null = null;
    private reconnectGeneration = 0;
    private readonly pendingStarts = new Map<string, PendingStart>();
    private readonly pendingFinishes = new Map<string, PendingFinish>();
    private readonly completedFinals = new Map<string, { text: string; at: number }>();
    private readonly connectionListeners = new Set<ConnectionStatusListener>();
    private readonly partialListeners = new Set<PartialListener>();
    private readonly streamErrorListeners = new Set<StreamErrorListener>();
    private readonly activeIds = new Set<string>();
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

    /**
     * A server `error` frame for a dictation the caller may not be waiting on:
     * no open start and no open finish. Without this channel such an error is
     * lost, and the user keeps speaking into a stream that no longer exists.
     */
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

        // The slot is filled synchronously, before the first await: two callers
        // that connect at the same time (a resume and a reconnect) must share
        // one attempt instead of opening two sockets.
        const attempt = (async () => {
            // A WebSocket upgrade can't carry an Authorization header, so it
            // authenticates via the oc_url_token query param. Mint/await a valid
            // token BEFORE connecting — the sync getter returns "" while the token
            // is unminted or inside its expiry skew, and the server would reject
            // the upgrade with 401.
            try {
                await refreshRuntimeUrlAuthToken();
            } catch {
                // No auth configured (local runtime) — proceed without a token.
            }

            await new Promise<void>((resolve, reject) => {
                let settled = false;
                let socket: RelayTunnelWebSocket;
                try {
                    const url = getRuntimeUrlResolver().websocket('/api/dictation/ws');
                    socket = openRuntimeWebSocket(url);
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }

                const timeout = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        try {
                            socket.close();
                        } catch {
                            // ignore
                        }
                        reject(new Error('Dictation connection timed out'));
                    }
                }, Math.max(250, timeoutMs));

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
                        // A start whose frame died with the previous socket is
                        // sent once more, before anything else uses this one:
                        // the pending promise is still waiting for its ack.
                        this.resendPendingStarts();
                        this.notifyConnection(true);
                        resolve();
                        return;
                    }
                    this.handleMessage(message);
                };

                socket.onerror = () => {
                    // Prefer onclose, which follows with the real reason (e.g.
                    // "Unexpected server response: 403"). But if a socket ever errors
                    // without a prompt onclose, fail fast here rather than hanging for
                    // the full connect timeout. onclose still wins if it arrives first.
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
                        // A dictation is running: the stream survives on the
                        // server, so keep the pending entries and come back
                        // instead of failing the dictation. A frame that was
                        // sent into the dying socket is sent again.
                        this.markPendingForResend();
                        this.startReconnect();
                        return;
                    }
                    this.rejectAllPending(new Error('Dictation connection lost'));
                    this.notifyConnection(false);
                };
            });
        })();

        this.connectPromise = attempt;
        try {
            await attempt;
        } finally {
            // Every attempt, failed or not, must clear the slot: a stale
            // promise would make every later connect wait on it.
            if (this.connectPromise === attempt) {
                this.connectPromise = null;
            }
        }
    }

    /**
     * Retry the socket while a dictation is running. Resolves once connected,
     * rejects when the budget is spent; pending starts and finishes stay in
     * place meanwhile, so the dictation resumes instead of failing.
     */
    private startReconnect(): void {
        if (this.reconnectPromise) {
            return;
        }
        const generation = this.reconnectGeneration;
        const startedAt = Date.now();

        const attempt = (async () => {
            for (const delay of RECONNECT_DELAYS_MS) {
                if (this.isConnected) {
                    return;
                }
                if (this.activeDictations === 0 && this.pendingFinishes.size === 0) {
                    // Cancelled or finished meanwhile: nothing left to reconnect for.
                    return;
                }
                const remaining = RECONNECT_BUDGET_MS - (Date.now() - startedAt);
                if (remaining <= delay) {
                    break;
                }
                await delayMs(delay);
                if (this.reconnectGeneration !== generation) {
                    return;
                }
                if (this.isConnected) {
                    return;
                }
                try {
                    await this.ensureConnected(RECONNECT_BUDGET_MS - (Date.now() - startedAt));
                } catch {
                    // Next attempt; the budget decides when to give up.
                }
            }
            if (this.isConnected) {
                return;
            }
            throw new Error('Dictation connection lost');
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
                this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
                this.notifyConnection(false);
            },
        );
    }

    /**
     * Start a dictation stream. Resolves once the server acks the stream, with
     * the highest seq it already holds (-1 on a fresh stream, and the last seq
     * before the interruption when the same id is resumed).
     */
    async startDictationStream(
        dictationId: string,
        format: string,
        options: DictationStartOptions,
    ): Promise<{ ackSeq: number }> {
        await this.ensureConnected();
        // One count per dictation, not per start: a resume starts the same
        // dictation again and must not inflate the counter, or a later drop
        // would wait for a reconnect nobody needs.
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

            // The server already answered this dictation: its `final` came
            // back with the resumed `start` while this call was on its way.
            const completed = this.takeCompletedFinal(dictationId);
            if (completed !== null) {
                this.pendingFinishes.delete(dictationId);
                pending.resolve({ text: completed });
                return;
            }

            if (!this.send({ type: 'finish', dictationId, finalSeq })) {
                this.pendingFinishes.delete(dictationId);
                pending.reject(new Error('Dictation connection lost'));
            }
        });
    }

    /** True while a finish of this dictation is waiting for its `final`. */
    hasPendingFinish(dictationId: string): boolean {
        return this.pendingFinishes.has(dictationId);
    }

    /**
     * Send the finish frame of an open finish again, once. It is called after
     * a reconnect has re-attached the socket to the dictation and the missing
     * audio has been replayed: before that, the server would either not know
     * where to send the answer or wait for audio that is still on its way.
     *
     * @returns true when a frame was sent
     */
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

    /**
     * A `final` the server sent before anyone asked for it, consumed once.
     * The sender checks this after a resumed `start`: the server was already
     * finished, so there is no audio left to send.
     */
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

    /**
     * Drop a dictation the server no longer holds, so a later socket drop does
     * not keep reconnecting for a stream that is gone. Buffered audio stays
     * with the sender for a retry under a new id.
     */
    abandonDictationStream(dictationId: string): void {
        this.completedFinals.delete(dictationId);
        this.releaseDictation(dictationId);
    }

    cancelDictationStream(dictationId: string): void {
        this.send({ type: 'cancel', dictationId });
        this.completedFinals.delete(dictationId);
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
                    pendingStart.resolve(typeof message.ackSeq === 'number' ? message.ackSeq : -1);
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
                // Remember it first: it may arrive before anyone waits for it
                // (the server answered a resumed start of a finished
                // dictation), and it must not be lost then.
                this.rememberCompletedFinal(dictationId, text);
                const pendingFinish = this.pendingFinishes.get(dictationId);
                if (pendingFinish) {
                    this.pendingFinishes.delete(dictationId);
                    pendingFinish.resolve({ text });
                }
                // A start waiting for its ack gets one: the stream is gone, so
                // the server holds nothing. The caller then takes the finished
                // text instead of replaying audio into an empty stream.
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
                for (const listener of this.streamErrorListeners) {
                    listener(dictationId, error);
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

    private rememberCompletedFinal(dictationId: string, text: string): void {
        const now = Date.now();
        for (const [id, entry] of this.completedFinals) {
            if (now - entry.at > COMPLETED_FINAL_TTL_MS) {
                this.completedFinals.delete(id);
            }
        }
        this.completedFinals.set(dictationId, { text, at: now });
    }

    /** Mark every frame that a dying socket may have swallowed. */
    private markPendingForResend(): void {
        for (const pending of this.pendingStarts.values()) {
            pending.needsResend = true;
        }
        for (const pending of this.pendingFinishes.values()) {
            pending.needsResend = true;
        }
    }

    /** One resend per reconnect, for starts that are still waiting for an ack. */
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

    /**
     * Runtime switch: close the socket and fail all in-flight dictations so
     * nothing keeps streaming to the previous runtime.
     */
    cancelAllForRuntimeSwitch(): void {
        this.clearIdleCloseTimer();
        this.reconnectGeneration += 1;
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
