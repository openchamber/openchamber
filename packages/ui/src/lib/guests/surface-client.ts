import { isServerOffline } from '@/lib/server-offline';
import type { SurfaceHostMessage, SurfaceViewerMessage } from '@openchamber/sdk/schemas';
import { surfaceHostMessageSchema } from '@openchamber/sdk/schemas';
import type { SurfaceController, SurfaceInputEvent } from '@openchamber/sdk';

import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

export type SurfaceFrame = {
  seq: number;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
  bytes: ArrayBuffer;
  title?: string;
  agentActive: boolean;
};

export type SurfaceControlState = { controller: SurfaceController; mine: boolean };

export type SurfaceConnectionState =
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'ended'; reason: 'service-stopped' | 'extension-unavailable' | 'host-shutdown' };

export type SurfaceClientHandlers = {
  onFrame: (frame: SurfaceFrame) => void;
  onControl: (state: SurfaceControlState) => void;
  onConnection: (state: SurfaceConnectionState) => void;
  onResized?: (size: { width: number; height: number }) => void;
  onClipboard?: (id: string, text: string) => void;
  onError?: (code: string, message: string) => void;
  onViewer?: (viewerId: string) => void;
};

type SurfaceClientDependencies = {
  refreshAuth: () => Promise<string>;
  clearUrlAuthToken: () => void;
  openSocket: (guestId: string) => RelayTunnelWebSocket;
  isPaused: () => boolean;
  onWake: (wake: () => void) => () => void;
};

const SOCKET_OPEN = 1;
const MAX_BACKOFF_MS = 8_000;
const SLOW_BACKOFF_MS = 60_000;

const defaultDependencies: SurfaceClientDependencies = {
  refreshAuth: refreshRuntimeUrlAuthToken,
  clearUrlAuthToken: clearRuntimeUrlAuthToken,
  openSocket: (guestId) => openRuntimeWebSocket(getRuntimeUrlResolver().websocket(`/api/guests/${guestId}/surface/ws`)),
  isPaused: () => document.visibilityState === 'hidden' || isServerOffline(),
  onWake: (wake) => {
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  },
};

export class SurfaceClient {
  private socket: RelayTunnelWebSocket | null = null;
  private pendingFrame: Omit<SurfaceFrame, 'bytes'> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeCleanup: (() => void) | null = null;
  private failures = 0;
  private generation = 0;
  private disposed = false;
  private ended = false;

  constructor(
    private readonly guestId: string,
    private readonly handlers: SurfaceClientHandlers,
    private readonly dependencies: SurfaceClientDependencies = defaultDependencies,
  ) {}

  start(): void {
    this.handlers.onConnection({ status: 'connecting' });
    void this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
  }

  ack(seq: number): void {
    this.send({ type: 'ack', seq });
  }

  sendInput(events: SurfaceInputEvent[]): boolean {
    if (events.length === 0) return false;
    return this.send({ type: 'input', events });
  }

  release(): void {
    this.send({ type: 'release' });
  }

  resize(width: number, height: number): void {
    this.send({ type: 'resize', width, height });
  }

  requestClipboard(id: string): void {
    this.send({ type: 'clipboard-read', id });
  }

  private send(message: SurfaceViewerMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.ended) return;
    const generation = this.generation;
    try {
      await this.dependencies.refreshAuth();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.disposed) return;

    let socket: RelayTunnelWebSocket;
    try {
      socket = this.dependencies.openSocket(this.guestId);
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.failures = 0;
      this.pendingFrame = null;
      this.handlers.onConnection({ status: 'open' });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      // `onclose` follows and decides what to do.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.pendingFrame = null;
      if (this.disposed || this.ended) return;
      if (!opened) this.dependencies.clearUrlAuthToken();
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      const meta = this.pendingFrame;
      this.pendingFrame = null;
      if (!meta) return;
      this.handlers.onFrame({ ...meta, bytes: data });
      return;
    }
    let message: SurfaceHostMessage;
    try {
      const parsed = surfaceHostMessageSchema.safeParse(JSON.parse(data));
      if (!parsed.success) return;
      message = parsed.data;
    } catch {
      return;
    }
    switch (message.type) {
      case 'hello':
        this.handlers.onViewer?.(message.viewerId);
        return;
      case 'frame':
        this.pendingFrame = {
          seq: message.seq,
          width: message.width,
          height: message.height,
          mime: message.mime,
          agentActive: message.agentActive,
        };
        if (message.title) this.pendingFrame.title = message.title;
        return;
      case 'control':
        this.handlers.onControl({ controller: message.controller, mine: message.mine });
        return;
      case 'resized':
        this.handlers.onResized?.({ width: message.width, height: message.height });
        return;
      case 'clipboard':
        this.handlers.onClipboard?.(message.id, message.text);
        return;
      case 'error':
        this.handlers.onError?.(message.code, message.message);
        return;
      case 'ended':
        this.ended = true;
        this.cancelReconnect();
        this.handlers.onConnection({ status: 'ended', reason: message.reason });
        return;
    }
  }

  retry(): void {
    if (this.disposed) return;
    this.ended = false;
    this.failures = 0;
    this.handlers.onConnection({ status: 'connecting' });
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || this.ended) return;
    this.failures += 1;
    const delay = this.dependencies.isPaused() ? SLOW_BACKOFF_MS : Math.min(500 * 2 ** Math.min(this.failures - 1, 10), MAX_BACKOFF_MS);
    this.handlers.onConnection({ status: 'reconnecting', attempt: this.failures });
    const wake = () => {
      if (this.dependencies.isPaused()) return;
      this.cancelReconnect();
      void this.connect();
    };
    this.wakeCleanup = this.dependencies.onWake(wake);
    this.reconnectTimer = setTimeout(wake, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.wakeCleanup?.();
    this.wakeCleanup = null;
  }
}
