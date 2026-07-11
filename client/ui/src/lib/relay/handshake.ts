// E2EE handshake state machines (Layer 2 of the protocol spec).
// Transport-agnostic: callers feed inbound frames in and deliver the returned
// outbound frames; text frames are plaintext handshake JSON, binary frames are
// encrypted traffic. Wire-up to actual WebSockets happens in the host client
// (packages/web/server/lib/relay) and the tunnel client (Phase 3).
//
// Client (initiator): sends `hello` with an ephemeral public key + nonce,
// waits for `ready`. Host (responder): waits for `hello`, derives session
// keys with its long-lived encryption private key, replies `ready`.
//
// Fail-closed rules (adopted from the spec):
// - a repeated identical `hello` re-sends `ready` (client retry race);
// - a `hello` with a DIFFERENT key on an established channel is a rekey
//   attack -> close 1008, never rekey in place;
// - plaintext after `ready`, or any decrypt failure -> close 1011.

import {
  createFrameDecryptor,
  createFrameEncryptor,
  base64UrlToBytes,
  bytesToBase64Url,
  deriveSessionKeys,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  generateHandshakeNonce,
  importEcdhPublicKey,
  publicKeyJwkFingerprint,
  type FrameDecryptor,
  type FrameEncryptor,
} from './crypto';
import {
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  type E2eeHelloMessage,
  type E2eeReadyMessage,
} from './protocol';

export interface EstablishedChannelCrypto {
  encryptor: FrameEncryptor;
  decryptor: FrameDecryptor;
}

export type HandshakeAction =
  | { type: 'send-text'; text: string }
  // `replyText`, when present, must be sent to the peer before any encrypted frame.
  // `batch` is the negotiated frame-batching capability for the session.
  | { type: 'established'; channel: EstablishedChannelCrypto; batch: boolean; replyText?: string }
  | { type: 'ignore' }
  | { type: 'fail'; closeCode: number; reason: string };

const parseHandshakeMessage = (raw: string): E2eeHelloMessage | E2eeReadyMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.v !== RELAY_PROTOCOL_VERSION) return null;
  // Unknown/missing capability flag = false = legacy behavior.
  const batch = message.batch === true;
  if (message.t === 'ready') {
    return { t: 'ready', v: RELAY_PROTOCOL_VERSION, batch };
  }
  if (
    message.t === 'hello' &&
    typeof message.nonce === 'string' &&
    typeof message.clientPubJwk === 'object' &&
    message.clientPubJwk !== null
  ) {
    return {
      t: 'hello',
      v: RELAY_PROTOCOL_VERSION,
      clientPubJwk: message.clientPubJwk as JsonWebKey,
      nonce: message.nonce,
      batch,
    };
  }
  return null;
};

const failClosed = (reason: string): HandshakeAction => ({
  type: 'fail',
  closeCode: RelayCloseCode.ChannelFailure,
  reason,
});

export interface ClientHandshake {
  /** The `hello` text frame. Send on open and re-send on a retry interval until established. */
  helloText: string;
  /** Feed every inbound text frame received before the channel is established. */
  handleText(raw: string): Promise<HandshakeAction>;
  readonly established: boolean;
}

export interface ClientHandshakeOptions {
  /** Advertise frame batching. Default true; set false to force legacy behavior. */
  batch?: boolean;
}

