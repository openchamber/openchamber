// Passkeys that may activate a root space, and the one-time challenges for each activation.
// Runs as root, in hostd and in its root command. A person with root approves a passkey in three
// steps: the root command prints a code; the person proves a passkey in OpenChamber with that code;
// the root command shows that passkey's fingerprint, and the person confirms it there. After that,
// every create and start of a root space needs a fresh assertion from an approved passkey, made at
// the exact origin it was approved at, for that operation on that space.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// How long the code the root command printed stays valid, and how long a challenge does.
const APPROVAL_TTL_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
// A code is tried at most this often before the pending approval is dropped.
const MAX_CODE_ATTEMPTS = 5;
const MAX_CREDENTIALS = 16;
const MAX_PENDING_CHALLENGES = 32;
// No 0, O, 1 or I: the code is read off a terminal and typed into OpenChamber.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1366}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{16,2048}$/;
const RP_ID_PATTERN = /^[a-z0-9.-]{1,253}$|^\[?[0-9a-f:]+\]?$/;
const SPACE_ID_PATTERN = /^[0-9a-f]{12}$/;
const SPEC_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set(['create', 'start']);
const MAX_LABEL_LENGTH = 120;
// The state is written by hostd and by the root command, so writes take a lock file.
const LOCK_WAIT_MS = 10_000;
const LOCK_PAUSE_MS = 50;

export class RootPasskeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new RootPasskeyError(code, message);
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

const sameText = (left, right) => crypto.timingSafeEqual(sha256(String(left)), sha256(String(right)));

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const writeRootJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** One writer at a time across hostd and the root command; a lock left by a dead process is taken over. */
async function withFileLock(lockFile, work) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => ''));
      if (!(Number.isSafeInteger(owner) && owner > 0 && processAlive(owner))) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) refuse('root_passkeys_busy', 'Another process is changing the root passkeys. Try again');
      await pause(LOCK_PAUSE_MS);
    }
  }
  try {
    return await work();
  } finally {
    await fs.rm(lockFile, { force: true });
  }
}

/**
 * The origin and challenge a browser put into an assertion, as text, empty when it names none.
 * Read before the signature is checked only to decide what to check it against; the signature
 * covers them.
 */
const clientDataOf = (response) => {
  try {
    const parsed = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON ?? ''), 'base64url').toString('utf8'));
    return { origin: String(parsed?.origin ?? ''), challenge: String(parsed?.challenge ?? '') };
  } catch {
    return { origin: '', challenge: '' };
  }
};

/**
 * An origin passkeys may be approved at: https, or plain http on this machine's loopback, which
 * browsers treat as secure. Its host must be the RP ID or a name under it, as browsers require.
 */
const approvableOrigin = (origin, rpID) => {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
  return host === rpID || host.endsWith(`.${rpID}`);
};

