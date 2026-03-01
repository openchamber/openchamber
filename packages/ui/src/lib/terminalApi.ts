

import { buildRuntimeApiHeaders, resolveRuntimeApiBaseUrl, resolveRuntimeApiEndpoint } from '@/lib/instances/runtimeApiBaseUrl';
import { resolveSelectedInstance } from '@/stores/useInstancesStore';
import { getAccessToken } from '@/lib/auth/tokenStorage';

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  capabilities?: {
    input?: TerminalInputCapability;
  };
}

export interface TerminalInputCapability {
  preferred?: 'ws' | 'http';
  transports?: Array<'ws' | 'http'>;
  ws?: {
    path: string;
    v?: number;
    enc?: string;
  };
}

export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;
}

export interface CreateTerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface ConnectStreamOptions {
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
}

type TerminalInputControlMessage = {
  t: string;
  s?: string;
  c?: string;
  f?: boolean;
  v?: number;
};

const CONTROL_TAG_JSON = 0x01;
const WS_READY_STATE_OPEN = 1;
const DEFAULT_TERMINAL_INPUT_WS_PATH = '/api/terminal/input-ws';
const WS_SEND_WAIT_MS = 1200;
const WS_RECONNECT_INITIAL_DELAY_MS = 1000;
const WS_RECONNECT_MAX_DELAY_MS = 30000;
const WS_RECONNECT_JITTER_MS = 250;
const WS_KEEPALIVE_INTERVAL_MS = 20000;
const WS_CONNECT_TIMEOUT_MS = 5000;
const GLOBAL_TERMINAL_INPUT_STATE_KEY = '__openchamberTerminalInputWsState';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const getSelectedAccessToken = (): string | null => {
  const selected = resolveSelectedInstance();
  if (!selected?.id) {
    return null;
  }
  return getAccessToken(selected.id);
};

const appendAccessTokenQuery = (rawUrl: string): string => {
  const token = getSelectedAccessToken();
  if (!token) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

const resolveRuntimeApiOrigin = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return new URL(resolveRuntimeApiBaseUrl(), window.location.href).origin;
  } catch {
    return window.location.origin;
  }
};

