import {
  surfaceViewportMessageSchema,
  type RemoteSurfaceViewportCommand,
  type RemoteSurfaceViewportErrorCode,
  type RemoteSurfaceViewportMessage,
  type RemoteSurfaceViewportSnapshot,
} from './remoteSurfaceViewportProtocol';

export type { RemoteSurfaceViewportCommand } from './remoteSurfaceViewportProtocol';

const AUTO_DEBOUNCE_MS = 150;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_VIEWPORT_DIMENSION = 3_840;

export type RemoteSurfaceViewportAttachment = {
  readonly tabId: string;
  readonly attachmentRequestId: string;
};

export type RemoteSurfaceViewportSelection = {
  readonly width: number;
  readonly height: number;
  readonly mode: 'auto' | 'fixed';
  readonly mobile: boolean;
};

export type RemoteSurfaceViewportState = {
  readonly attachment: RemoteSurfaceViewportAttachment | null;
  readonly viewport: RemoteSurfaceViewportSnapshot | null;
  readonly pending: RemoteSurfaceViewportCommand | null;
  readonly errorCode: RemoteSurfaceViewportErrorCode | null;
  readonly autoEnabled: boolean;
  readonly agentControlling: boolean;
  readonly visible: boolean;
};

export type RemoteSurfaceViewportTimer = {
  readonly cancel: () => void;
};

export type RemoteSurfaceViewportOptions = {
  readonly send: (command: RemoteSurfaceViewportCommand) => boolean;
  readonly nextRequestId?: () => string;
  readonly schedule?: (callback: () => void, delayMs: number) => RemoteSurfaceViewportTimer;
  readonly autoDebounceMs?: number;
  readonly requestTimeoutMs?: number;
};

const INITIAL_STATE: RemoteSurfaceViewportState = {
  attachment: null,
  viewport: null,
  pending: null,
  errorCode: null,
  autoEnabled: true,
  agentControlling: false,
  visible: true,
};

const sameAttachment = (
  first: RemoteSurfaceViewportAttachment | null,
  second: RemoteSurfaceViewportAttachment | null,
): boolean => first?.tabId === second?.tabId && first?.attachmentRequestId === second?.attachmentRequestId;

const normalizeDimension = (value: number): number | null => {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_VIEWPORT_DIMENSION, Math.max(1, Math.round(value)));
};

export class RemoteSurfaceViewport {
  private readonly send: (command: RemoteSurfaceViewportCommand) => boolean;
  private readonly nextRequestId: () => string;
  private readonly schedule: (callback: () => void, delayMs: number) => RemoteSurfaceViewportTimer;
  private readonly autoDebounceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<() => void>();
  private state: RemoteSurfaceViewportState = INITIAL_STATE;
  private stage: { readonly width: number; readonly height: number } | null = null;
  private queuedExplicit: RemoteSurfaceViewportSelection | null = null;
  private autoMobile = false;
  private autoTimer: RemoteSurfaceViewportTimer | null = null;
  private requestTimer: RemoteSurfaceViewportTimer | null = null;
  private confirmedRevision = -1;
  private waitingForAuthority = false;
  private requestSequence = 0;

