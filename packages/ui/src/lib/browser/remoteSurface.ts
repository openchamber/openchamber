/**
 * Client for the server-hosted browser surface gateway (/api/browser-surface).
 *
 * Wire protocol (mirrors packages/web/server/lib/browser/surface-gateway.js):
 * - server → client: `hello`, `list`, `created`, `attached`, `tabs`,
 *   `navigation`, `state`, `error`, `copyResult`,
 *   and `frame` — a JSON header ({ frameSeq, streamGen, tabId, width, height,
 *   scale }) immediately followed by one binary message with the JPEG bytes.
 * - client → server: `list` / `create` / `attach` handshakes, `attachTab`,
 *   `createTab`, `frameAck`, navigation (`navigate` | `back` | `forward` |
 *   `reload` | `stop`), selection `copy`, and input (`pointer` | `wheel` | `key` | `text`).
 *
 * Auth: the upgrade cannot carry headers, so the socket URL goes through the
 * runtime resolver, which appends the short-lived `oc_url_token`. The token is
 * minted/refreshed BEFORE the initial connect and every reconnect — the sync
 * getter returns "" inside the expiry skew window and the server would reject
 * the upgrade with 401 (same pattern as the event pipeline).
 *
 * Coordinates: the gateway and CDP speak page CSS pixels. The viewer displays
 * the frame letterboxed, so viewer pixels are converted to CSS pixels HERE —
 * client-side, in viewerPointToFrameCss — and nowhere else.
 */

import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { z } from 'zod';
import { RemoteSurfaceInspector } from './remoteSurfaceInspector';
import { RemoteSurfaceDevTools } from './remoteSurfaceDevTools';
import { RemoteSurfaceViewport } from './remoteSurfaceViewport';
import { RemoteSurfaceContextMenu, surfaceContextMenuResultSchema } from './remoteSurfaceContextMenu';
import {
  RemoteSurfaceClipboardError,
  RemoteSurfaceClipboardExchange,
  SURFACE_MESSAGE_MAX_BYTES,
  surfaceCopyResultSchema,
} from './remoteSurfaceClipboard';

const SURFACE_WS_PATH = '/api/browser-surface';
const WS_OPEN = 1;

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;
// Offline or backgrounded viewers poll slowly: the socket cannot succeed while
// the machine is offline and a hidden pane is not being watched.
const RECONNECT_IDLE_MAX_DELAY_MS = 30_000;

export interface SurfaceFrameHeader {
  frameSeq: number;
  streamGen: number;
  tabId: string;
  /** Frame width in page CSS pixels. */
  width: number;
  /** Frame height in page CSS pixels. */
  height: number;
  /** Device pixel ratio the frame was captured at; the JPEG is width×scale by height×scale pixels. */
  scale: number;
}

export interface SurfaceSessionSummary {
  id: string;
  directory: string;
  persistence?: string;
}

export interface SurfaceTab {
  id: string;
  targetId?: string;
  title?: string;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
}

const navigationSchema = z.object({
  tabId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  isLoading: z.boolean(),
});
const tabsMessageSchema = z.object({
  activeTabId: z.string().min(1).optional(),
  tabs: z.array(z.object({
    id: z.string().min(1), targetId: z.string().optional(),
    title: z.string().optional(), url: z.string().optional(),
  })),
});

export interface SurfaceLease {
  actor?: string;
  openCodeSessionId?: string;
  generation?: number;
  acquiredAt?: number;
  expiresAt?: number;
}

export type RemoteSurfacePhase =
  | 'connecting'
  | 'choosing'
  | 'attaching'
  | 'attached'
  | 'reconnecting'
  | 'ended'
  | 'error';

export interface RemoteSurfaceState {
  phase: RemoteSurfacePhase;
  sessions: SurfaceSessionSummary[];
  session: SurfaceSessionSummary | null;
  tabs: SurfaceTab[];
  /** The sc:<target> tab the viewer is attached to. */
  activeTabId: string | null;
  /** True when the session lease is held by anyone but this viewer ('Agent controlling' badge). */
  agentControlling: boolean;
  errorMessage: string | null;
}

const INITIAL_STATE: RemoteSurfaceState = {
  phase: 'connecting',
  sessions: [],
  session: null,
  tabs: [],
  activeTabId: null,
  agentControlling: false,
  errorMessage: null,
};

