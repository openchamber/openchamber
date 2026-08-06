import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER = 'X-OpenChamber-Managed-Health-Challenge';
export const MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER = 'X-OpenChamber-Managed-Health-Incarnation';
export const MANAGED_OPENCODE_HEALTH_OWNER_HEADER = 'X-OpenChamber-Managed-Health-Owner';
export const MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER = 'X-OpenChamber-Managed-Health-Runtime';
export const MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER = 'X-OpenChamber-Managed-Health-Launch-Fingerprint';
export const MANAGED_OPENCODE_HEALTH_PORT_HEADER = 'X-OpenChamber-Managed-Health-Port';
export const MANAGED_OPENCODE_HEALTH_PROOF_HEADER = 'X-OpenChamber-Managed-Health-Proof';

const HEALTH_PROOF_DOMAIN = 'openchamber/managed-opencode-handoff/v2/health-proof';
const HEALTH_CHALLENGE_BYTES = 32;
const HEALTH_PROOF_BYTES = 32;

const isSafeIdentityPart = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 4096
  && !/[\x00-\x1F\x7F]/.test(value);

const isSafePassword = (value) => typeof value === 'string'
  && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 64 * 1024
  && !/[\x00-\x1F\x7F]/.test(value);

const isCanonicalBase64Url = (value, bytes) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
};

const normalizeHealthProofInput = ({
  password,
  challenge,
  incarnation,
  ownerInstanceId,
  runtimeIdentity,
  launchFingerprint,
  port,
} = {}) => {
  if (!isSafePassword(password)
    || !isCanonicalBase64Url(challenge, HEALTH_CHALLENGE_BYTES)
    || !isSafeIdentityPart(incarnation)
    || !isSafeIdentityPart(ownerInstanceId)
    || !isSafeIdentityPart(runtimeIdentity)
    || !isSafeIdentityPart(launchFingerprint)
    || !Number.isSafeInteger(port)
    || port <= 0
    || port > 65535) {
    return null;
  }
  return {
    password,
    challenge,
    incarnation,
    ownerInstanceId,
    runtimeIdentity,
    launchFingerprint,
    port,
  };
};

const canonicalizeHealthProofInput = ({
  challenge,
  incarnation,
  ownerInstanceId,
  runtimeIdentity,
  launchFingerprint,
  port,
}) =>
  Buffer.from(JSON.stringify([
    HEALTH_PROOF_DOMAIN,
    challenge,
    incarnation,
    ownerInstanceId,
    runtimeIdentity,
    launchFingerprint,
    port,
  ]), 'utf8');

/** Create a one-request challenge. It is never persisted or logged. */
export const createManagedOpenCodeHealthChallenge = () =>
  randomBytes(HEALTH_CHALLENGE_BYTES).toString('base64url');

/**
 * Create the proof expected from a managed child before Basic Auth is sent.
 * The child and guardian both already possess the managed password; the
 * challenge and launch tuple bind the proof to this particular health probe.
 */
export const createManagedOpenCodeHealthProof = (input = {}) => {
  const normalized = normalizeHealthProofInput(input);
  if (!normalized) throw new TypeError('Invalid managed OpenCode health proof input');

  let key;
  let message;
  let proof;
  try {
    key = Buffer.from(normalized.password, 'utf8');
    message = canonicalizeHealthProofInput(normalized);
    proof = createHmac('sha256', key).update(message).digest();
    return proof.toString('base64url');
  } finally {
    key?.fill(0);
    message?.fill(0);
    proof?.fill(0);
  }
};

/** Verify a child proof without exposing any credential material. */
export const verifyManagedOpenCodeHealthProof = (input = {}, providedProof) => {
  if (!isCanonicalBase64Url(providedProof, HEALTH_PROOF_BYTES)) return false;
  let expected;
  let provided;
  try {
    expected = Buffer.from(createManagedOpenCodeHealthProof(input), 'base64url');
    provided = Buffer.from(providedProof, 'base64url');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  } finally {
    expected?.fill(0);
    provided?.fill(0);
  }
};
