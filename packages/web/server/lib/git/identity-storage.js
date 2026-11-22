import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLockSync } from '../source-control/file-lock.js';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';

const FILE_NAME = 'git-identities.json';

// The store file's byte cap, enforced on the open handle in readFile below
// (#1635): at most 256 profiles, and parseState caps every stored text field
// at 512 chars (id at 200), so one profile's fields total at most
// 200 + 8 x 512 = 4,296 chars; at up to 3 UTF-8 bytes per char plus JSON
// structure and pretty-print indent that is under 16 KiB per profile, and
// 256 x 16 KiB = 4 MiB is the legitimate maximum a store this version could
// have written. Anything larger is not a store: it is refused as invalid
// before reading, and the chunked read below never buffers more than
// cap + 1 bytes even if the file grows after its fstat.
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const legacyDataDir = () => path.join(os.homedir(), '.config', 'openchamber');
const invalidStore = (cause) => Object.assign(new Error('Git identity profile store is invalid', { cause }), {
  code: 'GIT_IDENTITY_STORE_INVALID',
});
const PUBLIC_PROFILE_KEYS = new Set([
  'id', 'name', 'userName', 'userEmail', 'account', 'transport', 'sshCredentialId',
  'signCommits', 'signingKey', 'color', 'icon',
]);
const ACCOUNT_KEYS = ['provider', 'instance', 'accountId'];
const TRANSPORTS = ['account', 'ssh', 'system', 'anonymous'];
const validProfileText = (value, { required = false, max = 512 } = {}) => isString(value)
  && value.length <= max && (!required || value.trim().length > 0);

/**
 * The account an identity acts as, addressed the way bindings address one.
 *
 * Only the reference is stored. The credential behind it lives in the provider
 * auth store, so an identity that names a disconnected account resolves to
 * nothing rather than to a stale secret.
 */
const parseIdentityAccount = (value) => {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)
    || Object.keys(value).length !== ACCOUNT_KEYS.length
    || !ACCOUNT_KEYS.every((key) => validProfileText(value[key], { required: true }))
    || !['github', 'gitlab'].includes(value.provider)) {
    throw new TypeError('Invalid Git identity account');
  }
  return { provider: value.provider, instance: value.instance.trim(), accountId: value.accountId.trim() };
};

/**
 * An identity written before identities carried a transport says who commits
 * and nothing about how transfers authenticate, which is what System Git is.
 */
const parseIdentityTransport = (value) => {
  if (value === undefined) return 'system';
  if (!TRANSPORTS.includes(value)) throw new TypeError('Invalid Git identity transport');
  return value;
};

export const parsePublicGitIdentityProfile = (value, expectedId) => {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !PUBLIC_PROFILE_KEYS.has(key))
    || !validProfileText(value.id, { required: true, max: 200 })
    || (expectedId !== undefined && value.id !== expectedId)
    || !validProfileText(value.name, { required: true })
    || !validProfileText(value.userName, { required: true })
    || !validProfileText(value.userEmail, { required: true })
    || (value.signCommits !== undefined && typeof value.signCommits !== 'boolean')
    || (value.signingKey !== undefined && value.signingKey !== null && !validProfileText(value.signingKey))
    || (value.color !== undefined && value.color !== null && !validProfileText(value.color))
    || (value.icon !== undefined && value.icon !== null && !validProfileText(value.icon))) {
    throw new TypeError('Invalid public Git identity profile');
  }
  const account = parseIdentityAccount(value.account);
  const transport = parseIdentityTransport(value.transport);
  const sshCredentialId = value.sshCredentialId === null || value.sshCredentialId === undefined
    ? null : value.sshCredentialId.trim();
  // An identity is a signature, a way to push and pull, and optionally the
  // account it acts as. Only the account transport needs that account; the
  // machine's own Git, a managed key and anonymous reads need none, and an
  // account beside them still answers for issues and change requests.
  if (transport === 'account' && !account) throw new TypeError('An account transport requires an account');
  if (transport === 'ssh' && !sshCredentialId) throw new TypeError('An SSH transport requires a managed key');
  if (transport !== 'ssh' && sshCredentialId) throw new TypeError('Only an SSH transport names a managed key');
  const profile = {
    id: value.id.trim(),
    name: value.name.trim(),
    userName: value.userName.trim(),
    userEmail: value.userEmail.trim(),
    account,
    transport,
  };
  if (sshCredentialId) profile.sshCredentialId = sshCredentialId;
  for (const key of ['signCommits', 'signingKey', 'color', 'icon']) {
    if (Object.hasOwn(value, key)) profile[key] = isString(value[key]) ? value[key].trim() : value[key];
  }
  return profile;
};

