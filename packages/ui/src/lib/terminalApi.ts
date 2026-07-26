import type { CreateTerminalOptions, TerminalError, TerminalHandlers, TerminalSession, TerminalShellOption, TerminalStreamEvent } from './api/types';
import { openRuntimeWebSocket } from './relay/runtime-socket';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { refreshRuntimeUrlAuthToken } from './runtime-auth';
import { isTerminalShell } from './terminalShell';

type Message = Record<string, unknown> & { t: string; s?: string; q?: number };
type Subscriber = { handlers: TerminalHandlers; lastSequence: number };
type TerminalProjection = {
  sequence: number;
  history: string;
  status: TerminalStreamEvent['status'];
  exitCode?: number;
  signal?: number | null;
  runtime?: TerminalStreamEvent['runtime'];
  ptyBackend?: string;
};
const TAG = 1;
const MAX_PROJECTION_BYTES = 512 * 1024;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (message: Message): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TAG;
  frame.set(payload, 1);
  return frame;
};

const decode = async (data: unknown): Promise<Message | null> => {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data instanceof Uint8Array) bytes = data;
  else if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else if (typeof data === 'string') bytes = encoder.encode(data);
  else return null;
  if (bytes[0] === TAG) bytes = bytes.subarray(1);
  try { return JSON.parse(decoder.decode(bytes)) as Message; } catch { return null; }
};

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
};

const trimProjection = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_PROJECTION_BYTES) return value;
  let start = bytes.byteLength - MAX_PROJECTION_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

type TerminalTransportDependencies = {
  refreshAuth: () => Promise<unknown>;
  openSocket: () => RelayTunnelWebSocket;
};

