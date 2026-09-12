import { z } from 'zod';

export const SURFACE_MESSAGE_MAX_BYTES = 64 * 1024;
const COPY_TIMEOUT_MS = 10_000;

const copyResultBase = z.object({
  type: z.literal('copyResult'),
  requestId: z.string().min(1).max(128),
  tabId: z.string().min(1),
});

export const surfaceCopyResultSchema = z.discriminatedUnion('ok', [
  copyResultBase.extend({ ok: z.literal(true), text: z.string().max(SURFACE_MESSAGE_MAX_BYTES) }),
  copyResultBase.extend({
    ok: z.literal(false),
    code: z.enum(['NO_SELECTION', 'COPY_TOO_LARGE', 'COPY_FAILED']),
    message: z.string(),
  }),
]);

const errorMessages = {
  NO_SELECTION: 'No text is selected in the remote page.',
  COPY_TOO_LARGE: 'The selected text exceeds the clipboard message limit.',
  COPY_FAILED: 'The remote selection could not be copied.',
  COPY_UNAVAILABLE: 'The remote browser is not attached.',
  COPY_CANCELLED: 'The clipboard request is no longer current.',
  COPY_TIMEOUT: 'The remote clipboard request timed out.',
} as const;

export class RemoteSurfaceClipboardError extends Error {
  readonly name = 'RemoteSurfaceClipboardError';

  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
  }
}

type CopyRequest = {
  readonly type: 'copy';
  readonly requestId: string;
  readonly tabId: string;
};
type PendingCopy = {
  readonly request: CopyRequest;
  readonly resolve: (text: string) => void;
  readonly reject: (error: RemoteSurfaceClipboardError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** One user-requested selection at a time; replies never populate a clipboard cache. */
export class RemoteSurfaceClipboardExchange {
  private sequence = 0;
  private pending: PendingCopy | null = null;

  request(tabId: string, send: (request: CopyRequest) => boolean): Promise<string> {
    this.cancel();
    const request: CopyRequest = { type: 'copy', requestId: String(++this.sequence), tabId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.request === request) this.cancel('COPY_TIMEOUT');
      }, COPY_TIMEOUT_MS);
      this.pending = { request, resolve, reject, timer };
      if (!send(request)) this.cancel('COPY_UNAVAILABLE');
    });
  }

  receive(result: z.infer<typeof surfaceCopyResultSchema>): void {
    const pending = this.pending;
    if (!pending || result.requestId !== pending.request.requestId || result.tabId !== pending.request.tabId) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (!result.ok) {
      pending.reject(new RemoteSurfaceClipboardError(result.code));
      return;
    }
    if (!result.text) {
      pending.reject(new RemoteSurfaceClipboardError('NO_SELECTION'));
      return;
    }
    pending.resolve(result.text);
  }

  cancel(code: 'COPY_CANCELLED' | 'COPY_TIMEOUT' | 'COPY_UNAVAILABLE' = 'COPY_CANCELLED'): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new RemoteSurfaceClipboardError(code));
  }
}