const normalizeWebSocketPath = (pathValue: string): string => {
  if (/^wss?:\/\//i.test(pathValue)) {
    return appendAccessTokenQuery(pathValue);
  }

  if (/^https?:\/\//i.test(pathValue)) {
    const url = new URL(pathValue);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return appendAccessTokenQuery(url.toString());
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const normalizedPath = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  const runtimeApiOrigin = resolveRuntimeApiOrigin();
  if (!runtimeApiOrigin) {
    return '';
  }

  const origin = new URL(runtimeApiOrigin);
  const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return appendAccessTokenQuery(`${protocol}//${origin.host}${normalizedPath}`);
};

const encodeControlFrame = (payload: TerminalInputControlMessage): Uint8Array => {
  const jsonBytes = textEncoder.encode(JSON.stringify(payload));
  const bytes = new Uint8Array(jsonBytes.length + 1);
  bytes[0] = CONTROL_TAG_JSON;
  bytes.set(jsonBytes, 1);
  return bytes;
};

const isWsInputSupported = (capability: TerminalInputCapability | null): boolean => {
  if (!capability) return false;
  const transports = capability.transports ?? [];
  const supportsTransport = transports.includes('ws') || capability.preferred === 'ws';
  return supportsTransport && typeof capability.ws?.path === 'string' && capability.ws.path.length > 0;
};

class TerminalInputWsManager {
  private socket: WebSocket | null = null;
  private socketUrl = '';
  private boundSessionId: string | null = null;
  private openPromise: Promise<WebSocket | null> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  configure(socketUrl: string): void {
    if (!socketUrl) return;

    if (this.socketUrl === socketUrl) {
      this.closed = false;
      if (this.isConnectedOrConnecting()) {
        return;
      }

      this.ensureConnected();
      return;
    }

    this.socketUrl = socketUrl;
    this.closed = false;
    this.resetConnection();
    this.ensureConnected();
  }

  async sendInput(sessionId: string, data: string): Promise<boolean> {
    if (!sessionId || !data || this.closed || !this.socketUrl) {
      return false;
    }

    const socket = await this.getOpenSocket(WS_SEND_WAIT_MS);
    if (!socket || socket.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }

    try {
      if (this.boundSessionId !== sessionId) {
        socket.send(encodeControlFrame({ t: 'b', s: sessionId, v: 1 }));
        this.boundSessionId = sessionId;
      }
      socket.send(data);
      return true;
    } catch {
      this.handleSocketFailure();
      return false;
    }
  }

  unbindSession(sessionId: string): void {
    if (!sessionId) return;
    if (this.boundSessionId === sessionId) {
      this.boundSessionId = null;
    }
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimeout();
    this.resetConnection();
    this.socketUrl = '';
  }

  prime(): void {
    if (this.closed || !this.socketUrl) {
      return;
    }

    if (this.isConnectedOrConnecting()) {
      return;
    }

    this.ensureConnected();
  }

  isConnectedOrConnecting(socketUrl?: string): boolean {
    if (this.closed) {
      return false;
    }

    if (socketUrl && this.socketUrl !== socketUrl) {
      return false;
    }

    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return true;
    }

    return this.openPromise !== null;
  }

  private sendControl(payload: TerminalInputControlMessage): boolean {
    if (!this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }

    try {
      this.socket.send(encodeControlFrame(payload));
      return true;
    } catch {
      this.handleSocketFailure();
      return false;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(() => {
      if (this.closed) {
        return;
      }

      this.sendControl({ t: 'p', v: 1 });
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (!this.keepaliveInterval) {
      return;
    }

    clearInterval(this.keepaliveInterval);
    this.keepaliveInterval = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.socketUrl || this.reconnectTimeout) {
      return;
    }

    const baseDelay = Math.min(
      WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      WS_RECONNECT_MAX_DELAY_MS
    );
    const jitter = Math.floor(Math.random() * WS_RECONNECT_JITTER_MS);
    const delay = baseDelay + jitter;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectAttempt += 1;
      this.ensureConnected();
    }, delay);
  }

  private clearReconnectTimeout(): void {
    if (!this.reconnectTimeout) {
      return;
    }

    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private async getOpenSocket(waitMs: number): Promise<WebSocket | null> {
    if (this.socket && this.socket.readyState === WS_READY_STATE_OPEN) {
      return this.socket;
    }

    this.ensureConnected();

    if (this.socket && this.socket.readyState === WS_READY_STATE_OPEN) {
      return this.socket;
    }

    const opened = await Promise.race([
      this.openPromise ?? Promise.resolve(null),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), waitMs);
      }),
    ]);

    if (opened && opened.readyState === WS_READY_STATE_OPEN) {
      return opened;
    }

    if (this.socket && this.socket.readyState === WS_READY_STATE_OPEN) {
      return this.socket;
    }

    return null;
  }

  private ensureConnected(): void {
    if (this.closed || !this.socketUrl) {
      return;
    }

    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.openPromise) {
      return;
    }

    this.clearReconnectTimeout();

    this.openPromise = new Promise<WebSocket | null>((resolve) => {
      let settled = false;
      let connectTimeout: ReturnType<typeof setTimeout> | null = null;

      const settle = (value: WebSocket | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = null;
        }
        this.openPromise = null;
        resolve(value);
      };

      try {
        const socket = new WebSocket(this.socketUrl);
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          this.socket = socket;
          this.reconnectAttempt = 0;
          this.startKeepalive();
          settle(socket);
        };

        socket.onmessage = (event) => {
          void this.handleSocketMessage(event.data);
        };

        socket.onclose = () => {
          if (this.socket === socket) {
            this.socket = null;
            this.boundSessionId = null;
            this.stopKeepalive();
            if (!this.closed) {
              this.scheduleReconnect();
            }
          }
          settle(null);
        };

        this.socket = socket;

        connectTimeout = setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.close();
            settle(null);
          }
        }, WS_CONNECT_TIMEOUT_MS);
      } catch {
        settle(null);
        if (!this.closed) {
          this.scheduleReconnect();
        }
      }
    });
  }

  private async handleSocketMessage(messageData: unknown): Promise<void> {
    const bytes = await this.asUint8Array(messageData);
    if (!bytes || bytes.length < 2) {
      return;
    }

    if (bytes[0] !== CONTROL_TAG_JSON) {
      return;
    }

    try {
      const payload = JSON.parse(textDecoder.decode(bytes.subarray(1))) as TerminalInputControlMessage;
      if (payload.t === 'po') {
        return;
      }

      if (payload.t === 'e') {
        if (payload.c === 'NOT_BOUND' || payload.c === 'SESSION_NOT_FOUND') {
          this.boundSessionId = null;
        }
        if (payload.f === true) {
          this.handleSocketFailure();
        }
      }
    } catch {
      this.handleSocketFailure();
    }
  }

  private async asUint8Array(messageData: unknown): Promise<Uint8Array | null> {
    if (messageData instanceof ArrayBuffer) {
      return new Uint8Array(messageData);
    }

    if (messageData instanceof Uint8Array) {
      return messageData;
    }

    if (typeof Blob !== 'undefined' && messageData instanceof Blob) {
      const buffer = await messageData.arrayBuffer();
      return new Uint8Array(buffer);
    }

    return null;
  }

  private handleSocketFailure(): void {
    this.boundSessionId = null;
    this.resetConnection();
    this.scheduleReconnect();
  }

  private resetConnection(): void {
    this.openPromise = null;
    this.stopKeepalive();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    this.boundSessionId = null;
  }
}

