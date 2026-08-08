import * as vscode from 'vscode';
import type { BridgeRequest, BridgeResponse, BridgeContext } from '../bridge-types';
import { handleBridgeMessage } from '../bridge';
import type { OpenCodeManager } from '../opencode';
import type { MessageDelivery } from './messageDelivery';
import type { SseProxySession } from './sseProxySession';

export type BridgeAckMessage = { type: 'bridge:ack'; _msgId: string };
export type IncomingHostMessage = (BridgeRequest & { _msgId?: string }) | BridgeAckMessage;

const isBridgeAck = (message: IncomingHostMessage): message is BridgeAckMessage =>
  message.type === 'bridge:ack' && typeof (message as BridgeAckMessage)._msgId === 'string';

type HandleHostMessageOptions = {
  message: IncomingHostMessage;
  manager?: OpenCodeManager;
  context: vscode.ExtensionContext;
  delivery: MessageDelivery;
  sse: SseProxySession;
  /** Optional pre-bridge handler; return true if consumed. */
  beforeBridge?: (message: BridgeRequest) => Promise<boolean> | boolean;
  send?: (response: BridgeResponse) => Promise<void> | void;
};

/**
 * Shared webview → extension message dispatch for SSE, restart, and bridge routes.
 */
export async function handleHostWebviewMessage(options: HandleHostMessageOptions): Promise<void> {
  const { message, manager, context, delivery, sse, beforeBridge, send } = options;

  if (isBridgeAck(message)) {
    delivery.confirm(message._msgId);
    return;
  }

  if (!('id' in message) || typeof message.id !== 'string') {
    return;
  }

  const request = message as BridgeRequest;
  const respond = async (response: BridgeResponse) => {
    if (send) {
      await send(response);
      return;
    }
    await delivery.send(response);
  };

  if (request.type === 'restartApi') {
    await manager?.restart();
    return;
  }

  if (request.type === 'api:sse:start') {
    await respond(await sse.start(request));
    return;
  }

  if (request.type === 'api:sse:stop') {
    await respond(await sse.stop(request));
    return;
  }

  if (beforeBridge && (await beforeBridge(request))) {
    return;
  }

  const bridgeCtx: BridgeContext = { manager, context };
  const response = await handleBridgeMessage(request, bridgeCtx);
  await respond(response);

  if (request.type === 'api:config/settings:save' && response.success) {
    void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
  }
}
