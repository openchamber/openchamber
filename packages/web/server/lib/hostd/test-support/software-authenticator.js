// A software WebAuthn authenticator for tests and for the live proof in the harness: one ES256
// credential that signs assertions the way a browser relays them. Never used by the product.
import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

/** A CBOR-encoded COSE EC2 P-256 public key, the form WebAuthn registration stores. */
const coseKey = (publicKey) => {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
};

/** A CBOR byte string header and the bytes, for lengths below 65536. */
const cborBytes = (bytes) => Buffer.concat([
  bytes.length < 24 ? Buffer.from([0x40 + bytes.length]) : bytes.length < 256 ? Buffer.from([0x58, bytes.length]) : Buffer.from([0x59, bytes.length >> 8, bytes.length & 0xff]),
  bytes,
]);
const cborText = (text) => Buffer.concat([Buffer.from([0x60 + text.length]), Buffer.from(text)]);

/**
 * `credential` is what OpenChamber's passkey store keeps; `assert` answers one challenge, and
 * `register` makes the attestation (format none) of a passkey registration.
 */
export function authenticator(rpID, saved = null) {
  const privateKey = saved ? crypto.createPrivateKey(saved.privateKey) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const publicKey = crypto.createPublicKey(privateKey);
  const id = saved?.id ?? crypto.randomBytes(16).toString('base64url');
  let counter = saved?.counter ?? 0;
  return {
    /** What `authenticator(rpID, saved)` takes back, for a harness that runs in several steps. */
    save: () => ({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), id, counter }),
    register(challenge, origin) {
      const credentialId = Buffer.from(id, 'base64url');
      const authenticatorData = Buffer.concat([
        sha256(rpID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, coseKey(publicKey),
      ]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authenticatorData),
      ]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      return {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },
    credential: { id, publicKey: coseKey(publicKey).toString('base64url'), rpID },
    assert(challenge, origin, { userVerified = true, count = true, credentialId = id } = {}) {
      if (count) counter += 1;
      const authenticatorData = Buffer.alloc(37);
      sha256(rpID).copy(authenticatorData, 0);
      authenticatorData[32] = userVerified ? 0x05 : 0x01;
      authenticatorData.writeUInt32BE(counter, 33);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}
