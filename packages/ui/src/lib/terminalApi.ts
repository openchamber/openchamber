import type { CreateTerminalOptions, TerminalError, TerminalHandlers, TerminalServerSession, TerminalSession, TerminalSessionPurpose, TerminalShellOption, TerminalStreamEvent } from './api/types';
import { openRuntimeWebSocket } from './relay/runtime-socket';
import type { RelayTunnelSocketMessageEvent, RelayTunnelWebSocket } from './relay/tunnel-client';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from './runtime-auth';
import { isTerminalShell } from './terminalShell';
import { z } from 'zod';

type ClientMessage =
  | { t: 'hello' | 'ping'; v: 3 }
  | { t: 'attach' | 'detach'; v: 3; s: string }
  | { t: 'write'; v: 3; s: string; d: string };
type Subscriber = { handlers: TerminalHandlers; lastSequence: number };
type TerminalProjection = {
  sequence: number;
  history: string;
  status: TerminalStreamEvent['status'];
  mode?: TerminalSession['mode'];
  purpose?: TerminalSessionPurpose;
  exitCode?: number;
  signal?: number | null;
  runtime?: TerminalStreamEvent['runtime'];
  ptyBackend?: string;
};
const TAG = 1;
const MAX_PROJECTION_BYTES = 512 * 1024;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
/**
 * Switching terminal tabs detaches the old terminal before attaching the new one,
 * which momentarily leaves zero subscribers. Closing the socket there forced a
 * token refresh, a fresh upgrade and a full snapshot replay on every switch, so
 * hold the idle socket briefly and reuse it instead.
 */
const IDLE_SOCKET_GRACE_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const terminalModeSchema = z.enum(['interactive', 'command']);
const terminalStatusSchema = z.enum(['running', 'exited', 'error']);
const terminalRuntimeSchema = z.enum(['node', 'bun']);
type TerminalSessionPurposeInput =
  | TerminalSessionPurpose
  | { type: 'project-action'; actionId: string; executionId?: string }
  | null
  | undefined;
type TerminalSessionInput = {
  sessionId?: string;
  cols?: number;
  rows?: number;
  status?: 'running' | 'exited' | 'error';
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurposeInput;
} | null | undefined;
const terminalSessionPurposeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal') }),
  z.object({ type: z.literal('project-action'), actionId: z.string(), executionId: z.string() }),
]);
const terminalSessionSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
  status: terminalStatusSchema,
  mode: terminalModeSchema.optional(),
  purpose: terminalSessionPurposeSchema.optional(),
});
const terminalServerSessionSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  createdAt: z.number().nullable().optional().transform((value) => value ?? null),
  mode: terminalModeSchema.optional(),
  purpose: terminalSessionPurposeSchema.optional(),
});

const terminalMessageMetadata = {
  mode: terminalModeSchema.optional(),
  purpose: terminalSessionPurposeSchema.optional(),
};
const terminalMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello') }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('error'), s: z.string().optional(), message: z.string().optional(), code: z.string().optional(), fatal: z.boolean().optional() }),
  z.object({
    t: z.literal('snapshot'), s: z.string(), q: z.number().int().nonnegative().default(0),
    history: z.string().default(''), status: terminalStatusSchema,
    exitCode: z.number().nullish().transform(value => value ?? undefined), signal: z.number().nullable().optional(),
    runtime: terminalRuntimeSchema.optional(), ptyBackend: z.string().optional(), ...terminalMessageMetadata,
  }),
  z.object({ t: z.literal('output'), s: z.string(), q: z.number().int().nonnegative(), d: z.string(), r: z.string().optional() }),
  z.object({ t: z.literal('exit'), s: z.string(), q: z.number().int().nonnegative(), exitCode: z.number().nullish().transform(value => value ?? undefined), signal: z.number().nullable().optional() }),
  z.object({ t: z.literal('restarted'), s: z.string(), q: z.number().int().nonnegative(), history: z.string().default(''), ...terminalMessageMetadata }),
]);
type TerminalMessage = z.infer<typeof terminalMessageSchema>;

const encode = (message: ClientMessage): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TAG;
  frame.set(payload, 1);
  return frame;
};

const decode = (data: RelayTunnelSocketMessageEvent['data']): TerminalMessage | null => {
  let bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : encoder.encode(data);
  if (bytes[0] === TAG) bytes = bytes.subarray(1);
  try { return terminalMessageSchema.safeParse(JSON.parse(decoder.decode(bytes))).data ?? null; } catch { return null; }
};

/**
 * Server error code for a terminal request whose working directory no longer
 * exists (a deleted worktree). Mirrors `TERMINAL_CWD_MISSING_CODE` in
 * `packages/web/server/lib/terminal/runtime.js`.
 */
const TERMINAL_CWD_MISSING_CODE = 'TERMINAL_CWD_MISSING';

export class TerminalRequestError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'TerminalRequestError';
    this.code = code;
  }
}

export const isTerminalCwdMissingError = (error: unknown): boolean =>
  error instanceof TerminalRequestError && error.code === TERMINAL_CWD_MISSING_CODE;

const terminalErrorBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() });

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = terminalErrorBodySchema.safeParse(await response.json().catch(() => null)).data;
  return new TerminalRequestError(body?.error ?? fallback, body?.code ?? null);
};

const trimProjection = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_PROJECTION_BYTES) return value;
  let start = bytes.byteLength - MAX_PROJECTION_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

const terminalSessionListSchema = z.object({ sessions: z.array(z.unknown()) });

export const parseTerminalSessionPurpose = (value: TerminalSessionPurposeInput): TerminalSessionPurpose | undefined => {
  return terminalSessionPurposeSchema.safeParse(value).data;
};

export const parseTerminalSession = (value: TerminalSessionInput): TerminalSession | null => {
  return terminalSessionSchema.safeParse(value).data ?? null;
};

type TerminalTransportDependencies = {
  refreshAuth: () => Promise<unknown>;
  openSocket: () => RelayTunnelWebSocket;
  clearUrlAuthToken?: () => void;
};

export class TerminalTransport {
  private socket: RelayTunnelWebSocket | null = null;
  private opening: Promise<void> | null = null;
  private subscribers = new Map<string, Set<Subscriber>>();
  private projections = new Map<string, TerminalProjection>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private wakeCleanup: (() => void) | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly dependencies: TerminalTransportDependencies = {
    refreshAuth: refreshRuntimeUrlAuthToken,
    openSocket: () => openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/terminal/ws')),
    clearUrlAuthToken: clearRuntimeUrlAuthToken,
  }) {}

  subscribe(sessionId: string, handlers: TerminalHandlers): () => void {
    this.cancelIdleClose();
    const subscriber = { handlers, lastSequence: -1 };
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    const first = set.size === 0;
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    const projection = this.projections.get(sessionId);
    if (projection) {
      subscriber.lastSequence = projection.sequence;
      handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, mode: projection.mode, purpose: projection.purpose, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
    }
    const socketWasOpen = this.socket?.readyState === SOCKET_OPEN;
    this.ensureConnected().then(() => {
      const current = this.subscribers.get(sessionId);
      if (first && socketWasOpen && current === set && current.size > 0) {
        this.send({ t: 'attach', v: 3, s: sessionId });
      }
    }).catch((error) => {
      if (!set.has(subscriber)) return;
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
        this.cancelReconnect();
        this.failures = 0;
        if (this.socket?.readyState === SOCKET_OPEN) {
          // Healthy socket: hold it briefly so a tab switch can reattach to it.
          this.scheduleIdleClose();
          return;
        }
        // Nothing to reuse, so abandon any dial that is still in flight.
        this.generation += 1;
        this.opening = null;
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
    this.opening = null;
    this.subscribers.clear();
    this.projections.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelIdleClose();
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
    if (this.opening) {
      await this.opening;
      if (this.socket?.readyState === SOCKET_OPEN) return;
      return this.ensureConnected();
    }
    const generation = this.generation;
    const opening = (async () => {
      await this.dependencies.refreshAuth();
      if (generation !== this.generation || this.disposed) throw new Error('Terminal runtime changed');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let opened = false;
        let authInvalidated = false;
        let pendingSocket: RelayTunnelWebSocket | null = null;
        const isCurrentSocket = () => (
          generation === this.generation &&
          !this.disposed &&
          pendingSocket !== null &&
          this.socket === pendingSocket
        );
        const invalidatePreOpenAuth = () => {
          if (authInvalidated || opened || !isCurrentSocket()) return;
          authInvalidated = true;
          this.dependencies.clearUrlAuthToken?.();
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          invalidatePreOpenAuth();
          pendingSocket?.close();
          finish(new Error('Terminal connection timed out'));
        }, 10_000);
        try {
          const socket = this.dependencies.openSocket();
          pendingSocket = socket;
          socket.binaryType = 'arraybuffer';
          this.socket = socket;
          socket.onopen = () => {
            if (!isCurrentSocket()) { socket.close(); finish(new Error('Terminal runtime changed')); return; }
            opened = true;
            this.failures = 0;
            this.send({ t: 'hello', v: 3 });
            for (const sessionId of this.subscribers.keys()) this.send({ t: 'attach', v: 3, s: sessionId });
            this.startKeepalive();
            finish();
          };
          socket.onmessage = (event) => void this.handleMessage(event.data);
          socket.onerror = () => {
            const current = isCurrentSocket();
            if (current) invalidatePreOpenAuth();
            finish(new Error('Terminal WebSocket failed'));
            if (current && this.subscribers.size > 0) this.scheduleReconnect();
          };
          socket.onclose = () => {
            const current = isCurrentSocket();
            if (current) {
              this.stopKeepalive();
              // An upgrade rejected before `open` commonly means the cached
              // URL-scoped auth token is stale. Retrying it reaches the 8s
              // backoff cap instead of minting a fresh token.
              invalidatePreOpenAuth();
            }
            if (this.socket === socket) this.socket = null;
            finish(new Error('Terminal WebSocket closed'));
            if (current && this.subscribers.size > 0) this.scheduleReconnect();
          };
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Terminal WebSocket failed'));
          if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
        }
      });
    })();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
      }
    }
  }

  private handleMessage(raw: RelayTunnelSocketMessageEvent['data']): void {
    const message = decode(raw);
    if (!message || message.t === 'hello' || message.t === 'pong') return;
    if (message.t === 'error') {
      const error: TerminalError = new Error(message.message ?? 'Terminal error');
      error.code = message.code;
      const targets = message.s ? [message.s] : [...this.subscribers.keys()];
      for (const id of targets) for (const sub of this.subscribers.get(id) ?? []) sub.handlers.onError?.(error, message.fatal === true);
      return;
    }
    if (!message.s) return;
    const subscribers = this.subscribers.get(message.s);
    if (!subscribers) return;
    if (message.t === 'snapshot') {
      const projection: TerminalProjection = {
        sequence: message.q ?? 0,
        history: message.history ?? '',
        status: message.status,
        mode: message.mode,
        purpose: message.purpose,
        exitCode: message.exitCode,
        signal: message.signal ?? null,
        runtime: message.runtime,
        ptyBackend: message.ptyBackend,
      };
      this.projections.set(message.s, projection);
      for (const sub of subscribers) {
        sub.lastSequence = projection.sequence;
        sub.handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, mode: projection.mode, purpose: projection.purpose, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
      }
      return;
    }

    const previous = this.projections.get(message.s);
    if (previous && message.q > previous.sequence) {
      if (message.t === 'output') this.projections.set(message.s, { ...previous, sequence: message.q, history: trimProjection(previous.history + (message.r ?? message.d)) });
      else if (message.t === 'exit') this.projections.set(message.s, { ...previous, sequence: message.q, status: 'exited', exitCode: message.exitCode, signal: message.signal ?? null });
      else if (message.t === 'restarted') this.projections.set(message.s, { ...previous, sequence: message.q, history: message.history ?? '', status: 'running', mode: message.mode ?? previous.mode, purpose: message.purpose ?? previous.purpose, exitCode: undefined, signal: null });
    }
    for (const sub of subscribers) {
      if (message.q <= sub.lastSequence) continue;
      sub.lastSequence = message.q;
      if (message.t === 'output') sub.handlers.onEvent({ type: 'data', sequence: message.q, data: message.d, replayData: message.r });
      else if (message.t === 'exit') sub.handlers.onEvent({ type: 'exit', sequence: message.q, exitCode: message.exitCode, signal: message.signal ?? null });
      else if (message.t === 'restarted') sub.handlers.onEvent({ type: 'snapshot', sequence: message.q, data: message.history ?? '', status: 'running', mode: message.mode ?? previous?.mode, purpose: message.purpose ?? previous?.purpose });
    }
  }

  private send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try { this.socket.send(encode(message)); return true; } catch { return false; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || this.subscribers.size === 0) return;
    this.failures += 1;
    const slow = (typeof document !== 'undefined' && document.visibilityState === 'hidden') || (typeof navigator !== 'undefined' && !navigator.onLine);
    const delay = slow ? 60_000 : Math.min(500 * 2 ** Math.min(this.failures - 1, 10), 8_000);
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

  private scheduleIdleClose(): void {
    if (this.idleCloseTimer || this.disposed) return;
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      if (this.disposed || this.subscribers.size > 0) return;
      this.generation += 1;
      this.opening = null;
      this.closeSocket();
    }, IDLE_SOCKET_GRACE_MS);
  }

  private cancelIdleClose(): void {
    if (!this.idleCloseTimer) return;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;
  }

  private startKeepalive(): void { this.stopKeepalive(); this.keepaliveTimer = setInterval(() => this.send({ t: 'ping', v: 3 }), 45_000); }
  private stopKeepalive(): void { if (this.keepaliveTimer) clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  private cancelReconnect(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.wakeCleanup?.(); this.wakeCleanup = null; }
  private closeSocket(): void { this.stopKeepalive(); const socket = this.socket; this.socket = null; if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) socket.close(); }
}

let transport = new TerminalTransport();

export async function createTerminalSession(options: CreateTerminalOptions): Promise<TerminalSession> {
  const response = await runtimeFetch('/api/terminal/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
  if (!response.ok) throw await responseError(response, 'Failed to create terminal session');
  const payload: unknown = await response.json().catch(() => null);
  const parsed = terminalSessionSchema.safeParse(payload).data;
  if (!parsed) throw new Error('Failed to create terminal session');
  return parsed;
}
export async function listTerminalSessions(cwd: string): Promise<TerminalServerSession[]> {
  const response = await runtimeFetch(`/api/terminal/sessions?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) throw await responseError(response, 'Failed to list terminal sessions');
  const payload: unknown = await response.json().catch(() => null);
  const rawSessions = terminalSessionListSchema.safeParse(payload).data?.sessions;
  if (!Array.isArray(rawSessions)) throw new Error('Failed to list terminal sessions');
  const parsed: TerminalServerSession[] = [];
  for (const entry of rawSessions) {
    const session = terminalServerSessionSchema.safeParse(entry).data;
    if (session) {
      parsed.push(session);
    }
  }
  return parsed;
}
export async function touchTerminalSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await command('/api/terminal/touch', 'POST', { sessionIds });
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