type TerminalInputWsGlobalState = {
  capability: TerminalInputCapability | null;
  manager: TerminalInputWsManager | null;
};

const getTerminalInputWsGlobalState = (): TerminalInputWsGlobalState => {
  const globalScope = globalThis as typeof globalThis & {
    [GLOBAL_TERMINAL_INPUT_STATE_KEY]?: TerminalInputWsGlobalState;
  };

  if (!globalScope[GLOBAL_TERMINAL_INPUT_STATE_KEY]) {
    globalScope[GLOBAL_TERMINAL_INPUT_STATE_KEY] = {
      capability: null,
      manager: null,
    };
  }

  return globalScope[GLOBAL_TERMINAL_INPUT_STATE_KEY];
};

const applyTerminalInputCapability = (capability: TerminalInputCapability | undefined): void => {
  const globalState = getTerminalInputWsGlobalState();
  globalState.capability = capability ?? null;

  if (!isWsInputSupported(globalState.capability)) {
    globalState.manager?.close();
    globalState.manager = null;
    return;
  }

  const wsPath = globalState.capability?.ws?.path;
  if (!wsPath) {
    return;
  }

  const socketUrl = normalizeWebSocketPath(wsPath);
  if (!socketUrl) {
    return;
  }

  if (!globalState.manager) {
    globalState.manager = new TerminalInputWsManager();
  }

  globalState.manager.configure(socketUrl);
};