/** What the person compares between OpenChamber and the root terminal before confirming. */
export const passkeyFingerprint = ({ id, publicKey }) => {
  const hex = sha256(`${id}\n${publicKey}`).toString('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g).join('-');
};

const credentialView = ({ id, publicKey, label, rpID, origin, approvedAt }) => ({ id, label, rpID, origin, approvedAt, fingerprint: passkeyFingerprint({ id, publicKey }) });

/**
 * `stateFile` holds the approved passkeys, `pendingFile` the approval the root command started.
 * Both live in hostd's root-only state directory. `verify` is `verifyAuthenticationResponse`
 * of @simplewebauthn/server; injectable so tests can count calls.
 */
export function createRootPasskeys({ stateFile, pendingFile, verify, now = Date.now, randomBytes = crypto.randomBytes }) {
  // Challenge (base64url) -> { op, id, specHash, expiresAt }. Memory only: a hostd restart forgets
  // every challenge, and the next activation asks for a new one.
  const challenges = new Map();
  const lockFile = `${stateFile}.lock`;

  const readState = async () => {
    const state = await readJson(stateFile);
    return Array.isArray(state?.credentials) ? state : { version: 1, credentials: [] };
  };
  const updateState = (change) => withFileLock(lockFile, async () => {
    const state = await readState();
    const result = await change(state);
    await writeRootJson(stateFile, state);
    return result;
  });

  const newChallenge = () => randomBytes(32).toString('base64url');

  const pruneChallenges = () => {
    for (const [challenge, entry] of challenges) {
      if (entry.expiresAt <= now()) challenges.delete(challenge);
    }
  };

  /** The approved passkeys, without their keys. */
  const list = async () => (await readState()).credentials.map(credentialView);

  /** Root command only: starts an approval and returns the code to type into OpenChamber. */
  const beginApproval = () => withFileLock(lockFile, async () => {
    const characters = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    const code = `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
    const expiresAt = now() + APPROVAL_TTL_MS;
    await writeRootJson(pendingFile, { version: 1, codeHash: sha256(code).toString('hex'), expiresAt, attempts: 0, challenge: null, candidate: null });
    return { code, expiresAt };
  });

  /** The pending approval for this code, counting a wrong code against it. Called under the lock. */
  const pendingFor = async (code) => {
    if (!CODE_PATTERN.test(String(code ?? ''))) refuse('approval_code_invalid', 'The approval code is two groups of four letters and digits, as the root command printed it');
    const pending = await readJson(pendingFile);
    if (!pending || pending.version !== 1) refuse('approval_not_started', 'No approval is waiting. Run the root command that approves a passkey, then enter its code');
    if (pending.expiresAt <= now()) {
      await fs.rm(pendingFile, { force: true });
      refuse('approval_expired', 'The approval code expired. Run the root command again');
    }
    if (!sameText(pending.codeHash, sha256(code).toString('hex'))) {
      const attempts = (pending.attempts ?? 0) + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) await fs.rm(pendingFile, { force: true });
      else await writeRootJson(pendingFile, { ...pending, attempts });
      refuse('approval_code_wrong', 'The approval code does not match');
    }
    if (pending.candidate) refuse('approval_awaiting_confirmation', 'A passkey is waiting for confirmation on the server\'s terminal');
    return pending;
  };

  /** A challenge for the approval ceremony, bound to the pending approval. */
  const approvalChallenge = ({ code }) => withFileLock(lockFile, async () => {
    const pending = await pendingFor(code);
    const challenge = newChallenge();
    await writeRootJson(pendingFile, { ...pending, challenge, challengeExpiresAt: now() + CHALLENGE_TTL_MS });
    return { challenge };
  });

  /**
   * Proves possession of the passkey OpenChamber names, at the origin the browser reports, and puts
   * it before the root command for confirmation. A failed proof drops the pending approval.
   */
  const completeApproval = ({ code, credential, response, label }) => withFileLock(lockFile, async () => {
    const pending = await pendingFor(code);
    const drop = () => fs.rm(pendingFile, { force: true });
    if (!pending.challenge || !(pending.challengeExpiresAt > now())) {
      await drop();
      refuse('approval_challenge_missing', 'Ask for a new challenge with the code, then confirm the passkey');
    }
    const id = String(credential?.id ?? '');
    const publicKey = String(credential?.publicKey ?? '');
    const rpID = String(credential?.rpID ?? '').toLowerCase();
    if (!CREDENTIAL_ID_PATTERN.test(id) || !PUBLIC_KEY_PATTERN.test(publicKey) || !RP_ID_PATTERN.test(rpID)) {
      await drop();
      refuse('approval_credential_invalid', 'The passkey to approve is not a passkey record');
    }
    if (response?.id !== id) {
      await drop();
      refuse('approval_credential_mismatch', 'The assertion was made with another passkey');
    }
    const { origin } = clientDataOf(response);
    if (!approvableOrigin(origin, rpID)) {
      await drop();
      refuse('approval_origin_refused', 'Passkeys are approved only at an https origin, or http on this machine, whose host is the passkey\'s RP ID');
    }
    let verification = null;
    try {
      verification = await verify({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id, publicKey: Buffer.from(publicKey, 'base64url'), counter: 0 },
        requireUserVerification: true,
      });
    } catch {
      verification = null;
    }
    if (!verification?.verified) {
      await drop();
      refuse('approval_assertion_refused', 'The passkey did not confirm');
    }
    const candidate = {
      id,
      publicKey,
      rpID,
      origin,
      counter: verification.authenticationInfo?.newCounter ?? 0,
      label: String(label ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH) || 'Passkey',
    };
    await writeRootJson(pendingFile, { ...pending, challenge: null, candidate });
    return { awaitingConfirmation: true, fingerprint: passkeyFingerprint(candidate), label: candidate.label, origin };
  });

  /** Root command only: the passkey waiting for confirmation, or null. */
  const pendingCandidate = async () => {
    const pending = await readJson(pendingFile);
    if (!pending?.candidate || !(pending.expiresAt > now())) return null;
    const { id, publicKey, label, rpID, origin } = pending.candidate;
    return { id, label, rpID, origin, fingerprint: passkeyFingerprint({ id, publicKey }) };
  };

  /** Root command only: approves the waiting passkey, named by its fingerprint. */
  const confirmApproval = ({ fingerprint }) => withFileLock(lockFile, async () => {
    const pending = await readJson(pendingFile);
    await fs.rm(pendingFile, { force: true });
    if (!pending?.candidate || !(pending.expiresAt > now())) refuse('approval_not_waiting', 'No passkey is waiting for confirmation');
    if (passkeyFingerprint(pending.candidate) !== fingerprint) refuse('approval_fingerprint_changed', 'The waiting passkey is not the one shown');
    const state = await readState();
    const others = state.credentials.filter((entry) => entry.id !== pending.candidate.id);
    if (others.length >= MAX_CREDENTIALS) refuse('approval_limit', `At most ${MAX_CREDENTIALS} passkeys can activate root spaces`);
    const approved = { ...pending.candidate, approvedAt: now() };
    state.credentials = [...others, approved];
    await writeRootJson(stateFile, state);
    return credentialView(approved);
  });

  /** Root command only: drops the pending approval, with or without a passkey waiting. */
  const cancelApproval = () => withFileLock(lockFile, () => fs.rm(pendingFile, { force: true }));

  /** Root command only: withdraws a passkey's approval. */
  const revoke = (id) => updateState((state) => {
    const before = state.credentials.length;
    state.credentials = state.credentials.filter((entry) => entry.id !== id);
    return { removed: before - state.credentials.length };
  });

  const requireActivation = ({ op, id, specHash }) => {
    if (!OPERATIONS.has(op)) refuse('root_activation_invalid', 'A root space is activated by a create or a start');
    if (!SPACE_ID_PATTERN.test(String(id ?? ''))) refuse('root_activation_invalid', 'A space id is 12 lowercase hex characters');
    if (!SPEC_HASH_PATTERN.test(String(specHash ?? ''))) refuse('root_activation_invalid', 'The activation names no space specification');
  };

  /**
   * A challenge for one activation: this operation, on this space, with this specification. The
   * answer lists the approved passkeys, so the browser can offer the right one and say which
   * origin the activation must come from.
   */
  const activationOptions = async ({ op, id, specHash }) => {
    requireActivation({ op, id, specHash });
    const credentials = (await readState()).credentials;
    if (credentials.length === 0) refuse('root_passkey_not_approved', 'No passkey is approved for root spaces. Run the root command that approves one first');
    pruneChallenges();
    if (challenges.size >= MAX_PENDING_CHALLENGES) refuse('root_activation_busy', 'Too many root activations are waiting. Try again in a few minutes');
    const challenge = newChallenge();
    const expiresAt = now() + CHALLENGE_TTL_MS;
    challenges.set(challenge, { op, id, specHash, expiresAt });
    return { challenge, expiresAt, credentials: credentials.map(credentialView) };
  };

  /**
   * Checks the assertion for one activation and consumes its challenge first, so an assertion
   * works once whether it is accepted or not.
   */
  const verifyActivation = async ({ op, id, specHash, response }) => {
    requireActivation({ op, id, specHash });
    const { challenge } = clientDataOf(response);
    const entry = challenges.get(challenge);
    challenges.delete(challenge);
    if (!entry || entry.expiresAt <= now()) refuse('root_activation_challenge_unknown', 'The confirmation expired or was already used. Confirm again');
    if (entry.op !== op || entry.id !== id || entry.specHash !== specHash) refuse('root_activation_mismatch', 'The confirmation was made for another operation');
    const credential = (await readState()).credentials.find((candidate) => candidate.id === response?.id);
    if (!credential) refuse('root_passkey_not_approved', 'This passkey is not approved for root spaces');
    let verification = null;
    try {
      verification = await verify({
        response,
        expectedChallenge: challenge,
        expectedOrigin: credential.origin,
        expectedRPID: credential.rpID,
        credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter ?? 0 },
        requireUserVerification: true,
      });
    } catch {
      verification = null;
    }
    if (!verification?.verified) refuse('root_activation_refused', 'The passkey did not confirm');
    const newCounter = verification.authenticationInfo?.newCounter ?? 0;
    await updateState((state) => {
      const stored = state.credentials.find((candidate) => candidate.id === credential.id);
      if (!stored) refuse('root_passkey_not_approved', 'This passkey was revoked meanwhile');
      // A counter that does not grow means a copied authenticator. Passkeys that sync keep 0.
      if ((newCounter > 0 || (stored.counter ?? 0) > 0) && newCounter <= (stored.counter ?? 0)) refuse('root_activation_refused', 'The passkey counter went back');
      stored.counter = newCounter;
    });
    return { credential: credential.id };
  };

  return { list, beginApproval, approvalChallenge, completeApproval, pendingCandidate, confirmApproval, cancelApproval, revoke, activationOptions, verifyActivation };
}

/** The hash an activation is bound to: what would run, never who asked. */
export function activationSpecHash({ place, id, name, project, purpose = 'general', memoryBytes }) {
  return sha256(JSON.stringify({ place, id, name, project, purpose, memoryBytes })).toString('hex');
}
