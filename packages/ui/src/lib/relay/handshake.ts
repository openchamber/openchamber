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
  | { type: 'established'; channel: EstablishedChannelCrypto; batch: boolean; flowControl: boolean; replyText?: string }
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
  const batch = message.batch === true;
  const flowControl = message.flowControl === true;
  if (message.t === 'ready') {
    return { t: 'ready', v: RELAY_PROTOCOL_VERSION, batch, flowControl };
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
      flowControl,
    };
  }
  return null;
};

const failClosed = (reason: string): HandshakeAction => ({
  type: 'fail',
  closeCode: RelayCloseCode.ChannelFailure,
  reason,
});

interface ClientHandshake {
  helloText: string;
  handleText(raw: string): Promise<HandshakeAction>;
  readonly established: boolean;
}

interface ClientHandshakeOptions {
  batch?: boolean;
  flowControl?: boolean;
}

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
  };
  if (localBatch) hello.batch = true;
  if (options.flowControl !== false) hello.flowControl = true;
  let established = false;
  return {
    helloText: JSON.stringify(hello),
    get established() {
      return established;
    },
    async handleText(raw: string): Promise<HandshakeAction> {
      if (established) {
        const message = parseHandshakeMessage(raw);
        if (message?.t === 'ready') return { type: 'ignore' };
        return failClosed('plaintext frame on established channel');
      }
      const message = parseHandshakeMessage(raw);
      if (message?.t !== 'ready') {
        return { type: 'ignore' };
      }
      const keys = await deriveSessionKeys(ephemeralKeyPair.privateKey, hostPublicKey, nonce);
      established = true;
      return {
        type: 'established',
        batch: localBatch && message.batch === true,
        flowControl: options.flowControl !== false && message.flowControl === true,
        channel: {
          encryptor: createFrameEncryptor(keys.clientToHost),
          decryptor: createFrameDecryptor(keys.hostToClient),
        },
      };
    },
  };
};

interface HostHandshake {
  handleText(raw: string): Promise<HandshakeAction>;
  readonly established: boolean;
}

interface HostHandshakeOptions {
  batch?: boolean;
  flowControl?: boolean;
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
      negotiatedBatch = localBatch && message.batch === true;
      const ready: E2eeReadyMessage = {
        t: 'ready',
        v: RELAY_PROTOCOL_VERSION,
      };
      if (negotiatedBatch) ready.batch = true;
      if (options.flowControl !== false && message.flowControl === true) ready.flowControl = true;
      readyText = JSON.stringify(ready);
      established = true;
      return {
        type: 'established',
        batch: negotiatedBatch,
        flowControl: ready.flowControl === true,
        replyText: readyText,
        channel: {
          encryptor: createFrameEncryptor(keys.hostToClient),
          decryptor: createFrameDecryptor(keys.clientToHost),
        },
      };
    },
  };
};
