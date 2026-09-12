import { z } from 'zod';

const identity = z.string().min(1).max(128);
export const surfaceContextMenuResultSchema = z.object({
  type: z.literal('contextMenuResult'), requestId: identity, tabId: identity, attachmentRequestId: identity,
  status: z.enum(['page-handled', 'menu', 'unavailable']),
}).readonly();

type Attachment = { readonly tabId: string; readonly attachmentRequestId: string };
type ContextMenuResult = z.infer<typeof surfaceContextMenuResultSchema>;
type ContextMenuOutcome = ContextMenuResult['status'] | 'cancelled';
type ContextMenuRequest = Attachment & {
  readonly type: 'contextMenu'; readonly requestId: string; readonly x: number; readonly y: number;
};
type PendingRequest = {
  readonly request: ContextMenuRequest;
  readonly resolve: (outcome: ContextMenuOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class RemoteSurfaceContextMenu {
  private attachment: Attachment | null = null;
  private pending: PendingRequest | null = null;
  private sequence = 0;

  constructor(private readonly send: (request: ContextMenuRequest) => boolean, private readonly timeoutMs = 6_000) {}

  setAttachment(attachment: Attachment | null): void {
    if (attachment?.tabId === this.attachment?.tabId
      && attachment?.attachmentRequestId === this.attachment?.attachmentRequestId) return;
    this.cancel();
    this.attachment = attachment;
  }

  request(point: { readonly x: number; readonly y: number }): Promise<ContextMenuOutcome> {
    this.cancel();
    if (!this.attachment || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return Promise.resolve('unavailable');
    }
    const request: ContextMenuRequest = {
      type: 'contextMenu', ...this.attachment, requestId: `context-${++this.sequence}`, ...point,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.complete('unavailable'), this.timeoutMs);
      this.pending = { request, resolve, timer };
      if (!this.send(request)) this.complete('unavailable');
    });
  }

  receive(result: ContextMenuResult): void {
    const request = this.pending?.request;
    if (!request || result.tabId !== request.tabId || result.requestId !== request.requestId
      || result.attachmentRequestId !== request.attachmentRequestId) return;
    this.complete(result.status);
  }

  cancel(): void { this.complete('cancelled'); }

  private complete(outcome: ContextMenuOutcome): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }
}
