import { RemoteSurfaceDevToolsChunks } from './remoteSurfaceDevToolsChunks';
import {
  DEVTOOLS_MESSAGE_BYTES, DEVTOOLS_TIMEOUT_MS, surfaceDevToolsMessageSchema,
  type DevToolsAttachment, type DevToolsCommand, type DevToolsErrorCode,
} from './remoteSurfaceDevToolsProtocol';

type DevToolsState = {
  readonly open: boolean;
  readonly phase: 'closed' | 'connecting' | 'ready' | 'error';
  readonly devtoolsId: string | null;
  readonly frontendPath: string | null;
  readonly attachment: DevToolsAttachment | null;
  readonly errorCode: DevToolsErrorCode | null;
};
const initialState: DevToolsState = {
  open: false, phase: 'closed', devtoolsId: null, frontendPath: null, attachment: null, errorCode: null,
};

export class RemoteSurfaceDevTools {
  private state = initialState;
  private readonly listeners = new Set<() => void>();
  private attachment: DevToolsAttachment | null = null;
  private pending: (DevToolsAttachment & { readonly requestId: string }) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chunks: RemoteSurfaceDevToolsChunks | null = null;
  private messageHandler: ((message: string) => void) | null = null;
  private earlyMessages: string[] = [];
  private earlyBytes = 0;
  private requestSequence = 0;

  constructor(private readonly send: (command: DevToolsCommand) => boolean) {}

  readonly getState = (): DevToolsState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAttachment(attachment: DevToolsAttachment | null): void {
    if (attachment?.tabId === this.attachment?.tabId
      && attachment?.attachmentRequestId === this.attachment?.attachmentRequestId) return;
    this.stopConnection();
    this.attachment = attachment;
    this.update({ ...initialState, open: this.state.open, attachment,
      phase: this.state.open ? 'connecting' : 'closed' });
    if (this.state.open && attachment) this.startConnection();
  }

  setOpen(open: boolean): void {
    if (open === this.state.open && this.state.phase !== 'error') return;
    this.stopConnection();
    this.update({ ...initialState, open, attachment: this.attachment, phase: open ? 'connecting' : 'closed' });
    if (open && this.attachment) this.startConnection();
  }

  setMessageHandler(handler: ((message: string) => void) | null): void {
    this.messageHandler = handler;
    if (!handler) return;
    const messages = this.earlyMessages;
    this.earlyMessages = [];
    this.earlyBytes = 0;
    for (const message of messages) {
      if (this.messageHandler !== handler || this.state.phase !== 'ready') break;
      handler(message);
    }
  }

  sendMessage(message: string): void {
    if (this.state.phase === 'ready') this.chunks?.sendMessage(message);
  }

  receive(raw: string): void {
    if (raw.length > 64 * 1024) { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    let parsed;
    try { parsed = surfaceDevToolsMessageSchema.safeParse(JSON.parse(raw)); }
    catch { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    if (!parsed.success) { this.fail('DEVTOOLS_INVALID_REQUEST'); return; }
    const message = parsed.data;
    if (message.type === 'devtoolsStarted' || message.type === 'devtoolsError') {
      const pending = this.pending;
      if (!this.state.open || !pending || message.requestId !== pending.requestId
        || message.tabId !== pending.tabId || message.attachmentRequestId !== pending.attachmentRequestId) return;
      this.pending = null;
      this.clearTimer();
      if (message.type === 'devtoolsError') { this.fail(message.code); return; }
      this.chunks = new RemoteSurfaceDevToolsChunks(message.devtoolsId, this.send,
        (data) => this.deliver(data), (code) => this.fail(code));
      this.update({ ...this.state, phase: 'ready', devtoolsId: message.devtoolsId,
        frontendPath: message.frontendPath, errorCode: null });
      return;
    }
    if (message.devtoolsId !== this.state.devtoolsId) return;
    switch (message.type) {
      case 'devtoolsMessageChunk': this.chunks?.receive(message); return;
      case 'devtoolsChunkAck': this.chunks?.acknowledge(message); return;
      case 'devtoolsClosed': this.fail(message.code); return;
      case 'devtoolsStopped':
        if (this.state.open) this.fail('DEVTOOLS_CONNECTION_CLOSED');
    }
  }

  dispose(): void {
    this.setOpen(false);
    this.attachment = null;
    this.messageHandler = null;
  }

  private startConnection(): void {
    const attachment = this.attachment;
    if (!attachment) return;
    this.pending = { ...attachment, requestId: `devtools-${++this.requestSequence}` };
    this.timer = setTimeout(() => this.fail('DEVTOOLS_START_FAILED'), DEVTOOLS_TIMEOUT_MS);
    if (!this.send({ type: 'devtoolsStart', ...this.pending })) this.fail('DEVTOOLS_START_FAILED');
  }

  private deliver(message: string): void {
    if (this.messageHandler) { this.messageHandler(message); return; }
    const byteLength = new TextEncoder().encode(message).byteLength;
    if (this.earlyMessages.length >= 256 || this.earlyBytes + byteLength > DEVTOOLS_MESSAGE_BYTES) {
      this.fail('DEVTOOLS_BACKPRESSURE'); return;
    }
    this.earlyMessages.push(message);
    this.earlyBytes += byteLength;
  }

  private stopConnection(): void {
    if (this.state.devtoolsId || this.pending) {
      this.send({ type: 'devtoolsStop', devtoolsId: this.state.devtoolsId ?? undefined });
    }
    this.clearTimer();
    this.pending = null;
    this.chunks?.dispose();
    this.chunks = null;
    this.messageHandler = null;
    this.earlyMessages = [];
    this.earlyBytes = 0;
  }

  private fail(code: DevToolsErrorCode): void {
    this.stopConnection();
    this.update({ ...this.state, phase: 'error', devtoolsId: null, frontendPath: null, errorCode: code });
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private update(state: DevToolsState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
