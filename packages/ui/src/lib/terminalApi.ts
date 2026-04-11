export interface TerminalWebSocketDescriptor {
  path: string;
  v?: number;
  enc?: string;
}

export interface TerminalTransportCapability {
  preferred?: 'ws' | 'http' | 'sse';
  transports?: Array<'ws' | 'http' | 'sse'>;
  ws?: TerminalWebSocketDescriptor;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  capabilities?: {
    input?: TerminalTransportCapability;
    stream?: TerminalTransportCapability;
  };
}

export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;
  runtime?: 'node' | 'bun';
  ptyBackend?: string;
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

type TerminalControlMessage = {
  t: string;
  s?: string;
  c?: string;
  f?: boolean;
  v?: number;
  exitCode?: number;
  signal?: number | null;
  runtime?: 'node' | 'bun';
  ptyBackend?: string;
};

type StreamSubscription = {
  token: symbol;
  sessionId: string;
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  connectionTimeout: number;
  retryCount: number;
  connected: boolean;
  connectionTimeoutId: ReturnType<typeof setTimeout> | null;
};

const CONTROL_TAG_JSON = 0x01;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CONNECTING = 0;
const DEFAULT_TERMINAL_WS_PATH = '/api/terminal/ws';
const WS_SEND_WAIT_MS = 1200;
const WS_RECONNECT_INITIAL_DELAY_MS = 1000;
const WS_RECONNECT_MAX_DELAY_MS = 30000;
const WS_RECONNECT_JITTER_MS = 250;
const WS_KEEPALIVE_INTERVAL_MS = 20000;
const WS_CONNECT_TIMEOUT_MS = 5000;
const GLOBAL_TERMINAL_TRANSPORT_STATE_KEY = '__openchamberTerminalTransportState';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const normalizeWebSocketPath = (pathValue: string): string => {
  if (/^wss?:\/\//i.test(pathValue)) {
    return pathValue;
  }

  if (/^https?:\/\//i.test(pathValue)) {
    const url = new URL(pathValue);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const normalizedPath = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${normalizedPath}`;
};

const encodeControlFrame = (payload: TerminalControlMessage): Uint8Array => {
  const jsonBytes = textEncoder.encode(JSON.stringify(payload));
  const bytes = new Uint8Array(jsonBytes.length + 1);
  bytes[0] = CONTROL_TAG_JSON;
  bytes.set(jsonBytes, 1);
  return bytes;
};

const isWsTransportSupported = (capability: TerminalTransportCapability | null | undefined): boolean => {
  if (!capability) return false;
  const transports = capability.transports ?? [];
  const supportsTransport = transports.includes('ws') || capability.preferred === 'ws';
  return supportsTransport && typeof capability.ws?.path === 'string' && capability.ws.path.length > 0;
};

const getPreferredTerminalWsPath = (state: TerminalTransportGlobalState): string => (
  state.streamCapability?.ws?.path
  ?? state.inputCapability?.ws?.path
  ?? DEFAULT_TERMINAL_WS_PATH
);

const createTransportError = (code: string | undefined): Error => {
  switch (code) {
    case 'SESSION_NOT_FOUND':
      return new Error('Terminal session not found');
    case 'NOT_BOUND':
      return new Error('Terminal session is not bound');
    case 'WRITE_FAIL':
      return new Error('Failed to write to terminal');
    case 'RATE_LIMIT':
      return new Error('Terminal websocket is rate limited');
    case 'BAD_FRAME':
      return new Error('Terminal websocket protocol violation');
    default:
      return new Error('Terminal websocket error');
  }
};

class TerminalTransportManager {
  private socket: WebSocket | null = null;
  private socketUrl = '';
  private boundSessionId: string | null = null;
  private requestedSessionId: string | null = null;
  private openPromise: Promise<WebSocket | null> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private subscriptions = new Map<symbol, StreamSubscription>();
  private activeSubscriptionToken: symbol | null = null;

  configure(socketUrl: string): void {
    if (!socketUrl) {
      return;
    }

    if (this.socketUrl === socketUrl) {
      this.closed = false;
      if (!this.isConnectedOrConnecting()) {
        this.ensureConnected();
      }
      return;
    }

    this.socketUrl = socketUrl;
    this.closed = false;
    this.resetConnection();
    this.ensureConnected();
  }

  subscribe(
    sessionId: string,
    onEvent: (event: TerminalStreamEvent) => void,
    onError?: (error: Error, fatal?: boolean) => void,
    options?: ConnectStreamOptions
  ): () => void {
    const token = Symbol(sessionId);
    const subscription: StreamSubscription = {
      token,
      sessionId,
      onEvent,
      onError,
      maxRetries: options?.maxRetries ?? 3,
      initialRetryDelay: options?.initialRetryDelay ?? 1000,
      maxRetryDelay: options?.maxRetryDelay ?? 8000,
      connectionTimeout: options?.connectionTimeout ?? 10000,
      retryCount: 0,
      connected: false,
      connectionTimeoutId: null,
    };

    this.subscriptions.set(token, subscription);
    this.activeSubscriptionToken = token;
    this.boundSessionId = null;
    this.requestedSessionId = sessionId;
    this.ensureConnected();
    this.startConnectionTimeout(subscription);
    this.bindActiveSession();

    return () => {
      this.clearConnectionTimeout(subscription);
      this.subscriptions.delete(token);
      if (this.activeSubscriptionToken === token) {
        this.activeSubscriptionToken = null;
      }
      if (this.boundSessionId === sessionId) {
        this.boundSessionId = null;
      }
      if (this.requestedSessionId === sessionId) {
        this.requestedSessionId = null;
      }
    };
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
        this.requestedSessionId = sessionId;
        socket.send(encodeControlFrame({ t: 'b', s: sessionId, v: 2 }));
      }
      socket.send(data);
      return true;
    } catch {
      this.handleSocketFailure(new Error('Terminal websocket send failed'));
      return false;
    }
  }

  unbindSession(sessionId: string): void {
    if (!sessionId) {
      return;
    }
    if (this.boundSessionId === sessionId) {
      this.boundSessionId = null;
    }
    if (this.requestedSessionId === sessionId) {
      this.requestedSessionId = null;
    }
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimeout();
    for (const subscription of this.subscriptions.values()) {
      this.clearConnectionTimeout(subscription);
    }
    this.resetConnection();
    this.socketUrl = '';
    this.subscriptions.clear();
    this.activeSubscriptionToken = null;
  }

  prime(): void {
    if (this.closed || !this.socketUrl || this.isConnectedOrConnecting()) {
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

    if (this.socket && (this.socket.readyState === WS_READY_STATE_OPEN || this.socket.readyState === WS_READY_STATE_CONNECTING)) {
      return true;
    }

    return this.openPromise !== null;
  }

  private getActiveSubscription(): StreamSubscription | null {
    if (!this.activeSubscriptionToken) {
      return null;
    }

    return this.subscriptions.get(this.activeSubscriptionToken) ?? null;
  }

  private startConnectionTimeout(subscription: StreamSubscription): void {
    this.clearConnectionTimeout(subscription);
    subscription.connectionTimeoutId = setTimeout(() => {
      if (this.getActiveSubscription()?.token !== subscription.token || subscription.connected) {
        return;
      }

      this.handleSocketFailure(new Error('Connection timeout'));
    }, subscription.connectionTimeout);
  }

  private clearConnectionTimeout(subscription: StreamSubscription): void {
    if (!subscription.connectionTimeoutId) {
      return;
    }

    clearTimeout(subscription.connectionTimeoutId);
    subscription.connectionTimeoutId = null;
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

    if (this.socket && (this.socket.readyState === WS_READY_STATE_OPEN || this.socket.readyState === WS_READY_STATE_CONNECTING)) {
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
          this.startKeepalive();
          settle(socket);
        };

        socket.onmessage = (event) => {
          void this.handleSocketMessage(event.data);
        };

        socket.onerror = () => {
          if (!this.closed && !this.getActiveSubscription()) {
            this.scheduleReconnect(new Error('Terminal websocket error'));
          }
        };

        socket.onclose = () => {
          if (this.socket === socket) {
            this.socket = null;
            this.boundSessionId = null;
            this.stopKeepalive();
            if (!this.closed) {
              this.scheduleReconnect(new Error('Terminal stream connection error'));
            }
          }
          settle(null);
        };

        this.socket = socket;

        connectTimeout = setTimeout(() => {
          if (socket.readyState === WS_READY_STATE_CONNECTING) {
            socket.close();
            settle(null);
          }
        }, WS_CONNECT_TIMEOUT_MS);
      } catch {
        settle(null);
        if (!this.closed) {
          this.scheduleReconnect(new Error('Terminal websocket open failed'));
        }
      }
    });
  }

  private bindActiveSession(): void {
    const activeSubscription = this.getActiveSubscription();
    if (!activeSubscription || !this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
      return;
    }

    this.requestedSessionId = activeSubscription.sessionId;

    try {
      this.socket.send(encodeControlFrame({ t: 'b', s: activeSubscription.sessionId, v: 2 }));
    } catch {
      this.handleSocketFailure(new Error('Terminal websocket bind failed'));
    }
  }

  private scheduleReconnect(error: Error): void {
    if (this.closed || !this.socketUrl || this.reconnectTimeout) {
      return;
    }

    const activeSubscription = this.getActiveSubscription();
    const attempt = (activeSubscription?.retryCount ?? 0) + 1;
    const initialDelay = activeSubscription?.initialRetryDelay ?? WS_RECONNECT_INITIAL_DELAY_MS;
    const maxDelay = activeSubscription?.maxRetryDelay ?? WS_RECONNECT_MAX_DELAY_MS;
    const maxRetries = activeSubscription?.maxRetries ?? Number.POSITIVE_INFINITY;

    if (activeSubscription) {
      if (attempt > maxRetries) {
        this.clearConnectionTimeout(activeSubscription);
        activeSubscription.onError?.(error, true);
        return;
      }

      activeSubscription.retryCount = attempt;
      activeSubscription.connected = false;
      activeSubscription.onEvent({
        type: 'reconnecting',
        attempt,
        maxAttempts: maxRetries,
      });
      this.startConnectionTimeout(activeSubscription);
    }

    const baseDelay = Math.min(initialDelay * Math.pow(2, Math.max(attempt - 1, 0)), maxDelay);
    const jitter = Math.floor(Math.random() * WS_RECONNECT_JITTER_MS);
    const delay = baseDelay + jitter;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.ensureConnected();
      this.bindActiveSession();
    }, delay);
  }

  private clearReconnectTimeout(): void {
    if (!this.reconnectTimeout) {
      return;
    }

    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private sendControl(payload: TerminalControlMessage): boolean {
    if (!this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }

    try {
      this.socket.send(encodeControlFrame(payload));
      return true;
    } catch {
      this.handleSocketFailure(new Error('Terminal websocket control send failed'));
      return false;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(() => {
      if (this.closed) {
        return;
      }

      this.sendControl({ t: 'p', v: 2 });
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (!this.keepaliveInterval) {
      return;
    }

    clearInterval(this.keepaliveInterval);
    this.keepaliveInterval = null;
  }

  private async handleSocketMessage(messageData: unknown): Promise<void> {
    const bytes = await this.asUint8Array(messageData);
    if (bytes && bytes.length > 0 && bytes[0] === CONTROL_TAG_JSON) {
      this.handleControlMessage(bytes);
      return;
    }

    const text = await this.asText(messageData);
    if (!text) {
      return;
    }

    const activeSubscription = this.getActiveSubscription();
    if (!activeSubscription) {
      return;
    }

    activeSubscription.onEvent({ type: 'data', data: text });
  }

  private handleControlMessage(bytes: Uint8Array): void {
    if (bytes.length < 2) {
      return;
    }

    let payload: TerminalControlMessage;
    try {
      payload = JSON.parse(textDecoder.decode(bytes.subarray(1))) as TerminalControlMessage;
    } catch {
      this.handleSocketFailure(new Error('Terminal websocket control parse failed'));
      return;
    }

    const activeSubscription = this.getActiveSubscription();

    switch (payload.t) {
      case 'ok':
        this.bindActiveSession();
        return;
      case 'po':
        return;
      case 'bok': {
        this.boundSessionId = payload.s ?? this.requestedSessionId;
        if (!activeSubscription) {
          return;
        }
        activeSubscription.retryCount = 0;
        activeSubscription.connected = true;
        this.clearConnectionTimeout(activeSubscription);
        activeSubscription.onEvent({
          type: 'connected',
          runtime: payload.runtime,
          ptyBackend: payload.ptyBackend,
        });
        return;
      }
      case 'x': {
        if (!activeSubscription) {
          this.boundSessionId = null;
          return;
        }

        if (payload.s && payload.s !== activeSubscription.sessionId) {
          return;
        }

        activeSubscription.connected = false;
        this.clearConnectionTimeout(activeSubscription);
        this.boundSessionId = null;
        this.requestedSessionId = null;
        activeSubscription.onEvent({
          type: 'exit',
          exitCode: payload.exitCode,
          signal: payload.signal ?? null,
        });
        return;
      }
      case 'e': {
        const error = createTransportError(payload.c);
        const isFatal = payload.f === true || payload.c === 'SESSION_NOT_FOUND';

        if (payload.c === 'NOT_BOUND' || payload.c === 'SESSION_NOT_FOUND') {
          this.boundSessionId = null;
        }

        if (activeSubscription) {
          activeSubscription.connected = false;
          if (isFatal) {
            this.clearConnectionTimeout(activeSubscription);
          }
          activeSubscription.onError?.(error, isFatal);
        }

        if (payload.f === true) {
          this.handleSocketFailure(error);
        }
        return;
      }
      default:
        return;
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

  private async asText(messageData: unknown): Promise<string> {
    if (typeof messageData === 'string') {
      return messageData;
    }

    const bytes = await this.asUint8Array(messageData);
    if (!bytes) {
      return '';
    }

    return textDecoder.decode(bytes);
  }

  private handleSocketFailure(error: Error): void {
    this.boundSessionId = null;
    this.requestedSessionId = null;
    this.resetConnection();
    this.scheduleReconnect(error);
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
      if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CONNECTING) {
        socket.close();
      }
    }
    this.boundSessionId = null;
  }
}

type TerminalTransportGlobalState = {
  inputCapability: TerminalTransportCapability | null;
  streamCapability: TerminalTransportCapability | null;
  manager: TerminalTransportManager | null;
};

const getTerminalTransportGlobalState = (): TerminalTransportGlobalState => {
  const globalScope = globalThis as typeof globalThis & {
    [GLOBAL_TERMINAL_TRANSPORT_STATE_KEY]?: TerminalTransportGlobalState;
  };

  if (!globalScope[GLOBAL_TERMINAL_TRANSPORT_STATE_KEY]) {
    globalScope[GLOBAL_TERMINAL_TRANSPORT_STATE_KEY] = {
      inputCapability: null,
      streamCapability: null,
      manager: null,
    };
  }

  return globalScope[GLOBAL_TERMINAL_TRANSPORT_STATE_KEY];
};

const ensureTerminalTransportManager = (): TerminalTransportManager => {
  const globalState = getTerminalTransportGlobalState();
  if (!globalState.manager) {
    globalState.manager = new TerminalTransportManager();
  }
  return globalState.manager;
};

const applyTerminalTransportCapabilities = (capabilities: TerminalSession['capabilities'] | undefined): void => {
  const globalState = getTerminalTransportGlobalState();
  globalState.inputCapability = capabilities?.input ?? null;
  globalState.streamCapability = capabilities?.stream ?? null;

  if (!isWsTransportSupported(globalState.inputCapability) && !isWsTransportSupported(globalState.streamCapability)) {
    globalState.manager?.close();
    globalState.manager = null;
    return;
  }

  const socketUrl = normalizeWebSocketPath(getPreferredTerminalWsPath(globalState));
  if (!socketUrl) {
    return;
  }

  const manager = ensureTerminalTransportManager();
  manager.configure(socketUrl);
};

const sendTerminalInputHttp = async (sessionId: string, data: string): Promise<void> => {
  const response = await fetch(`/api/terminal/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: data,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to send terminal input' }));
    throw new Error(error.error || 'Failed to send terminal input');
  }
};