// hostEncPubJwk comes from the pairing offer (QR / deep link) and is the trust
// anchor: only the real host can derive the same session keys.
export const createClientHandshake = async (
  hostEncPubJwk: JsonWebKey,
  options: ClientHandshakeOptions = {},
): Promise<ClientHandshake> => {
  const localBatch = options.batch !== false;
  const hostPublicKey = await importEcdhPublicKey(hostEncPubJwk);
  const ephemeralKeyPair = await generateEcdhKeyPair();
  const nonce = generateHandshakeNonce();
  const hello: E2eeHelloMessage = {
    t: 'hello',
    v: RELAY_PROTOCOL_VERSION,
    clientPubJwk: await exportPublicKeyJwk(ephemeralKeyPair.publicKey),
    nonce: bytesToBase64Url(nonce),
    ...(localBatch ? { batch: true } : {}),
  };
  let established = false;
  return {
    helloText: JSON.stringify(hello),
    get established() {
      return established;
    },
    async handleText(raw: string): Promise<HandshakeAction> {
      if (established) {
        // The host answers every retried `hello` with `ready`, so a duplicate
        // `ready` after establishment is protocol-legal (first-connect latency
        // exceeding the hello retry interval). Any other plaintext fails closed.
        const message = parseHandshakeMessage(raw);
        if (message?.t === 'ready') return { type: 'ignore' };
        return failClosed('plaintext frame on established channel');
      }
      const message = parseHandshakeMessage(raw);
      if (message?.t !== 'ready') {
        // Not established yet: tolerate unknown plaintext (relay control noise,
        // late frames) rather than tearing down a connection that may recover.
        return { type: 'ignore' };
      }
      const keys = await deriveSessionKeys(ephemeralKeyPair.privateKey, hostPublicKey, nonce);
      established = true;
      return {
        type: 'established',
        // Batching runs only if both peers advertised it.
        batch: localBatch && message.batch === true,
        channel: {
          encryptor: createFrameEncryptor(keys.clientToHost),
          decryptor: createFrameDecryptor(keys.hostToClient),
        },
      };
    },
  };
};

export interface HostHandshake {
  /** Feed every inbound text frame. */
  handleText(raw: string): Promise<HandshakeAction>;
  readonly established: boolean;
}

export interface HostHandshakeOptions {
  /** Support frame batching. Default true; set false to force legacy behavior. */
  batch?: boolean;
}

export const createHostHandshake = (
  hostEncPrivateKey: CryptoKey,
  options: HostHandshakeOptions = {},
): HostHandshake => {
  const localBatch = options.batch !== false;
  let established = false;
  let acceptedClientKeyFingerprint: string | null = null;
  let readyText: string | null = null;
  let negotiatedBatch = false;
  return {
    get established() {
      return established;
    },
    async handleText(raw: string): Promise<HandshakeAction> {
      const message = parseHandshakeMessage(raw);
      if (message?.t !== 'hello') {
        if (established) {
          return failClosed('plaintext frame on established channel');
        }
        return { type: 'ignore' };
      }
      const fingerprint = publicKeyJwkFingerprint(message.clientPubJwk);
      if (acceptedClientKeyFingerprint !== null) {
        if (fingerprint === acceptedClientKeyFingerprint && readyText !== null) {
          // Client retried `hello` before our `ready` arrived — answer again.
          return { type: 'send-text', text: readyText };
        }
        return {
          type: 'fail',
          closeCode: RelayCloseCode.RekeyMismatch,
          reason: 'rekey mismatch',
        };
      }
      let clientPublicKey: CryptoKey;
      let nonce: Uint8Array;
      try {
        clientPublicKey = await importEcdhPublicKey(message.clientPubJwk);
        nonce = base64UrlToBytes(message.nonce);
      } catch {
        return failClosed('malformed hello');
      }
      let keys;
      try {
        keys = await deriveSessionKeys(hostEncPrivateKey, clientPublicKey, nonce);
      } catch {
        return failClosed('key derivation failed');
      }
      acceptedClientKeyFingerprint = fingerprint;
      // Batching runs only if both peers advertised it.
      negotiatedBatch = localBatch && message.batch === true;
      const ready: E2eeReadyMessage = {
        t: 'ready',
        v: RELAY_PROTOCOL_VERSION,
        ...(negotiatedBatch ? { batch: true } : {}),
      };
      readyText = JSON.stringify(ready);
      established = true;
      return {
        type: 'established',
        batch: negotiatedBatch,
        replyText: readyText,
        channel: {
          encryptor: createFrameEncryptor(keys.hostToClient),
          decryptor: createFrameDecryptor(keys.clientToHost),
        },
      };
    },
  };
};
