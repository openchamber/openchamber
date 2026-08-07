import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';

export type BrowserViewportPreset = 'desktop' | 'laptop' | 'tablet' | 'mobile' | 'custom';

export type BrowserViewport = {
  preset: BrowserViewportPreset;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
};

export type BrowserCursor = { x: number; y: number; visible: boolean };

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  viewport: BrowserViewport;
  cursor: BrowserCursor;
  createdAt: number;
};

export type BrowserRecording = { tabId: string; active: boolean; startedAt: number; frameCount: number } | null;

export type BrowserState = {
  supported: boolean;
  running: boolean;
  activeTabId: string | null;
  tabs: BrowserTab[];
  recording: BrowserRecording;
};

export type BrowserArtifact = {
  id: string;
  kind: 'screenshot' | 'recording';
  bytes: number;
  createdAt: number;
  tabId?: string;
  url?: string;
  frameCount?: number;
  durationMs?: number;
};

export type BrowserAction =
  | 'tab.create'
  | 'tab.close'
  | 'tab.select'
  | 'navigate'
  | 'click'
  | 'move'
  | 'scroll'
  | 'type'
  | 'key'
  | 'evaluate'
  | 'wait'
  | 'viewport'
  | 'screenshot'
  | 'recording.start'
  | 'recording.stop';

const ACTION_PATHS: Record<BrowserAction, string> = {
  'tab.create': '/api/browser/tab/create',
  'tab.close': '/api/browser/tab/close',
  'tab.select': '/api/browser/tab/select',
  navigate: '/api/browser/navigate',
  click: '/api/browser/click',
  move: '/api/browser/move',
  scroll: '/api/browser/scroll',
  type: '/api/browser/type',
  key: '/api/browser/key',
  evaluate: '/api/browser/evaluate',
  wait: '/api/browser/wait',
  viewport: '/api/browser/viewport',
  screenshot: '/api/browser/screenshot',
  'recording.start': '/api/browser/recording/start',
  'recording.stop': '/api/browser/recording/stop',
};

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
};

export const fetchBrowserState = async (): Promise<BrowserState> => {
  const response = await runtimeFetch('/api/browser/state');
  if (!response.ok) throw await responseError(response, 'Failed to load browser state');
  return response.json() as Promise<BrowserState>;
};

export const runBrowserAction = async <T = unknown>(action: BrowserAction, params: Record<string, unknown> = {}): Promise<T> => {
  const response = await runtimeFetch(ACTION_PATHS[action], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw await responseError(response, `Failed to run ${action}`);
  return response.json() as Promise<T>;
};

export const fetchBrowserArtifacts = async (): Promise<BrowserArtifact[]> => {
  const response = await runtimeFetch('/api/browser/artifacts');
  if (!response.ok) throw await responseError(response, 'Failed to list browser artifacts');
  const payload = (await response.json().catch(() => null)) as { artifacts?: BrowserArtifact[] } | null;
  return Array.isArray(payload?.artifacts) ? payload.artifacts : [];
};

// Small authenticated assets: fetch with the bearer token and hand back an
// object URL. Callers own revocation.
export const fetchBrowserArtifactObjectUrl = async (id: string): Promise<string> => {
  const response = await runtimeFetch(`/api/browser/artifacts/${encodeURIComponent(id)}`);
  if (!response.ok) throw await responseError(response, 'Failed to load browser artifact');
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

export type BrowserSocketMessage = Record<string, unknown> & { t: string };

const TAG = 1;
const SOCKET_OPEN = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (message: BrowserSocketMessage): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TAG;
  frame.set(payload, 1);
  return frame;
};

const decode = async (data: unknown): Promise<BrowserSocketMessage | null> => {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data instanceof Uint8Array) bytes = data;
  else if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else if (typeof data === 'string') bytes = encoder.encode(data);
  else return null;
  if (bytes[0] === TAG) bytes = bytes.subarray(1);
  try {
    return JSON.parse(decoder.decode(bytes)) as BrowserSocketMessage;
  } catch {
    return null;
  }
};

type BrowserSocketHandlers = {
  onMessage: (message: BrowserSocketMessage) => void;
  onStatus: (status: 'connecting' | 'open' | 'closed') => void;
};

// Single shared browser control/preview socket. Unlike the terminal there is
// one global browser, so there is exactly one connection and no per-session
// projection. Reconnect uses exponential backoff that respects hidden/offline.
export class BrowserSocket {
  private socket: RelayTunnelWebSocket | null = null;
  private opening: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private wakeCleanup: (() => void) | null = null;
  private failures = 0;
  private generation = 0;
  private disposed = false;
  private handlers: BrowserSocketHandlers | null = null;
  private watching: string | null = null;

  constructor(
    private readonly dependencies = {
      refreshAuth: refreshRuntimeUrlAuthToken,
      openSocket: () => openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/browser/ws')),
      clearUrlAuthToken: clearRuntimeUrlAuthToken,
    },
  ) {}

  connect(handlers: BrowserSocketHandlers): void {
    this.handlers = handlers;
    this.disposed = false;
    void this.ensureConnected();
  }

  watch(tabId: string | null): void {
    this.watching = tabId;
    if (tabId) this.send({ t: 'watch', tabId });
    else this.send({ t: 'unwatch' });
  }

  sendInput(action: string, params: Record<string, unknown>): void {
    this.send({ t: 'input', action, params });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.opening = null;
    this.handlers = null;
    this.watching = null;
    this.cancelReconnect();
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private send(message: BrowserSocketMessage): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try {
      this.socket.send(encode(message));
      return true;
    } catch {
      return false;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed || this.socket?.readyState === SOCKET_OPEN) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    const opening = (async () => {
      this.handlers?.onStatus('connecting');
      await this.dependencies.refreshAuth();
      if (generation !== this.generation || this.disposed) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const socket = this.dependencies.openSocket();
          socket.binaryType = 'arraybuffer';
          this.socket = socket;
          socket.onopen = () => {
            if (generation !== this.generation || this.disposed) {
              socket.close();
              finish();
              return;
            }
            this.failures = 0;
            this.handlers?.onStatus('open');
            if (this.watching) this.send({ t: 'watch', tabId: this.watching });
            this.startKeepalive();
            finish();
          };
          socket.onmessage = (event) => void this.handleMessage(event.data);
          socket.onerror = () => {
            this.dependencies.clearUrlAuthToken?.();
            finish();
            this.handleDrop();
          };
          socket.onclose = () => {
            if (this.socket === socket) this.socket = null;
            this.stopKeepalive();
            finish();
            this.handleDrop();
          };
        } catch {
          finish();
          this.handleDrop();
        }
      });
    })();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = await decode(raw);
    if (!message || message.t === 'pong') return;
    this.handlers?.onMessage(message);
  }

  private handleDrop(): void {
    if (this.disposed) return;
    this.handlers?.onStatus('closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    this.failures += 1;
    const slow = (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      || (typeof navigator !== 'undefined' && !navigator.onLine);
    const delay = slow ? 60_000 : Math.min(500 * 2 ** Math.min(this.failures - 1, 10), 8_000);
    const wake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      this.cancelReconnect();
      void this.ensureConnected();
    };
    if (typeof window !== 'undefined') window.addEventListener('online', wake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
    this.wakeCleanup = () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', wake);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
    };
    this.reconnectTimer = setTimeout(wake, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.wakeCleanup?.();
    this.wakeCleanup = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => this.send({ t: 'ping' }), 20_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}