type ServerMessage = Record<string, unknown> & { type?: unknown };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Parses a `frame` header; null (drop) for anything malformed. */
export const parseSurfaceFrameHeader = (message: unknown): SurfaceFrameHeader | null => {
  const record = asRecord(message);
  if (!record || record.type !== 'frame') return null;
  if (!isFiniteNumber(record.frameSeq) || !isFiniteNumber(record.streamGen)) return null;
  if (!asNonEmptyString(record.tabId)) return null;
  if (!isFiniteNumber(record.width) || record.width <= 0) return null;
  if (!isFiniteNumber(record.height) || record.height <= 0) return null;
  if (!isFiniteNumber(record.scale) || record.scale <= 0) return null;
  return {
    frameSeq: record.frameSeq,
    streamGen: record.streamGen,
    tabId: record.tabId as string,
    width: record.width,
    height: record.height,
    scale: record.scale,
  };
};

const parseSessions = (value: unknown): SurfaceSessionSummary[] => {
  if (!Array.isArray(value)) return [];
  const sessions: SurfaceSessionSummary[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asNonEmptyString(record.id);
    const directory = asNonEmptyString(record.directory);
    if (!id || !directory) continue;
    sessions.push({
      id,
      directory,
      persistence: typeof record.persistence === 'string' ? record.persistence : undefined,
    });
  }
  return sessions;
};

const parseSession = (value: unknown): SurfaceSessionSummary | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNonEmptyString(record.id);
  const directory = asNonEmptyString(record.directory);
  if (!id || !directory) return null;
  return {
    id,
    directory,
    persistence: typeof record.persistence === 'string' ? record.persistence : undefined,
  };
};

const parseTabs = (value: unknown): SurfaceTab[] => {
  if (!Array.isArray(value)) return [];
  const tabs: SurfaceTab[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asNonEmptyString(record.id);
    if (!id) continue;
    tabs.push({
      id,
      targetId: typeof record.targetId === 'string' ? record.targetId : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
      url: typeof record.url === 'string' ? record.url : undefined,
    });
  }
  return tabs;
};

const parseLease = (value: unknown): SurfaceLease | null => {
  const record = asRecord(value);
  if (!record) return null;
  return {
    actor: typeof record.actor === 'string' ? record.actor : undefined,
    openCodeSessionId: typeof record.openCodeSessionId === 'string' ? record.openCodeSessionId : undefined,
    generation: isFiniteNumber(record.generation) ? record.generation : undefined,
    acquiredAt: isFiniteNumber(record.acquiredAt) ? record.acquiredAt : undefined,
    expiresAt: isFiniteNumber(record.expiresAt) ? record.expiresAt : undefined,
  };
};

// ── Geometry ────────────────────────────────────────────────────────────────

export interface SurfaceFrameGeometry {
  width: number;
  height: number;
  scale: number;
}

/** Canvas backing store: the JPEG's own device-pixel size (CSS size × capture scale). */
export const frameCanvasBackingSize = (
  frame: SurfaceFrameGeometry,
): { width: number; height: number } => ({
  width: Math.max(1, Math.round(frame.width * frame.scale)),
  height: Math.max(1, Math.round(frame.height * frame.scale)),
});

/** Letterboxed display size (viewer CSS px) of a frame inside a stage. */
export const fitFrameToStage = (
  frame: SurfaceFrameGeometry,
  stage: { width: number; height: number },
): { width: number; height: number } | null => {
  if (!(frame.width > 0) || !(frame.height > 0) || !(stage.width > 0) || !(stage.height > 0)) {
    return null;
  }
  const fit = Math.min(stage.width / frame.width, stage.height / frame.height);
  return { width: frame.width * fit, height: frame.height * fit };
};

/**
 * Viewer px (relative to the displayed canvas box) → page CSS px for the wire.
 * This is the ONLY coordinate conversion in the remote surface path: the
 * header's width/height are already CSS px and its scale only sizes the canvas
 * backing store — applying scale to coordinates would double-count the dpr.
 */
export const viewerPointToFrameCss = (
  point: { x: number; y: number },
  displayed: { width: number; height: number },
  frame: SurfaceFrameGeometry,
): { x: number; y: number } | null => {
  if (!(displayed.width > 0) || !(displayed.height > 0)) return null;
  if (!(frame.width > 0) || !(frame.height > 0)) return null;
  const x = (point.x / displayed.width) * frame.width;
  const y = (point.y / displayed.height) * frame.height;
  return {
    x: Math.min(Math.max(x, 0), frame.width),
    y: Math.min(Math.max(y, 0), frame.height),
  };
};

