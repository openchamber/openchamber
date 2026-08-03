import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const GUARDIAN_IPC_PROTOCOL = 'openchamber-guardian-ipc-v1';
export const GUARDIAN_IPC_MAX_FRAME_BYTES = 256 * 1024;

const toBase64Url = (value) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
};

const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest();

const canonicalRequest = ({ sequence, id, method, params }) => JSON.stringify([
  GUARDIAN_IPC_PROTOCOL,
  sequence,
  id,
  method,
  params ?? {},
]);

export const createChallenge = () => randomBytes(32).toString('base64url');

export const createClientNonce = () => randomBytes(32).toString('base64url');

export const createHandshakeProof = ({ secret, challenge, clientNonce }) => toBase64Url(
  hmac(secret, `${GUARDIAN_IPC_PROTOCOL}\0handshake\0${challenge}\0${clientNonce}`),
);

export const createSessionKey = ({ secret, challenge, clientNonce }) => hmac(
  secret,
  `${GUARDIAN_IPC_PROTOCOL}\0session\0${challenge}\0${clientNonce}`,
);

export const createRequestMac = ({ sessionKey, sequence, id, method, params }) => toBase64Url(
  hmac(sessionKey, canonicalRequest({ sequence, id, method, params })),
);

export const verifyEncodedMac = (encoded, expected) => {
  const provided = fromBase64Url(encoded);
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } finally {
    provided.fill(0);
  }
};

export const decodeNonce = (value) => {
  const decoded = fromBase64Url(value);
  return decoded?.length === 32 ? decoded : null;
};

export const __test__ = { canonicalRequest, fromBase64Url };
