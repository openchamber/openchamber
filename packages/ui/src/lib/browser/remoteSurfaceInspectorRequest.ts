import type { SurfaceInspectorErrorCode } from './remoteSurfaceInspectorProtocol';

const messages = {
  UNAVAILABLE: 'The browser inspector is unavailable.',
  INVALID_REQUEST: 'The inspector request is invalid.',
  CAPTURE_GONE: 'This inspector capture has ended.',
  EVALUATION_FAILED: 'JavaScript could not be evaluated.',
  EVALUATION_TIMEOUT: 'JavaScript evaluation timed out.',
  REQUEST_GONE: 'This network request is no longer available.',
  REQUEST_FAILED: 'Network request details could not be loaded.',
  CAPTURE_FAILED: 'Browser inspection could not be started.',
  CANCELLED: 'The inspector request is no longer current.',
  TIMEOUT: 'The inspector request timed out.',
} satisfies Readonly<Record<SurfaceInspectorErrorCode, string>>;

export class RemoteSurfaceInspectorError extends Error {
  readonly name = 'RemoteSurfaceInspectorError';
  constructor(readonly code: SurfaceInspectorErrorCode) { super(messages[code]); }
}

type InspectorReply = {
  readonly requestId: string;
  readonly tabId: string;
  readonly captureId: string;
  readonly entryId?: string;
};

export class RemoteSurfaceInspectorRequest<T extends InspectorReply> {
  private pending: {
    readonly identity: InspectorReply;
    readonly resolve: (value: T) => void;
    readonly reject: (error: RemoteSurfaceInspectorError) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  start(identity: InspectorReply, send: () => boolean): Promise<T> {
    this.cancel('CANCELLED');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel('TIMEOUT'), 10_000);
      this.pending = { identity, resolve, reject, timer };
      if (!send()) this.cancel('UNAVAILABLE');
    });
  }

  receive(reply: T): void {
    const pending = this.pending;
    if (!pending || pending.identity.requestId !== reply.requestId
      || pending.identity.tabId !== reply.tabId || pending.identity.captureId !== reply.captureId
      || pending.identity.entryId !== reply.entryId) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(reply);
  }

  fail(requestId: string, code: SurfaceInspectorErrorCode): void {
    if (this.pending?.identity.requestId === requestId) this.cancel(code);
  }

  cancel(code: SurfaceInspectorErrorCode): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(new RemoteSurfaceInspectorError(code));
  }
}