// ── Frame rendering ─────────────────────────────────────────────────────────

export interface SurfaceFrameCanvasContext {
  drawImage(image: unknown, dx: number, dy: number): void;
}

export interface SurfaceFrameCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): SurfaceFrameCanvasContext | null;
}

export type SurfaceFrameDecoder = (data: ArrayBuffer) => Promise<unknown>;

const defaultSurfaceFrameDecoder: SurfaceFrameDecoder = (data) =>
  createImageBitmap(new Blob([data], { type: 'image/jpeg' }));

/** Decodes one JPEG frame and draws it onto the canvas at its backing size. */
export const renderSurfaceFrame = async (
  canvas: SurfaceFrameCanvas,
  header: SurfaceFrameHeader,
  data: ArrayBuffer,
  decode: SurfaceFrameDecoder = defaultSurfaceFrameDecoder,
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  const context = canvas.getContext('2d');
  if (!context) return false;
  const backing = frameCanvasBackingSize(header);
  if (canvas.width !== backing.width) canvas.width = backing.width;
  if (canvas.height !== backing.height) canvas.height = backing.height;
  const image = await decode(data);
  try {
    if (!isCurrent()) return false;
    context.drawImage(image, 0, 0);
  } finally {
    (image as { close?: () => void } | null)?.close?.();
  }
  return true;
};

// ── Client ──────────────────────────────────────────────────────────────────

export interface RemoteSurfaceClientOptions {
  directory: string;
  /** Attach to this session instead of listing sessions for the user to pick. */
  sessionId?: string;
  /** Tab to attach once inside the session (defaults to the first tab). */
  preferredTabId?: string;
  openSocket?: (url: string) => RelayTunnelWebSocket;
  refreshAuthToken?: () => Promise<unknown>;
  resolveSocketUrl?: (directory: string) => string;
  reconnectBaseDelayMs?: number;
  /** Test seam for the reconnect scheduler. */
  schedule?: (callback: () => void, delayMs: number) => void;
  logger?: Pick<Console, 'warn'>;
}

export type RemoteSurfaceFrameHandler = (
  header: SurfaceFrameHeader,
  data: ArrayBuffer,
  isCurrent: () => boolean,
) => void | Promise<void>;

const isIdleBackoff = (): boolean => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
  return false;
};

export class RemoteSurfaceClient {
  readonly inspector = new RemoteSurfaceInspector((command) => this.sendRaw(command));
  readonly contextMenu = new RemoteSurfaceContextMenu((command) => this.sendRaw(command));
  readonly devtools = new RemoteSurfaceDevTools((command) => this.sendRaw(command));
  readonly viewport = new RemoteSurfaceViewport({ send: (command) => this.sendRaw(command) });
  private readonly directory: string;
  private explicitSessionId: string | null;
  private pendingSessionCreation = false;
  private preferredTabId: string | null;
  private socket: RelayTunnelWebSocket | null = null;
  private state: RemoteSurfaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private frameHandler: RemoteSurfaceFrameHandler | null = null;
  private pendingFrameHeader: SurfaceFrameHeader | null = null;
  private deliveryChain: Promise<void> = Promise.resolve();
  private disposed = true;
  private generation = 0;
  private opening: Promise<void> | null = null;
  private reconnectFailures = 0;
  private attachmentSequence = 0;
  private pendingAttachmentRequestId: string | null = null;
  private confirmedAttachmentRequestId: string | null = null;
  private inputRevision = 0;
  private readonly clipboard = new RemoteSurfaceClipboardExchange();
  private readonly reconnectBaseDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => void;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly openSocketImpl: (url: string) => RelayTunnelWebSocket;
  private readonly refreshAuthToken: () => Promise<unknown>;
  private readonly resolveSocketUrl: (directory: string) => string;

  constructor(options: RemoteSurfaceClientOptions) {
    this.directory = options.directory;
    this.explicitSessionId = asNonEmptyString(options.sessionId);
    this.preferredTabId = asNonEmptyString(options.preferredTabId);
    this.openSocketImpl = options.openSocket ?? ((url: string) => openRuntimeWebSocket(url));
    this.refreshAuthToken = options.refreshAuthToken ?? (() => refreshRuntimeUrlAuthToken());
    this.resolveSocketUrl = options.resolveSocketUrl
      ?? ((directory: string) => getRuntimeUrlResolver().websocket(SURFACE_WS_PATH, { directory }));
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.schedule = options.schedule ?? ((callback, delayMs) => { setTimeout(callback, delayMs); });
    this.logger = options.logger ?? console;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): RemoteSurfaceState => this.state;

