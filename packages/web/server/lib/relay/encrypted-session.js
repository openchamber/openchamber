import { WebSocket } from 'ws';

import { RelayCloseCode, createHostHandshake } from './e2ee.js';
import { createOutboundFrameBatcher, decodeFrameBatch } from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';

/**
 * Owns one transport-neutral responder handshake and encrypted tunnel session.
 * The caller retains outer-socket lifecycle and admission accounting ownership.
 *
 * @param {{
 *   socket: WebSocket,
 *   connectionId: string,
 *   hostEncPrivateKey: CryptoKey,
 *   getLocalPort: () => number,
 *   isActive?: () => boolean,
 *   onActivity?: () => void,
 *   onEstablished?: () => void,
 *   onFailure: (closeCode: number, reason: string) => void,
 *   logger?: Pick<Console, 'warn'>,
 *   batch?: boolean,
 *   failOnIgnoredHandshake?: boolean,
 *   batchWindowMs: number,
 *   tunnelOptions?: object,
 * }} options
 */
export const createEncryptedSession = ({
  socket,
  connectionId,
  hostEncPrivateKey,
  getLocalPort,
  isActive = () => true,
  onActivity,
  onEstablished,
  onFailure,
  logger = console,
  batch = true,
  failOnIgnoredHandshake = false,
  batchWindowMs,
  tunnelOptions = {},
}) => {
  const handshake = createHostHandshake(hostEncPrivateKey, { batch });
  let channel = null;
  let tunnel = null;
  let batcher = null;
  let batchNegotiated = false;
  let processing = Promise.resolve();
  let sendChain = Promise.resolve();
  let closed = false;

  const fail = (closeCode, reason) => {
    if (closed) return;
    closed = true;
    batcher?.dispose();
    tunnel?.close();
    onFailure(closeCode, reason);
  };

  const sendEncryptedPlaintext = (plaintext) => {
    sendChain = sendChain
      .then(async () => {
        if (closed || !isActive() || socket.readyState !== WebSocket.OPEN || !channel) return;
        const encrypted = await channel.encryptor.encrypt(plaintext);
        socket.send(encrypted, { binary: true });
      })
      .catch((error) => {
        logger.warn(`[Relay] encrypted session send failed: ${error?.message ?? error}`);
      });
  };

  const handleMessage = async (data, isBinary) => {
    if (closed || !isActive()) return;
    onActivity?.();

    if (!isBinary) {
      const action = await handshake.handleText(data.toString('utf8'));
      if (action.type === 'ignore' && failOnIgnoredHandshake) {
        fail(RelayCloseCode.ChannelFailure, 'invalid handshake');
      } else if (action.type === 'send-text') socket.send(action.text);
      else if (action.type === 'established') {
        channel = action.channel;
        batchNegotiated = action.batch === true;
        batcher = batchNegotiated
          ? createOutboundFrameBatcher({ windowMs: batchWindowMs, sendBatch: sendEncryptedPlaintext })
          : null;
        tunnel = createTunnelHost({
          connectionId,
          getLocalPort,
          getBufferedAmount: () => socket.bufferedAmount,
          sendFrame: (plaintextFrame) => {
            if (closed || !isActive() || socket.readyState !== WebSocket.OPEN) return;
            if (batcher) batcher.enqueue(plaintextFrame);
            else sendEncryptedPlaintext(plaintextFrame);
          },
          onProtocolFailure: () => fail(RelayCloseCode.ChannelFailure, 'protocol failure'),
          ...tunnelOptions,
        });
        onEstablished?.();
        if (action.replyText) socket.send(action.replyText);
      } else if (action.type === 'fail') fail(action.closeCode, action.reason);
      return;
    }

    if (!channel || !tunnel) {
      fail(RelayCloseCode.ChannelFailure, 'binary frame before handshake');
      return;
    }
    let plaintext;
    try {
      plaintext = await channel.decryptor.decrypt(new Uint8Array(data));
    } catch {
      fail(RelayCloseCode.ChannelFailure, 'frame decryption failed');
      return;
    }
    try {
      const frames = batchNegotiated ? decodeFrameBatch(plaintext) : [plaintext];
      for (const frame of frames) {
        if (closed || !isActive()) return;
        await tunnel.handleFrame(frame);
      }
    } catch (error) {
      logger.warn(`[Relay] tunnel frame handling failed: ${error?.message ?? error}`);
      fail(RelayCloseCode.ChannelFailure, 'protocol failure');
    }
  };

  const receive = (data, isBinary) => {
    processing = processing
      .then(() => handleMessage(data, isBinary))
      .catch((error) => {
        logger.warn(`[Relay] encrypted session message failed: ${error?.message ?? error}`);
        fail(RelayCloseCode.ChannelFailure, 'internal error');
      });
  };

  return {
    receive,
    close() {
      if (closed) return;
      closed = true;
      batcher?.dispose();
      tunnel?.close();
    },
    get tunnel() {
      return tunnel;
    },
  };
};