export const toPublicGitIdentityProfile = (value) => {
  let account = null;
  try { account = parseIdentityAccount(value.account); }
  catch { account = null; }
  // A stored record from before identities carried a transport pushes and
  // pulls with the machine's own Git; the legacy `authType`, `sshKey` and
  // `host` beside it named no credential this build can resolve, so they are
  // not carried forward.
  let transport = 'system';
  try { transport = parseIdentityTransport(value.transport); }
  catch { transport = 'system'; }
  if (transport === 'account' && !account) transport = 'system';
  const sshCredentialId = transport === 'ssh' && validProfileText(value.sshCredentialId, { required: true })
    ? value.sshCredentialId : null;
  if (transport === 'ssh' && !sshCredentialId) transport = 'system';
  const profile = {
    id: value.id,
    name: validProfileText(value.name, { required: true }) ? value.name : value.userName,
    userName: value.userName,
    userEmail: value.userEmail,
    account,
    transport,
  };
  if (sshCredentialId) profile.sshCredentialId = sshCredentialId;
  if (typeof value.signCommits === 'boolean') profile.signCommits = value.signCommits;
  for (const key of ['signingKey', 'color', 'icon']) {
    if (value[key] === null || validProfileText(value[key])) profile[key] = value[key];
  }
  return profile;
};

const parseState = (value) => {
  if (!isPlainObject(value) || Object.keys(value).length !== 1
    || !Array.isArray(value.profiles) || value.profiles.length > 256) throw invalidStore();
  const ids = new Set();
  for (const profile of value.profiles) {
    if (!isPlainObject(profile) || !isString(profile.id) || !profile.id
      || !isString(profile.userName) || !profile.userName
      || !isString(profile.userEmail) || !profile.userEmail || ids.has(profile.id)) throw invalidStore();
    // Stored text fields carry the same length caps the public profile
    // parser enforces (validProfileText: id 200, the rest 512): a record
    // past them was not written through the public path at its caps, and an
    // uncapped field is how an over-cap payload would otherwise hide under
    // the byte cap one field at a time (#1635).
    if (!validProfileText(profile.id, { required: true, max: 200 })
      || !validProfileText(profile.userName, { required: true })
      || !validProfileText(profile.userEmail, { required: true })) throw invalidStore();
    for (const key of ['name', 'signingKey', 'color', 'icon', 'sshCredentialId']) {
      if (profile[key] !== undefined && profile[key] !== null && !validProfileText(profile[key])) throw invalidStore();
    }
    if (profile.account !== undefined && profile.account !== null) {
      if (!isPlainObject(profile.account)
        || !ACCOUNT_KEYS.every((key) => validProfileText(profile.account[key], { required: true }))) throw invalidStore();
    }
    ids.add(profile.id);
  }
  return value;
};