  setFrameHandler(handler: RemoteSurfaceFrameHandler | null): void {
    this.frameHandler = handler;
  }

  /** Opens the socket and runs the handshake. Resolves once the socket is up. */
  start(): Promise<void> {
    if (this.socket) {
      if (this.state.phase === 'error') this.sendHandshake();
      return Promise.resolve();
    }
    if (!this.disposed && this.opening) return this.opening;
    this.disposed = false;
    const generation = ++this.generation;
    this.setState({ phase: 'connecting', errorMessage: null });
    this.opening = this.openSocket(generation).finally(() => {
      if (generation === this.generation) this.opening = null;
    });
    return this.opening;
  }

  stop(): void {
    this.inspector.setAttachment(null);
    this.contextMenu.setAttachment(null);
    this.devtools.setAttachment(null);
    this.viewport.setAttachment(null);
    this.invalidateClipboard();
    this.disposed = true;
    this.generation += 1;
    this.opening = null;
    this.pendingSessionCreation = false;
    this.pendingAttachmentRequestId = null;
    this.confirmedAttachmentRequestId = null;
    this.pendingFrameHeader = null;
    this.deliveryChain = Promise.resolve();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'viewer closed');
    } catch {
      // already closed
    }
  }

  /** Handshake: create a new project-persistent session. */
  createSession(): void {
    if (!this.isSocketOpen()) return;
    this.pendingSessionCreation = true;
    this.setState({ phase: 'attaching' });
    this.sendRaw({ type: 'create' });
  }

  /** Handshake: attach to an existing session (e.g. the agent's ephemeral one). */
  attachSession(sessionId: string): void {
    if (!asNonEmptyString(sessionId)) return;
    this.pendingSessionCreation = false;
    this.explicitSessionId = sessionId;
    this.setState({ phase: 'attaching', session: null, tabs: [], activeTabId: null });
    if (!this.isSocketOpen()) return;
    this.sendRaw({ type: 'attach', sessionId });
  }

  /** Attach the viewer to another tab of the joined session. */
  attachTab(tabId: string): void {
    if (!asNonEmptyString(tabId)) return;
    this.preferredTabId = tabId;
    this.setState({ activeTabId: tabId, phase: 'attaching', errorMessage: null });
    if (!this.isSocketOpen() || !this.state.session) return;
    this.requestTabAttachment(tabId);
  }

  private requestTabAttachment(tabId: string): void {
    const requestId = `attachment-${++this.attachmentSequence}`;
    this.pendingAttachmentRequestId = requestId;
    this.sendRaw({ type: 'attachTab', tabId, requestId });
  }

  sendPointer(input: { eventType: 'move' | 'down' | 'up'; x: number; y: number; button?: 0 | 1 | 2 }): boolean {
    return this.sendInput({
      type: 'pointer',
      eventType: input.eventType,
      x: input.x,
      y: input.y,
      ...(input.button !== undefined ? { button: input.button } : {}),
    });
  }

  sendKey(input: { eventType: 'keydown' | 'keyup'; key: string; modifiers?: string[] }): boolean {
    return this.sendInput({
      type: 'key',
      eventType: input.eventType,
      key: input.key,
      ...(input.modifiers && input.modifiers.length > 0 ? { modifiers: input.modifiers } : {}),
    });
  }

  /** Committed text (IME-safe): dispatched as Input.insertText, never as key events. */
  sendText(text: string): boolean {
    if (!text) return false;
    const payload = JSON.stringify({ type: 'text', text, tabId: this.state.activeTabId });
    if (new TextEncoder().encode(payload).byteLength > SURFACE_MESSAGE_MAX_BYTES) return false;
    return this.sendInput({ type: 'text', text });
  }

  /** Captures the attachment for clipboard permission prompts and other delayed input. */
  captureInputScope(): () => boolean {
    const socket = this.socket;
    const generation = this.generation;
    const revision = this.inputRevision;
    const sessionId = this.state.session?.id;
    const tabId = this.state.activeTabId;
    return () => !this.disposed && this.isSocketOpen() && socket === this.socket
      && generation === this.generation && revision === this.inputRevision
      && this.state.phase === 'attached' && Boolean(sessionId && tabId)
      && sessionId === this.state.session?.id && tabId === this.state.activeTabId;
  }

  copySelection(): Promise<string> {
    const tabId = this.state.activeTabId;
    if (!tabId || !this.captureInputScope()()) {
      return Promise.reject(new RemoteSurfaceClipboardError('COPY_UNAVAILABLE'));
    }
    return this.clipboard.request(tabId, (request) => this.sendRaw(request));
  }

  sendWheel(input: { x: number; y: number; deltaX: number; deltaY: number; modifiers?: string[] }): boolean {
    return this.sendInput({ type: 'wheel', ...input });
  }

  navigate(url: string): boolean {
    this.inspector.invalidateRequests();
    this.invalidateClipboard();
    return this.sendInput({ type: 'navigate', url });
  }

  navigateHistory(action: 'back' | 'forward' | 'reload' | 'stop'): boolean {
    this.inspector.invalidateRequests();
    this.invalidateClipboard();
    return this.sendInput({ type: action });
  }

  createTab(): void {
    if (!this.state.session || !this.isSocketOpen()) return;
    this.setState({ phase: 'attaching' });
    this.sendRaw({ type: 'createTab' });
  }

  private async openSocket(generation = this.generation): Promise<void> {
    try {
      await this.refreshAuthToken();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.setState({
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed || generation !== this.generation || this.socket) return;
    let socket: RelayTunnelWebSocket;
    try {
      socket = this.openSocketImpl(this.resolveSocketUrl(this.directory));
    } catch (error) {
      this.setState({
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // The gateway streams JPEG frames as binary messages; the default 'blob'
    // binaryType would break frame reads.
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onmessage = (event) => this.handleSocketMessage(socket, event);
    socket.onclose = (event) => this.handleSocketClose(socket, event);
  }

  private handleSocketMessage(socket: RelayTunnelWebSocket, event: { data: string | ArrayBuffer }): void {
    if (this.disposed || socket !== this.socket) return;
    if (typeof event.data !== 'string') {
      this.handleFramePayload(event.data);
      return;
    }
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      this.logger.warn('[remote-surface] ignored malformed JSON message');
      return;
    }
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'hello':
        this.sendHandshake();
        return;
      case 'list':
        this.setState({ phase: 'choosing', sessions: parseSessions(message.sessions) });
        return;
      case 'created':
      case 'attached':
        this.handleSessionJoined(message);
        return;
      case 'tabs': {
        const parsed = tabsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const { tabs, activeTabId: requestedTabId } = parsed.data;
        if (requestedTabId && !tabs.some((tab) => tab.id === requestedTabId)) return;
        const activeTabId = requestedTabId ?? (tabs.some((tab) => tab.id === this.state.activeTabId)
          ? this.state.activeTabId : tabs[0]?.id ?? null);
        this.setState({ tabs: tabs.map((tab) => ({ ...this.state.tabs.find((current) => current.id === tab.id), ...tab })) });
        if (activeTabId && (requestedTabId || activeTabId !== this.state.activeTabId)) this.attachTab(activeTabId);
        else if (!activeTabId) this.setState({ activeTabId: null });
        return;
      }
      case 'navigation': {
        const parsed = navigationSchema.safeParse(message);
        if (!parsed.success) return;
        const { tabId, ...navigation } = parsed.data;
        if (!this.state.tabs.some((tab) => tab.id === tabId)) return;
        if (tabId === this.state.activeTabId && (navigation.isLoading
          || navigation.url !== this.state.tabs.find((tab) => tab.id === tabId)?.url)) {
          this.invalidateClipboard();
          this.inspector.invalidateRequests();
        }
        this.setState({ tabs: this.state.tabs.map((tab) => tab.id === tabId ? { ...tab, ...navigation } : tab) });
        return;
      }
      case 'copyResult': {
        const parsed = surfaceCopyResultSchema.safeParse(message);
        if (parsed.success) this.clipboard.receive(parsed.data);
        return;
      }
      case 'contextMenuResult': {
        const parsed = surfaceContextMenuResultSchema.safeParse(message);
        if (parsed.success) this.contextMenu.receive(parsed.data);
        return;
      }
      case 'inspectorStarted':
      case 'inspectorEvents':
      case 'inspectorCleared':
      case 'inspectorEvaluated':
      case 'inspectorRequestResult':
      case 'inspectorError':
        this.inspector.receive(event.data);
        return;
      case 'devtoolsStarted':
      case 'devtoolsError':
      case 'devtoolsMessageChunk':
      case 'devtoolsChunkAck':
      case 'devtoolsClosed':
      case 'devtoolsStopped':
        this.devtools.receive(event.data);
        return;
      case 'viewportResult':
      case 'viewportState':
      case 'viewportError':
        this.viewport.receive(event.data);
        return;
      case 'frame':
        this.handleFrameHeader(message);
        return;
      case 'state':
        this.handleSurfaceState(message);
        return;
      case 'error':
        this.handleServerError(message);
        return;
      default:
    }
  }

  private sendHandshake(): void {
    this.pendingSessionCreation = false;
    const sessionId = this.state.session?.id ?? this.explicitSessionId;
    if (sessionId) {
      this.setState({ phase: 'attaching' });
      this.sendRaw({ type: 'attach', sessionId });
      return;
    }
    this.sendRaw({ type: 'list' });
  }

  private handleSessionJoined(message: ServerMessage): void {
    const session = parseSession(message.session);
    if (!session) {
      this.logger.warn('[remote-surface] ignored session join without a session id');
      return;
    }
    if (message.type === 'created' && !this.pendingSessionCreation) return;
    if (message.type === 'attached' && (this.pendingSessionCreation
      || (this.explicitSessionId && session.id !== this.explicitSessionId))) return;
    this.pendingSessionCreation = false;
    if (message.type === 'created') this.explicitSessionId = session.id;
    const tabs = parseTabs(message.tabs);
    const requestedTab = this.state.activeTabId ?? this.preferredTabId;
    const activeTabId = requestedTab && tabs.some((tab) => tab.id === requestedTab)
      ? requestedTab
      : (tabs[0]?.id ?? null);
    // A completed handshake is the healthy-connection signal that resets the
    // reconnect backoff.
    this.reconnectFailures = 0;
    this.setState({
      session,
      tabs,
      activeTabId,
      errorMessage: null,
      phase: activeTabId ? 'attaching' : 'attached',
    });
    if (activeTabId) {
      // attachTab doubles as the latest-frame request: the gateway answers a
      // late joiner with its cached frame before streaming new ones.
      this.requestTabAttachment(activeTabId);
    } else {
      this.createTab();
    }
  }

  private handleFrameHeader(message: ServerMessage): void {
    const header = parseSurfaceFrameHeader(message);
    if (!header) {
      this.logger.warn('[remote-surface] dropped malformed frame header');
      return;
    }
    if (this.pendingFrameHeader) {
      this.logger.warn('[remote-surface] dropped frame header whose payload never arrived');
    }
    this.pendingFrameHeader = header;
  }

  private handleFramePayload(data: ArrayBuffer): void {
    const header = this.pendingFrameHeader;
    this.pendingFrameHeader = null;
    if (!header) {
      this.logger.warn('[remote-surface] dropped frame payload without a header');
      return;
    }
    // Serial delivery keeps canvas draws in wire order. The ack goes out after
    // the frame is consumed: the gateway's per-viewer accounting treats it as
    // the backpressure signal, so acking before rendering would unbound the queue.
    const generation = this.generation;
    const socket = this.socket;
    this.deliveryChain = this.deliveryChain.then(async () => {
      if (this.disposed || generation !== this.generation || socket !== this.socket) return;
      try {
        await this.frameHandler?.(header, data, () => !this.disposed && generation === this.generation && socket === this.socket);
      } catch {
        // A renderer failure must not stall the ack chain.
      }
      if (generation === this.generation && socket === this.socket) {
        this.sendRaw({ type: 'frameAck', frameSeq: header.frameSeq });
      }
    });
  }

  private handleSurfaceState(message: ServerMessage): void {
    if (!this.state.activeTabId || message.tabId !== this.state.activeTabId) return;
    if (this.state.phase !== 'attached') {
      if (this.state.phase !== 'attaching' || !this.pendingAttachmentRequestId
        || message.attachmentRequestId !== this.pendingAttachmentRequestId) return;
      this.confirmedAttachmentRequestId = this.pendingAttachmentRequestId;
      this.pendingAttachmentRequestId = null;
    } else if (message.attachmentRequestId !== undefined) return;
    const lease = parseLease(message.lease);
    this.setState({
      phase: 'attached',
      agentControlling: lease !== null && lease.actor !== 'user',
    });
  }

  private handleServerError(message: ServerMessage): void {
    const code = asNonEmptyString(message.code) ?? '';
    const text = asNonEmptyString(message.message) ?? 'Unknown surface error';
    if (code === 'SESSION_NOT_FOUND') {
      // The session we wanted is gone (expired or ended server-side). Drop the
      // identity and fall back to listing, which is the honest recovery.
      this.explicitSessionId = null;
      this.setState({ session: null, tabs: [], activeTabId: null, phase: 'connecting' });
      this.sendRaw({ type: 'list' });
      return;
    }
    if (code === 'TAB_NOT_FOUND') {
      const fallback = this.state.tabs.find((tab) => tab.id !== this.state.activeTabId);
      if (fallback) {
        this.attachTab(fallback.id);
        return;
      }
      this.setState({ phase: 'error', errorMessage: text });
      return;
    }
    if (code === 'BACKEND_UNAVAILABLE' || this.state.phase === 'connecting' || this.state.phase === 'attaching') {
      this.setState({ phase: 'error', errorMessage: text });
      return;
    }
    this.logger.warn(`[remote-surface] server error ${code || '(no code)'}: ${text}`);
  }

  private handleSocketClose(socket: RelayTunnelWebSocket, event: { code: number; reason: string }): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.pendingFrameHeader = null;
    this.deliveryChain = Promise.resolve();
    if (this.disposed) return;
    if (event.code === 1001) {
      // The gateway closes viewers with 1001 when the session (or Chrome) ended.
      this.explicitSessionId = null;
      this.setState({
        phase: 'ended',
        session: null,
        tabs: [],
        activeTabId: null,
        errorMessage: asNonEmptyString(event.reason),
      });
      return;
    }
    this.reconnectFailures += 1;
    this.setState({ phase: 'reconnecting' });
    const generation = this.generation;
    const delay = isIdleBackoff() || event.code === 1008
      ? RECONNECT_IDLE_MAX_DELAY_MS
      : Math.min(RECONNECT_MAX_DELAY_MS, this.reconnectBaseDelayMs * 2 ** (this.reconnectFailures - 1));
    this.schedule(() => {
      if (this.disposed || generation !== this.generation || this.socket) return;
      // Every reconnect re-mints the url token before dialing.
      void this.openSocket();
    }, delay);
  }

  private sendInput(message: Record<string, unknown>): boolean {
    const tabId = this.state.activeTabId;
    // Dropped, never queued: replaying stale input after a reconnect would
    // click wherever the page happens to be then.
    if (!this.isSocketOpen() || this.state.phase !== 'attached' || !tabId) {
      this.logger.warn('[remote-surface] dropped input while not attached');
      return false;
    }
    return this.sendRaw({ ...message, tabId });
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WS_OPEN;
  }

  private sendRaw(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private setState(partial: Partial<RemoteSurfaceState>): void {
    if (partial.phase !== undefined && partial.phase !== 'attaching') this.pendingSessionCreation = false;
    const attachmentChanged = (partial.phase !== undefined && partial.phase !== 'attached')
      || (partial.activeTabId !== undefined && partial.activeTabId !== this.state.activeTabId)
      || (partial.session !== undefined && partial.session?.id !== this.state.session?.id);
    if (attachmentChanged) {
      this.pendingAttachmentRequestId = null;
      this.confirmedAttachmentRequestId = null;
      this.invalidateClipboard();
    }
    this.state = { ...this.state, ...partial,
      agentControlling: attachmentChanged ? false : partial.agentControlling ?? this.state.agentControlling };
    this.inspector.setAttachment(this.state.phase === 'attached' ? this.state.activeTabId : null);
    const attachment = this.state.phase === 'attached' && this.state.activeTabId && this.confirmedAttachmentRequestId
      ? { tabId: this.state.activeTabId, attachmentRequestId: this.confirmedAttachmentRequestId } : null;
    this.devtools.setAttachment(attachment);
    this.contextMenu.setAttachment(attachment);
    this.viewport.setAttachment(attachment);
    this.viewport.setAgentControlling(this.state.agentControlling);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private invalidateClipboard(): void {
    this.inputRevision += 1;
    this.clipboard.cancel();
    this.contextMenu.cancel();
  }
}
