import type * as vscode from 'vscode';
import type { BridgeResponse } from '../bridge-types';

const MESSAGE_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

const createMessageId = (): string =>
  `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Reliable webview postMessage with ack + retry.
 * Used by all OpenChamber webview hosts so delivery failures are consistent.
 */
export class MessageDelivery {
  private readonly pending = new Set<string>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(private readonly getWebview: () => vscode.Webview | undefined) {}

  confirm(messageId: string): void {
    this.pending.delete(messageId);
    const timeout = this.timeouts.get(messageId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(messageId);
    }
  }

  clear(): void {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.pending.clear();
  }

  async send(response: BridgeResponse, retryCount = 0, messageId?: string): Promise<boolean> {
    const webview = this.getWebview();
    if (!webview) {
      return false;
    }

    const pendingMessageId = messageId ?? createMessageId();
    const existingTimeout = this.timeouts.get(pendingMessageId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.timeouts.delete(pendingMessageId);
    }

    try {
      const delivered = await webview.postMessage({
        ...response,
        _msgId: pendingMessageId,
      });
      if (!delivered) {
        throw new Error('Webview rejected message delivery');
      }

      this.pending.add(pendingMessageId);

      const timeout = setTimeout(() => {
        if (!this.pending.has(pendingMessageId)) {
          return;
        }

        if (retryCount < MAX_RETRIES) {
          console.warn(
            `[Message Retry] Message ${pendingMessageId} not confirmed, retrying (${retryCount + 1}/${MAX_RETRIES})...`,
          );
          void this.send(response, retryCount + 1, pendingMessageId);
          return;
        }

        console.error(`[Message Retry] Message ${pendingMessageId} failed after ${MAX_RETRIES} retries`);
        this.pending.delete(pendingMessageId);
        this.timeouts.delete(pendingMessageId);
      }, MESSAGE_TIMEOUT_MS);

      this.timeouts.set(pendingMessageId, timeout);
      return true;
    } catch (error) {
      console.error('[Message Retry] Failed to send message:', error);

      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1)));
        return this.send(response, retryCount + 1, pendingMessageId);
      }

      this.pending.delete(pendingMessageId);
      this.timeouts.delete(pendingMessageId);
      return false;
    }
  }
}
