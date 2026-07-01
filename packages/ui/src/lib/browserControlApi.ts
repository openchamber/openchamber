import { getRuntimeUrlResolver } from './runtime-url';
import type {
  BrowserControlAPI,
  BrowserControllerHandle,
  BrowserControllerInfo,
  BrowserExecResult,
  BrowserPaneMeta,
  RegisterControllerOptions,
} from './api/types';

const BROWSER_WS_PATH = '/api/browser/ws';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
// When the tab is offline or backgrounded, back off hard instead of probing every
// few seconds — recovery comes from the `online`/visibility listeners below, not
// from the next timer (mirrors the SSE reconnect-pacing rule in event-pipeline).
const RECONNECT_IDLE_MAX_MS = 60_000;

const isIdleEnvironment = (): boolean => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
  return false;
};

interface ServerMessage {
  t: string;
  cid?: string;
  primitive?: string;
  args?: unknown;
  [key: string]: unknown;
}

/**
 * One authenticated WebSocket per controller (the server binds one controller per
 * socket). Routes server-issued primitive commands to the pane's executor and
 * sends results back, correlated by cid. Survives reconnects by re-sending hello.
 */
class BrowserControllerConnection implements BrowserControllerHandle {
  readonly ready: Promise<BrowserControllerInfo>;

  private resolveReady!: (info: BrowserControllerInfo) => void;
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readyResolved = false;
  private readonly wake = () => this.reconnectNow();

  constructor(
    private readonly opts: RegisterControllerOptions,
    private readonly onDispose: () => void,
  ) {
    this.ready = new Promise<BrowserControllerInfo>((resolve) => {
      this.resolveReady = resolve;
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('visibilitychange', this.wake);
    }
    this.connect();
  }

  /** Interrupt a pending backoff and reconnect immediately (came back online / visible). */
  private reconnectNow(): void {
    if (this.closed || !this.reconnectTimer || isIdleEnvironment()) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(getRuntimeUrlResolver().websocket(BROWSER_WS_PATH));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.sendHello();
    };
    socket.onmessage = (ev) => this.handleMessage(ev);
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const cap = isIdleEnvironment() ? RECONNECT_IDLE_MAX_MS : RECONNECT_MAX_MS;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, cap);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendHello(): void {
    this.send({
      t: 'hello',
      controllerId: this.opts.controllerId,
      backend: this.opts.backend,
      url: this.opts.getUrl?.(),
      title: this.opts.getTitle?.(),
    });
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: ServerMessage | null = null;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'hello-ok') {
      const info: BrowserControllerInfo = {
        controllerId: this.opts.controllerId,
        backend: (msg.backend as BrowserControllerInfo['backend']) ?? this.opts.backend,
        originClass: (msg.originClass as BrowserControllerInfo['originClass']) ?? 'blank',
        url: msg.url as string | undefined,
        title: msg.title as string | undefined,
        capabilities: (msg.capabilities as BrowserControllerInfo['capabilities']) ?? {},
      };
      if (!this.readyResolved) {
        this.readyResolved = true;
        this.resolveReady(info);
      }
      return;
    }

    if (msg.t === 'cmd' && typeof msg.cid === 'string' && typeof msg.primitive === 'string') {
      const cid = msg.cid;
      const primitive = msg.primitive;
      const args = msg.args;
      Promise.resolve()
        .then(() => this.opts.execute(primitive, args))
        .then((result: BrowserExecResult) => {
          if (result && result.ok) this.send({ t: 'res', cid, ok: true, value: result.value });
          else this.send({ t: 'res', cid, ok: false, code: result?.code || 'EXEC_ERROR', message: result?.message || 'Executor error' });
        })
        .catch((err: unknown) => {
          this.send({ t: 'res', cid, ok: false, code: 'EXEC_ERROR', message: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    if (msg.t === 'detach') {
      this.close();
    }
  }

  notifyNavigated(meta: BrowserPaneMeta): void {
    this.send({ t: 'event', controllerId: this.opts.controllerId, kind: 'navigated', payload: meta });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('visibilitychange', this.wake);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.send({ t: 'bye', controllerId: this.opts.controllerId });
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.onDispose();
  }
}

/** Create the renderer-side BrowserControlAPI backed by per-controller sockets. */
export const createBrowserControlClient = (): BrowserControlAPI => {
  const controllers = new Map<string, BrowserControllerConnection>();

  return {
    registerController(opts: RegisterControllerOptions): BrowserControllerHandle {
      const existing = controllers.get(opts.controllerId);
      if (existing) existing.close();
      const conn = new BrowserControllerConnection(opts, () => {
        if (controllers.get(opts.controllerId) === conn) controllers.delete(opts.controllerId);
      });
      controllers.set(opts.controllerId, conn);
      return conn;
    },
  };
};