export function createGitIdentityStore({
  dataDir,
  filePath = dataDir ? path.join(dataDir, FILE_NAME) : undefined,
  fsImpl = fs,
  lockWaitMs = 2_000,
  legacyFilePath,
} = {}) {
  if (!isString(filePath) || !path.isAbsolute(filePath)
    || (legacyFilePath !== undefined && (!isString(legacyFilePath) || !path.isAbsolute(legacyFilePath)))
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('Git identity store options are invalid');
  }

  const emptyState = () => ({ profiles: [] });
  const readFile = (target, allowShippedMode = false) => {
    let handle;
    try {
      handle = fsImpl.openSync(target, fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'ELOOP') throw invalidStore(error);
      throw error;
    }
    try {
      const stats = fsImpl.fstatSync(handle);
      if (!stats.isFile()) throw invalidStore();
      // A file this version wrote is private. One an earlier release wrote
      // carries whatever the umask gave it at the time (0664 on a Linux with
      // user-private groups), so it is read and made private, not refused.
      const extraMode = process.platform !== 'win32' ? stats.mode & 0o077 : 0;
      if (extraMode !== 0 && !allowShippedMode) throw invalidStore();
      // Size gate on the handle (#1635): the fstat size refuses over-cap
      // files before a byte is read, and the chunked read enforces the same
      // cap in flight (at most cap + 1 bytes buffered), so a file that
      // grows after its fstat still cannot be buffered whole. The gate
      // stays in place on this handle — O_NOFOLLOW, the fsImpl seam and
      // the mode-migration check above are all load-bearing, which is why
      // this module does not adopt the shared bounded reader.
      if (stats.size > MAX_STORE_BYTES) throw invalidStore();
      const chunks = [];
      let total = 0;
      while (total <= MAX_STORE_BYTES) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_STORE_BYTES + 1 - total));
        const bytesRead = fsImpl.readSync(handle, chunk, 0, chunk.length, total);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > MAX_STORE_BYTES) throw invalidStore();
      let state;
      try { state = parseState(JSON.parse(Buffer.concat(chunks, total).toString('utf8'))); }
      catch (error) {
        if (error?.code === 'GIT_IDENTITY_STORE_INVALID') throw error;
        throw invalidStore(error);
      }
      return { state, needsModeMigration: extraMode !== 0 };
    } finally {
      fsImpl.closeSync(handle);
    }
  };
  const writeState = (state) => {
    const parsed = parseState(state);
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      fsImpl.chmodSync(temporary, 0o600);
      renameSyncWithRetry((from, to) => fsImpl.renameSync(from, to), temporary, filePath);
    } catch (error) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    return parsed;
  };
  const readState = () => {
    const current = readFile(filePath, true);
    if (current) {
      if (current.needsModeMigration) writeState(current.state);
      return current.state;
    }
    if (!legacyFilePath || legacyFilePath === filePath) return emptyState();
    return withSourceControlFileLockSync(`${legacyFilePath}.lock`, () => {
      const legacy = readFile(legacyFilePath, true);
      if (!legacy) return emptyState();
      writeState(legacy.state);
      return legacy.state;
    }, { fsImpl, waitMs: lockWaitMs });
  };
  const transact = (operation) => withSourceControlFileLockSync(`${filePath}.lock`, operation, {
    fsImpl, waitMs: lockWaitMs,
  });
  const loadProfiles = () => transact(readState);
  const saveProfiles = (data) => transact(() => writeState(data));
  const getProfiles = () => transact(() => readState().profiles);
  const getProfile = (id) => transact(() => readState().profiles.find((profile) => profile.id === id) || null);
  const createProfile = (profileData) => transact(() => {
    const publicProfile = parsePublicGitIdentityProfile(profileData);
    const state = readState();
    if (state.profiles.length >= 256) throw new Error('Git identity profile limit reached');
    if (state.profiles.some((profile) => profile.id === publicProfile.id)) {
      throw new Error(`Profile with ID "${publicProfile.id}" already exists`);
    }
    const profile = {
      ...publicProfile,
      color: publicProfile.color || 'keyword',
      icon: publicProfile.icon || 'branch',
    };
    state.profiles.push(profile);
    writeState(state);
    return profile;
  });
  const updateProfile = (id, updates) => transact(() => {
    const publicUpdates = parsePublicGitIdentityProfile(updates, id);
    const state = readState();
    const index = state.profiles.findIndex((profile) => profile.id === id);
    if (index === -1) throw new Error(`Profile with ID "${id}" not found`);
    state.profiles[index] = { ...state.profiles[index], ...publicUpdates, id: state.profiles[index].id };
    writeState(state);
    return state.profiles[index];
  });
  const deleteProfile = (id) => transact(() => {
    const state = readState();
    const profiles = state.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === state.profiles.length) throw new Error(`Profile with ID "${id}" not found`);
    writeState({ profiles });
    return true;
  });

  return Object.freeze({ loadProfiles, saveProfiles, getProfiles, getProfile, createProfile, updateProfile, deleteProfile });
}

const stores = new Map();
const defaultStore = () => {
  const oldFilePath = path.join(legacyDataDir(), FILE_NAME);
  const dataDir = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : legacyDataDir();
  const filePath = path.join(dataDir, FILE_NAME);
  let store = stores.get(filePath);
  if (!store) {
    store = createGitIdentityStore({
      filePath,
      legacyFilePath: filePath === oldFilePath ? undefined : oldFilePath,
    });
    stores.set(filePath, store);
  }
  return store;
};

export const getProfiles = () => defaultStore().getProfiles();
export const getProfile = (id) => defaultStore().getProfile(id);
export const createProfile = (profileData) => defaultStore().createProfile(profileData);
export const updateProfile = (id, updates) => defaultStore().updateProfile(id, updates);

/** @public Read by Git routes through the lazy-loaded Git library. */
export const deleteProfile = (id) => defaultStore().deleteProfile(id);