const sendTerminalInputHttp = async (sessionId: string, data: string): Promise<void> => {
  const response = await fetch(resolveRuntimeApiEndpoint(`/terminal/${sessionId}/input`), {
    method: 'POST',
    headers: buildRuntimeApiHeaders({
      'Content-Type': 'text/plain',
    }),
    body: data,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to send input' }));
    throw new Error(error.error || 'Failed to send terminal input');
  }
};

export async function createTerminalSession(
  options: CreateTerminalOptions
): Promise<TerminalSession> {
  const response = await fetch(resolveRuntimeApiEndpoint('/terminal/create'), {
    method: 'POST',
    headers: buildRuntimeApiHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      cwd: options.cwd,
      cols: options.cols || 80,
      rows: options.rows || 24,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create terminal' }));
    throw new Error(error.error || 'Failed to create terminal session');
  }

  const session = await response.json() as TerminalSession;
  applyTerminalInputCapability(session.capabilities?.input);
  return session;
}

export function connectTerminalStream(
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {}
): () => void {
  const {
    maxRetries = 3,
    initialRetryDelay = 1000,
    maxRetryDelay = 8000,
    connectionTimeout = 10000,
  } = options;

  let eventSource: EventSource | null = null;
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;
  let hasDispatchedOpen = false;
  let terminalExited = false;

  const clearTimeouts = () => {
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
  };

  const cleanup = () => {
    isClosed = true;
    clearTimeouts();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const connect = () => {
    if (isClosed || terminalExited) {
      return;
    }

    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
      console.warn('Attempted to create duplicate EventSource, skipping');
      return;
    }

    hasDispatchedOpen = false;
    eventSource = new EventSource(
      appendAccessTokenQuery(resolveRuntimeApiEndpoint(`/terminal/${sessionId}/stream`))
    );

    connectionTimeoutId = setTimeout(() => {
      if (!hasDispatchedOpen && eventSource?.readyState !== EventSource.OPEN) {
        console.error('Terminal connection timeout');
        eventSource?.close();
        handleError(new Error('Connection timeout'), false);
      }
    }, connectionTimeout);

    eventSource.onopen = () => {
      if (hasDispatchedOpen) {
        return;
      }
      hasDispatchedOpen = true;
      retryCount = 0;
      clearTimeouts();

      onEvent({ type: 'connected' });
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TerminalStreamEvent;

        if (data.type === 'exit') {
          getTerminalInputWsGlobalState().manager?.unbindSession(sessionId);
          terminalExited = true;
          cleanup();
        }

        onEvent(data);
      } catch (error) {
        console.error('Failed to parse terminal event:', error);
        onError?.(error as Error, false);
      }
    };

    eventSource.onerror = (error) => {
      console.error('Terminal stream error:', error, 'readyState:', eventSource?.readyState);
      clearTimeouts();

      const isFatalError = terminalExited || eventSource?.readyState === EventSource.CLOSED;

      eventSource?.close();
      eventSource = null;

      if (!terminalExited) {
        handleError(new Error('Terminal stream connection error'), isFatalError);
      }
    };
  };

  const handleError = (error: Error, isFatal: boolean) => {
    if (isClosed || terminalExited) {
      return;
    }

    if (retryCount < maxRetries && !isFatal) {
      retryCount++;
      const delay = Math.min(initialRetryDelay * Math.pow(2, retryCount - 1), maxRetryDelay);

      console.log(`Reconnecting to terminal stream (attempt ${retryCount}/${maxRetries}) in ${delay}ms`);

      onEvent({
        type: 'reconnecting',
        attempt: retryCount,
        maxAttempts: maxRetries,
      });

      retryTimeout = setTimeout(() => {
        if (!isClosed && !terminalExited) {
          connect();
        }
      }, delay);
    } else {

      console.error(`Terminal connection failed after ${retryCount} attempts`);
      onError?.(error, true);
      cleanup();
    }
  };

  connect();

  return cleanup;
}

export async function sendTerminalInput(
  sessionId: string,
  data: string
): Promise<void> {
  const globalState = getTerminalInputWsGlobalState();
  if (globalState.manager && await globalState.manager.sendInput(sessionId, data)) {
    return;
  }

  await sendTerminalInputHttp(sessionId, data);
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  const response = await fetch(resolveRuntimeApiEndpoint(`/terminal/${sessionId}/resize`), {
    method: 'POST',
    headers: buildRuntimeApiHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }
}

export async function closeTerminal(sessionId: string): Promise<void> {
  getTerminalInputWsGlobalState().manager?.unbindSession(sessionId);

  const response = await fetch(resolveRuntimeApiEndpoint(`/terminal/${sessionId}`), {
    method: 'DELETE',
    headers: buildRuntimeApiHeaders(),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to close terminal' }));
    throw new Error(error.error || 'Failed to close terminal');
  }
}

export async function restartTerminalSession(
  currentSessionId: string,
  options: { cwd: string; cols?: number; rows?: number }
): Promise<TerminalSession> {
  getTerminalInputWsGlobalState().manager?.unbindSession(currentSessionId);

  const response = await fetch(resolveRuntimeApiEndpoint(`/terminal/${currentSessionId}/restart`), {
    method: 'POST',
    headers: buildRuntimeApiHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to restart terminal' }));
    throw new Error(error.error || 'Failed to restart terminal');
  }

  const session = await response.json() as TerminalSession;
  applyTerminalInputCapability(session.capabilities?.input);
  return session;
}

export async function forceKillTerminal(options: {
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  const response = await fetch(resolveRuntimeApiEndpoint('/terminal/force-kill'), {
    method: 'POST',
    headers: buildRuntimeApiHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to force kill terminal' }));
    throw new Error(error.error || 'Failed to force kill terminal');
  }

  if (options.sessionId) {
    getTerminalInputWsGlobalState().manager?.unbindSession(options.sessionId);
  }
}

export function disposeTerminalInputTransport(): void {
  const globalState = getTerminalInputWsGlobalState();
  globalState.manager?.close();
  globalState.manager = null;
  globalState.capability = null;
}

export function primeTerminalInputTransport(): void {
  const globalState = getTerminalInputWsGlobalState();
  if (globalState.capability && !isWsInputSupported(globalState.capability)) {
    return;
  }

  const wsPath = globalState.capability?.ws?.path ?? DEFAULT_TERMINAL_INPUT_WS_PATH;
  const socketUrl = normalizeWebSocketPath(wsPath);
  if (!socketUrl) {
    return;
  }

  if (!globalState.manager) {
    globalState.manager = new TerminalInputWsManager();
  }

  if (globalState.manager.isConnectedOrConnecting(socketUrl)) {
    return;
  }

  globalState.manager.configure(socketUrl);
  globalState.manager.prime();
}

const hotModule = (import.meta as ImportMeta & {
  hot?: {
    dispose: (callback: () => void) => void;
  };
}).hot;

if (hotModule) {
  hotModule.dispose(() => {
    disposeTerminalInputTransport();
  });
}