export async function createTerminalSession(options: CreateTerminalOptions): Promise<TerminalSession> {
  const response = await fetch('/api/terminal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create terminal' }));
    throw new Error(error.error || 'Failed to create terminal session');
  }

  const session = await response.json() as TerminalSession;
  applyTerminalTransportCapabilities(session.capabilities);
  return session;
}

const connectTerminalStreamViaSse = (
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {}
): (() => void) => {
  const maxRetries = options.maxRetries ?? 3;
  const initialRetryDelay = options.initialRetryDelay ?? 1000;
  const maxRetryDelay = options.maxRetryDelay ?? 8000;
  const connectionTimeout = options.connectionTimeout ?? 10000;

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
    if (isClosed) {
      return;
    }

    isClosed = true;
    clearTimeouts();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const handleError = (error: Error, isFatal: boolean) => {
    if (isClosed || terminalExited) {
      return;
    }

    if (retryCount < maxRetries && !isFatal) {
      retryCount += 1;
      const delay = Math.min(initialRetryDelay * Math.pow(2, retryCount - 1), maxRetryDelay);

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
      return;
    }

    onError?.(error, true);
    cleanup();
  };

  const connect = () => {
    if (isClosed || terminalExited) {
      return;
    }

    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
      return;
    }

    eventSource = new EventSource(`/api/terminal/${sessionId}/stream`);

    connectionTimeoutId = setTimeout(() => {
      if (!hasDispatchedOpen && eventSource?.readyState !== EventSource.OPEN) {
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
          getTerminalTransportGlobalState().manager?.unbindSession(sessionId);
          terminalExited = true;
          cleanup();
        }

        onEvent(data);
      } catch (error) {
        onError?.(error as Error, false);
      }
    };

    eventSource.onerror = () => {
      clearTimeouts();
      const isFatalError = terminalExited || eventSource?.readyState === EventSource.CLOSED;
      eventSource?.close();
      eventSource = null;

      if (!terminalExited) {
        handleError(new Error('Terminal stream connection error'), isFatalError);
      }
    };
  };

  connect();
  return cleanup;
};