  constructor(options: RemoteSurfaceViewportOptions) {
    this.send = options.send;
    this.nextRequestId = options.nextRequestId ?? (() => `viewport-${++this.requestSequence}`);
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(timer) };
    });
    this.autoDebounceMs = options.autoDebounceMs ?? AUTO_DEBOUNCE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): RemoteSurfaceViewportState => this.state;

  setAttachment(attachment: RemoteSurfaceViewportAttachment | null): void {
    if (sameAttachment(this.state.attachment, attachment)) return;
    this.cancelAutoTimer();
    this.cancelRequestTimer();
    this.queuedExplicit = null;
    this.autoMobile = false;
    this.confirmedRevision = -1;
    this.waitingForAuthority = false;
    this.state = {
      ...this.state,
      attachment,
      viewport: null,
      pending: null,
      errorCode: null,
      autoEnabled: true,
    };
    this.publish();
    this.scheduleAuto();
  }

  setAgentControlling(agentControlling: boolean): void {
    if (this.state.agentControlling === agentControlling) return;
    if (agentControlling) this.cancelAutoTimer();
    else this.waitingForAuthority = false;
    this.state = { ...this.state, agentControlling };
    this.publish();
    if (!agentControlling) this.scheduleAuto();
  }

  setVisible(visible: boolean): void {
    if (this.state.visible === visible) return;
    if (!visible) this.cancelAutoTimer();
    else this.waitingForAuthority = false;
    this.state = { ...this.state, visible };
    this.publish();
    if (visible) this.scheduleAuto();
  }

  updateStage(width: number, height: number): void {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    const stage = normalizedWidth && normalizedHeight ? { width: normalizedWidth, height: normalizedHeight } : null;
    if (this.stage?.width === stage?.width && this.stage?.height === stage?.height) return;
    this.stage = stage;
    this.cancelAutoTimer();
    this.scheduleAuto();
  }

  selectViewport(selection: RemoteSurfaceViewportSelection): boolean {
    const width = normalizeDimension(selection.width);
    const height = normalizeDimension(selection.height);
    if (!width || !height) return false;
    const next = { width, height, mode: selection.mode, mobile: selection.mobile };
    this.autoMobile = next.mobile;
    this.waitingForAuthority = false;
    this.cancelAutoTimer();
    this.state = { ...this.state, autoEnabled: next.mode === 'auto', errorCode: null };
    this.queuedExplicit = next;
    this.publish();
    this.flushExplicit();
    return true;
  }

  receive(raw: string): boolean {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    const parsed = surfaceViewportMessageSchema.safeParse(data);
    if (!parsed.success) return false;
    this.receiveMessage(parsed.data);
    return true;
  }

  dispose(): void {
    this.cancelAutoTimer();
    this.cancelRequestTimer();
    this.listeners.clear();
    this.state = INITIAL_STATE;
    this.stage = null;
    this.queuedExplicit = null;
  }

  private receiveMessage(message: RemoteSurfaceViewportMessage): void {
    const attachment = this.state.attachment;
    if (!attachment || message.tabId !== attachment.tabId || message.attachmentRequestId !== attachment.attachmentRequestId) return;
    switch (message.type) {
      case 'viewportState':
        this.receiveState(message.viewport);
        return;
      case 'viewportResult':
        this.receiveResult(message);
        return;
      case 'viewportError':
        this.receiveError(message);
        return;
    }
  }

  private receiveState(viewport: RemoteSurfaceViewportSnapshot): void {
    if (viewport.revision <= this.confirmedRevision) return;
    this.confirmViewport(viewport);
    if (this.waitingForAuthority && viewport.autoAllowed) this.waitingForAuthority = false;
    this.publish();
    this.flushExplicit();
    this.scheduleAuto();
  }

  private receiveResult(message: Extract<RemoteSurfaceViewportMessage, { readonly type: 'viewportResult' }>): void {
    const pending = this.state.pending;
    if (!pending || pending.requestId !== message.requestId) return;
    this.cancelRequestTimer();
    this.state = { ...this.state, pending: null };
    this.confirmViewport(message.viewport);
    if (message.status === 'not-owner') {
      this.waitingForAuthority = this.queuedExplicit === null;
    } else {
      this.waitingForAuthority = false;
      this.state = { ...this.state, errorCode: null };
    }
    this.publish();
    this.flushExplicit();
    if (message.status !== 'not-owner') this.scheduleAuto();
  }

  private receiveError(message: Extract<RemoteSurfaceViewportMessage, { readonly type: 'viewportError' }>): void {
    const pending = this.state.pending;
    if (!pending || pending.requestId !== message.requestId) return;
    this.cancelRequestTimer();
    if (message.code === 'SUPERSEDED') {
      this.waitingForAuthority = this.queuedExplicit === null;
      this.state = { ...this.state, pending: null, errorCode: null };
      this.publish();
      this.flushExplicit();
      return;
    }
    this.waitingForAuthority = this.queuedExplicit === null;
    this.state = { ...this.state, pending: null, errorCode: message.code };
    this.publish();
    this.flushExplicit();
  }

  private confirmViewport(viewport: RemoteSurfaceViewportSnapshot): void {
    if (viewport.revision < this.confirmedRevision) return;
    this.confirmedRevision = viewport.revision;
    if ((viewport.mode !== 'auto' || viewport.source !== 'viewer') && !this.queuedExplicit
      && !(viewport.source === 'external' && viewport.autoAllowed)) {
      this.cancelAutoTimer();
      this.state = { ...this.state, viewport, autoEnabled: false };
      return;
    }
    this.state = { ...this.state, viewport };
  }

  private flushExplicit(): void {
    if (this.state.pending || !this.queuedExplicit || !this.state.attachment) return;
    const selection = this.queuedExplicit;
    this.queuedExplicit = null;
    this.sendSelection(selection, true);
  }

  private scheduleAuto(): void {
    if (!this.canSendAuto() || this.autoTimer || this.state.pending || this.queuedExplicit) return;
    const stage = this.stage;
    if (!stage || this.matchesConfirmedAuto(stage)) return;
    this.autoTimer = this.schedule(() => {
      this.autoTimer = null;
      if (!this.canSendAuto() || this.state.pending || this.queuedExplicit || !this.stage) return;
      if (this.matchesConfirmedAuto(this.stage)) return;
      this.sendSelection({ ...this.stage, mode: 'auto', mobile: this.autoMobile }, false);
    }, this.autoDebounceMs);
  }

  private canSendAuto(): boolean {
    return Boolean(this.state.attachment && this.stage && this.state.visible && this.state.autoEnabled
      && !this.state.agentControlling && !this.waitingForAuthority && this.state.viewport?.autoAllowed !== false);
  }

  private matchesConfirmedAuto(stage: { readonly width: number; readonly height: number }): boolean {
    const viewport = this.state.viewport;
    return viewport?.mode === 'auto' && viewport.source === 'viewer'
      && viewport.width === stage.width && viewport.height === stage.height && viewport.mobile === this.autoMobile;
  }

  private sendSelection(selection: RemoteSurfaceViewportSelection, takeover: boolean): void {
    const attachment = this.state.attachment;
    if (!attachment) return;
    const command: RemoteSurfaceViewportCommand = {
      type: 'viewportSet',
      requestId: this.nextRequestId(),
      tabId: attachment.tabId,
      attachmentRequestId: attachment.attachmentRequestId,
      width: selection.width,
      height: selection.height,
      mode: selection.mode,
      mobile: selection.mobile,
      takeover,
    };
    if (!this.send(command)) {
      this.waitingForAuthority = true;
      this.state = { ...this.state, errorCode: 'UNAVAILABLE' };
      this.publish();
      return;
    }
    this.state = { ...this.state, pending: command, errorCode: null };
    this.requestTimer = this.schedule(() => this.timeoutRequest(command.requestId), this.requestTimeoutMs);
    this.publish();
  }

  private timeoutRequest(requestId: string): void {
    if (this.state.pending?.requestId !== requestId) return;
    this.requestTimer = null;
    this.waitingForAuthority = this.queuedExplicit === null;
    this.state = { ...this.state, pending: null, errorCode: 'RESIZE_TIMEOUT' };
    this.publish();
    this.flushExplicit();
  }

  private cancelAutoTimer(): void {
    if (this.autoTimer === null) return;
    this.autoTimer.cancel();
    this.autoTimer = null;
  }

  private cancelRequestTimer(): void {
    if (this.requestTimer === null) return;
    this.requestTimer.cancel();
    this.requestTimer = null;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