export class TerminalTransport {
  private socket: RelayTunnelWebSocket | null = null;
  private opening: Promise<void> | null = null;
  private openingGeneration: number | null = null;
  private subscribers = new Map<string, Set<Subscriber>>();
  private projections = new Map<string, TerminalProjection>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private wakeCleanup: (() => void) | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly dependencies: TerminalTransportDependencies = {
    refreshAuth: refreshRuntimeUrlAuthToken,
    openSocket: () => openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/terminal/ws')),
  }) {}

  subscribe(sessionId: string, handlers: TerminalHandlers): () => void {
    const subscriber = { handlers, lastSequence: -1 };
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    const first = set.size === 0;
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    const projection = this.projections.get(sessionId);
    if (projection) {
      subscriber.lastSequence = projection.sequence;
      handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
    }
    const socketWasOpen = this.socket?.readyState === SOCKET_OPEN;
    this.ensureConnected().then(() => { if (first && socketWasOpen && set.has(subscriber)) this.send({ t: 'attach', v: 3, s: sessionId }); }).catch((error) => {
      handlers.onError?.(error, false);
      this.scheduleReconnect();
    });
    return () => {
      const current = this.subscribers.get(sessionId);
      current?.delete(subscriber);
      if (current?.size === 0) {
        this.subscribers.delete(sessionId);
        this.projections.delete(sessionId);
        this.send({ t: 'detach', v: 3, s: sessionId });
      }
      if (this.subscribers.size === 0) {
        this.generation += 1;
        this.cancelReconnect();
        this.closeSocket();
      }
    };
  }

  async write(sessionId: string, data: string): Promise<void> {
    if (!data) return;
    await this.ensureConnected();
    if (this.send({ t: 'write', v: 3, s: sessionId, d: data })) return;
    this.closeSocket();
    await this.ensureConnected();
    if (!this.send({ t: 'write', v: 3, s: sessionId, d: data })) throw new Error('Terminal connection is unavailable');
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.subscribers.clear();
    this.projections.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.wakeCleanup?.();
    this.wakeCleanup = null;
    this.closeSocket();
  }

  forget(sessionId: string): void {
    this.projections.delete(sessionId);
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error('Terminal runtime changed');
    if (this.socket?.readyState === SOCKET_OPEN) return;
    if (this.opening && this.openingGeneration === this.generation) {
      await this.opening;
      if (this.socket?.readyState === SOCKET_OPEN) return;
      return this.ensureConnected();
    }
    if (this.openingGeneration !== this.generation) {
      this.opening = null;
      this.openingGeneration = null;
    }
    const generation = this.generation;
    const opening = (async () => {
      await this.dependencies.refreshAuth();
      if (generation !== this.generation || this.disposed) throw new Error('Terminal runtime changed');
      await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pendingSocket: RelayTunnelWebSocket | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        pendingSocket?.close();
        finish(new Error('Terminal connection timed out'));
      }, 10_000);
      try {
        const socket = this.dependencies.openSocket();
        pendingSocket = socket;
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        socket.onopen = () => {
          if (generation !== this.generation || this.disposed) { socket.close(); finish(new Error('Terminal runtime changed')); return; }
          this.failures = 0;
          this.send({ t: 'hello', v: 3 });
          for (const sessionId of this.subscribers.keys()) this.send({ t: 'attach', v: 3, s: sessionId });
          this.startKeepalive();
          finish();
        };
        socket.onmessage = (event) => void this.handleMessage(event.data);
        socket.onerror = () => {
          finish(new Error('Terminal WebSocket failed'));
          if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
        };
        socket.onclose = () => {
          if (this.socket === socket) this.socket = null;
          this.stopKeepalive();
          finish(new Error('Terminal WebSocket closed'));
          if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
        };
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Terminal WebSocket failed'));
        if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
      }
      });
    })();
    this.opening = opening;
    this.openingGeneration = generation;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
        this.openingGeneration = null;
      }
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = await decode(raw);
    if (!message || message.t === 'hello' || message.t === 'pong') return;
    if (message.t === 'error') {
      const error = new Error(typeof message.message === 'string' ? message.message : 'Terminal error') as TerminalError;
      if (typeof message.code === 'string') error.code = message.code;
      const targets = message.s ? [message.s] : [...this.subscribers.keys()];
      for (const id of targets) for (const sub of this.subscribers.get(id) ?? []) sub.handlers.onError?.(error, message.fatal === true);
      return;
    }
    if (!message.s) return;
    const subscribers = this.subscribers.get(message.s);
    if (!subscribers) return;
    if (message.t === 'snapshot') {
      const projection: TerminalProjection = {
        sequence: typeof message.q === 'number' ? message.q : 0,
        history: typeof message.history === 'string' ? message.history : '',
        status: message.status as TerminalStreamEvent['status'],
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined,
        signal: typeof message.signal === 'number' ? message.signal : null,
        runtime: message.runtime as TerminalStreamEvent['runtime'],
        ptyBackend: typeof message.ptyBackend === 'string' ? message.ptyBackend : undefined,
      };
      this.projections.set(message.s, projection);
      for (const sub of subscribers) {
        sub.lastSequence = projection.sequence;
        sub.handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
      }
      return;
    }
    if (typeof message.q !== 'number') return;
    const previous = this.projections.get(message.s);
    if (previous && message.q > previous.sequence) {
      if (message.t === 'output') this.projections.set(message.s, { ...previous, sequence: message.q, history: trimProjection(previous.history + (typeof message.r === 'string' ? message.r : (typeof message.d === 'string' ? message.d : ''))) });
      else if (message.t === 'exit') this.projections.set(message.s, { ...previous, sequence: message.q, status: 'exited', exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined, signal: typeof message.signal === 'number' ? message.signal : null });
      else if (message.t === 'restarted') this.projections.set(message.s, { ...previous, sequence: message.q, history: typeof message.history === 'string' ? message.history : '', status: 'running', exitCode: undefined, signal: null });
    }
    for (const sub of subscribers) {
      if (message.q <= sub.lastSequence) continue;
      sub.lastSequence = message.q;
      if (message.t === 'output') sub.handlers.onEvent({ type: 'data', sequence: message.q, data: typeof message.d === 'string' ? message.d : '', replayData: typeof message.r === 'string' ? message.r : undefined });
      else if (message.t === 'exit') sub.handlers.onEvent({ type: 'exit', sequence: message.q, exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined, signal: typeof message.signal === 'number' ? message.signal : null });
      else if (message.t === 'restarted') sub.handlers.onEvent({ type: 'snapshot', sequence: message.q, data: typeof message.history === 'string' ? message.history : '', status: 'running' });
    }
  }

  private send(message: Message): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try { this.socket.send(encode(message)); return true; } catch { return false; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || this.subscribers.size === 0) return;
    this.failures += 1;
    const slow = (typeof document !== 'undefined' && document.visibilityState === 'hidden') || (typeof navigator !== 'undefined' && !navigator.onLine);
    const delay = Math.min(500 * 2 ** Math.min(this.failures - 1, 10), slow ? 60_000 : 8_000);
    for (const set of this.subscribers.values()) for (const sub of set) sub.handlers.onEvent({ type: 'reconnecting', attempt: this.failures, maxAttempts: Number.POSITIVE_INFINITY });
    const wake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.wakeCleanup?.(); this.wakeCleanup = null;
      void this.ensureConnected().catch(() => this.scheduleReconnect());
    };
    if (typeof window !== 'undefined') window.addEventListener('online', wake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
    this.wakeCleanup = () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', wake);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
    };
    this.reconnectTimer = setTimeout(wake, delay);
  }

  private startKeepalive(): void { this.stopKeepalive(); this.keepaliveTimer = setInterval(() => this.send({ t: 'ping', v: 3 }), 20_000); }
  private stopKeepalive(): void { if (this.keepaliveTimer) clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  private cancelReconnect(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.wakeCleanup?.(); this.wakeCleanup = null; }
  private closeSocket(): void { this.stopKeepalive(); const socket = this.socket; this.socket = null; if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) socket.close(); }
}