export function connectTerminalStream(
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {}
): () => void {
  const globalState = getTerminalTransportGlobalState();
  if (!isWsTransportSupported(globalState.streamCapability)) {
    return connectTerminalStreamViaSse(sessionId, onEvent, onError, options);
  }

  const manager = ensureTerminalTransportManager();
  const socketUrl = normalizeWebSocketPath(getPreferredTerminalWsPath(globalState));
  if (!socketUrl) {
    return connectTerminalStreamViaSse(sessionId, onEvent, onError, options);
  }

  manager.configure(socketUrl);
  return manager.subscribe(sessionId, onEvent, onError, options);
}

export async function sendTerminalInput(
  sessionId: string,
  data: string
): Promise<void> {
  const globalState = getTerminalTransportGlobalState();
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
  const response = await fetch(`/api/terminal/${sessionId}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }
}

export async function closeTerminal(sessionId: string): Promise<void> {
  getTerminalTransportGlobalState().manager?.unbindSession(sessionId);

  const response = await fetch(`/api/terminal/${sessionId}`, {
    method: 'DELETE',
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
  getTerminalTransportGlobalState().manager?.unbindSession(currentSessionId);

  const response = await fetch(`/api/terminal/${currentSessionId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  applyTerminalTransportCapabilities(session.capabilities);
  return session;
}

export async function forceKillTerminal(options: {
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  const response = await fetch('/api/terminal/force-kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to force kill terminal' }));
    throw new Error(error.error || 'Failed to force kill terminal');
  }

  if (options.sessionId) {
    getTerminalTransportGlobalState().manager?.unbindSession(options.sessionId);
  }
}

export function disposeTerminalInputTransport(): void {
  const globalState = getTerminalTransportGlobalState();
  globalState.manager?.close();
  globalState.manager = null;
  globalState.inputCapability = null;
  globalState.streamCapability = null;
}

export function primeTerminalInputTransport(): void {
  const globalState = getTerminalTransportGlobalState();
  if (
    globalState.inputCapability &&
    globalState.streamCapability &&
    !isWsTransportSupported(globalState.inputCapability) &&
    !isWsTransportSupported(globalState.streamCapability)
  ) {
    return;
  }

  const preferredPath = getPreferredTerminalWsPath(globalState) || DEFAULT_TERMINAL_WS_PATH;
  const socketUrl = normalizeWebSocketPath(preferredPath);
  if (!socketUrl) {
    return;
  }

  const manager = ensureTerminalTransportManager();
  if (manager.isConnectedOrConnecting(socketUrl)) {
    return;
  }

  manager.configure(socketUrl);
  manager.prime();
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
