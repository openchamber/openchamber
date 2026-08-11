import type { BridgeResponse } from './bridge';

export type MessageRetryTransport = {
  postMessage(message: unknown): Thenable<boolean> | boolean | PromiseLike<boolean>;
};

export type MessageRetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  onRetry?: (messageId: string, retryCount: number, maxRetries: number) => void;
  onExhausted?: (messageId: string, maxRetries: number) => void;
  onSendError?: (error: unknown) => void;
};

/**
 * Reliable webview postMessage with ack tracking and timed retries.
 * Used by the chat sidebar where delivery confirmation matters for bridge replies.
 */
export class WebviewMessageRetryQueue {
  private readonly pendingMessages = new Set<string>();
  private readonly messageTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onRetry?: MessageRetryOptions['onRetry'];
  private readonly onExhausted?: MessageRetryOptions['onExhausted'];
  private readonly onSendError?: MessageRetryOptions['onSendError'];

  constructor(
    private readonly getTransport: () => MessageRetryTransport | undefined,
    options: MessageRetryOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
    this.onRetry = options.onRetry;
    this.onExhausted = options.onExhausted;
    this.onSendError = options.onSendError;
  }

  public clear(): void {
    for (const timeout of this.messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.messageTimeouts.clear();
    this.pendingMessages.clear();
  }

  public confirm(messageId: string): void {
    this.pendingMessages.delete(messageId);
    const timeout = this.messageTimeouts.get(messageId);
    if (timeout) {
      clearTimeout(timeout);
      this.messageTimeouts.delete(messageId);
    }
  }

  public async send(response: BridgeResponse, retryCount = 0, messageId?: string): Promise<boolean> {
    const transport = this.getTransport();
    if (!transport) {
      return false;
    }

    const pendingMessageId = messageId ?? this.createMessageId();
    const existingTimeout = this.messageTimeouts.get(pendingMessageId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.messageTimeouts.delete(pendingMessageId);
    }

    try {
      const delivered = await transport.postMessage({
        ...response,
        _msgId: pendingMessageId,
      });
      if (!delivered) {
        throw new Error('Webview rejected message delivery');
      }

      this.pendingMessages.add(pendingMessageId);

      const timeout = setTimeout(() => {
        if (!this.pendingMessages.has(pendingMessageId)) {
          return;
        }

        if (retryCount < this.maxRetries) {
          this.onRetry?.(pendingMessageId, retryCount + 1, this.maxRetries);
          void this.send(response, retryCount + 1, pendingMessageId);
          return;
        }

        this.onExhausted?.(pendingMessageId, this.maxRetries);
        this.pendingMessages.delete(pendingMessageId);
        this.messageTimeouts.delete(pendingMessageId);
      }, this.timeoutMs);

      this.messageTimeouts.set(pendingMessageId, timeout);
      return true;
    } catch (error) {
      this.onSendError?.(error);

      if (retryCount < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1)));
        return this.send(response, retryCount + 1, pendingMessageId);
      }

      this.pendingMessages.delete(pendingMessageId);
      this.messageTimeouts.delete(pendingMessageId);
      return false;
    }
  }

  private createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