let transport = new TerminalTransport();

export async function createTerminalSession(options: CreateTerminalOptions): Promise<TerminalSession> {
  const response = await runtimeFetch('/api/terminal/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
  if (!response.ok) throw await responseError(response, 'Failed to create terminal session');
  return response.json() as Promise<TerminalSession>;
}
export async function listTerminalShells(): Promise<TerminalShellOption[]> {
  const response = await runtimeFetch('/api/terminal/shells');
  if (!response.ok) throw await responseError(response, 'Failed to list terminal shells');
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload)
    ? payload.filter((entry): entry is TerminalShellOption => (
        entry && typeof entry === 'object' && isTerminalShell(entry.id) && typeof entry.name === 'string' && typeof entry.supportsLogin === 'boolean'
      ))
    : [];
}
export function connectTerminalStream(sessionId: string, onEvent: TerminalHandlers['onEvent'], onError?: TerminalHandlers['onError']): () => void { return transport.subscribe(sessionId, { onEvent, onError }); }
export async function sendTerminalInput(sessionId: string, data: string): Promise<void> { await transport.write(sessionId, data); }

async function command(path: string, method: string, body?: unknown): Promise<Response> {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await runtimeFetch(path, options);
  if (!response.ok) throw await responseError(response, 'Terminal command failed');
  return response;
}
export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> { await command(`/api/terminal/${sessionId}/resize`, 'POST', { cols, rows }); }
export async function updateTerminalAppearance(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>): Promise<void> { await command(`/api/terminal/${sessionId}/appearance`, 'POST', appearance); }
export async function closeTerminal(sessionId: string): Promise<void> { await command(`/api/terminal/${sessionId}`, 'DELETE'); transport.forget(sessionId); }
export async function restartTerminalSession(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession> { return (await command(`/api/terminal/${currentSessionId}/restart`, 'POST', options)).json() as Promise<TerminalSession>; }
export async function forceKillTerminal(options: { sessionId?: string; cwd?: string }): Promise<void> {
  const response = await command('/api/terminal/force-kill', 'POST', options);
  const result = await response.json().catch(() => null) as { killedSessionIds?: unknown } | null;
  if (Array.isArray(result?.killedSessionIds)) {
    for (const sessionId of result.killedSessionIds) if (typeof sessionId === 'string') transport.forget(sessionId);
  } else if (options.sessionId) transport.forget(options.sessionId);
}
export function disposeTerminalInputTransport(): void { transport.dispose(); transport = new TerminalTransport(); }
