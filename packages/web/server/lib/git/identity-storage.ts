import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLockSync } from '../source-control/file-lock.js';
import { isExtensionProviderId, isProviderId } from '../source-control/provider-id.js';
import type { ProviderId } from '../source-control/provider-id.js';

const TRANSPORTS = ['account', 'ssh', 'system', 'anonymous'] as const;

export type GitIdentityTransport = typeof TRANSPORTS[number];
export type GitIdentityAccount = { provider: ProviderId; instance: string; accountId: string };
export type PublicGitIdentityProfile = {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  account: GitIdentityAccount | null;
  transport: GitIdentityTransport;
  sshCredentialId?: string;
  signCommits?: boolean | undefined;
  signingKey?: string | null | undefined;
  color?: string | null | undefined;
  icon?: string | null | undefined;
};
export type StoredGitIdentityProfile = {
  id: string;
  userName: string;
  userEmail: string;
  name?: unknown;
  account?: unknown;
  transport?: unknown;
  sshCredentialId?: unknown;
  signCommits?: unknown;
  signingKey?: unknown;
  color?: unknown;
  icon?: unknown;
  sshKey?: unknown;
};
export type GitIdentityState = { profiles: StoredGitIdentityProfile[] };
export type GitIdentityStoreOptions = {
  dataDir?: string;
  filePath?: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
  legacyFilePath?: string | undefined;
};

const FILE_NAME = 'git-identities.json';
const legacyDataDir = () => path.join(os.homedir(), '.config', 'openchamber');
const invalidStore = <Cause>(cause?: Cause) => Object.assign(new Error('Git identity profile store is invalid', { cause }), {
  code: 'GIT_IDENTITY_STORE_INVALID',
});
const hasCode = (error: unknown): error is { code: unknown } => (typeof error === 'object' || typeof error === 'function')
  && error !== null && 'code' in error;
const errorCode = <Value>(error: Value) => (hasCode(error) ? error.code : undefined);
const PUBLIC_PROFILE_KEYS = new Set([
  'id', 'name', 'userName', 'userEmail', 'account', 'transport', 'sshCredentialId',
  'signCommits', 'signingKey', 'color', 'icon',
]);
const ACCOUNT_KEY_COUNT = 3;
const profileText = <Value>(value: Value, { required = false, max = 512 } = {}) => isString(value)
  && value.length <= max && (!required || value.trim().length > 0) ? value : null;
const isTransport = (value: unknown): value is GitIdentityTransport => TRANSPORTS.some((transport) => transport === value);
const invalidPublicProfile = () => new TypeError('Invalid public Git identity profile');
const optionalPublicText = <Value>(value: Value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = profileText(value);
  if (text === null) throw invalidPublicProfile();
  return text.trim();
};

const parseIdentityAccount = <Value>(value: Value): GitIdentityAccount | null => {
  if (!isPlainObject(value)) {
    if (value === null || value === undefined) return null;
    throw new TypeError('Invalid Git identity account');
  }
  if (Object.keys(value).length !== ACCOUNT_KEY_COUNT) throw new TypeError('Invalid Git identity account');
  const provider = profileText(value.provider, { required: true });
  const instance = profileText(value.instance, { required: true });
  const accountId = profileText(value.accountId, { required: true });
  if (provider === null || instance === null || accountId === null || !isProviderId(provider)) {
    throw new TypeError('Invalid Git identity account');
  }
  return { provider, instance: instance.trim(),
    accountId: isExtensionProviderId(provider) ? accountId : accountId.trim() };
};

const readGitIdentityAccount = <Value>(value: Value) => {
  try { return parseIdentityAccount(value); }
  catch { return null; }
};

const parseIdentityTransport = <Value>(value: Value): GitIdentityTransport => {
  if (value === undefined) return 'system';
  if (!isTransport(value)) throw new TypeError('Invalid Git identity transport');
  return value;
};

export const parsePublicGitIdentityProfile = <Value>(value: Value, expectedId?: string): PublicGitIdentityProfile => {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !PUBLIC_PROFILE_KEYS.has(key))) throw invalidPublicProfile();
  const id = profileText(value.id, { required: true, max: 200 });
  const name = profileText(value.name, { required: true });
  const userName = profileText(value.userName, { required: true });
  const userEmail = profileText(value.userEmail, { required: true });
  const { signCommits } = value;
  if (id === null || (expectedId !== undefined && value.id !== expectedId)
    || name === null || userName === null || userEmail === null
    || (signCommits !== undefined && !isBoolean(signCommits))) {
    throw invalidPublicProfile();
  }
  const signingKey = optionalPublicText(value.signingKey);
  const color = optionalPublicText(value.color);
  const icon = optionalPublicText(value.icon);
  const account = parseIdentityAccount(value.account);
  const transport = parseIdentityTransport(value.transport);
  const rawSshCredentialId = value.sshCredentialId;
  if (rawSshCredentialId !== null && rawSshCredentialId !== undefined && !isString(rawSshCredentialId)) {
    throw invalidPublicProfile();
  }
  const sshCredentialId = isString(rawSshCredentialId) ? rawSshCredentialId.trim() : null;
  if (transport === 'account' && !account) throw new TypeError('An account transport requires an account');
  if (transport === 'ssh' && !sshCredentialId) throw new TypeError('An SSH transport requires a managed key');
  if (transport !== 'ssh' && sshCredentialId) throw new TypeError('Only an SSH transport names a managed key');
  const profile: PublicGitIdentityProfile = {
    id: id.trim(),
    name: name.trim(),
    userName: userName.trim(),
    userEmail: userEmail.trim(),
    account,
    transport,
  };
  if (sshCredentialId) profile.sshCredentialId = sshCredentialId;
  if (Object.hasOwn(value, 'signCommits')) profile.signCommits = signCommits;
  if (Object.hasOwn(value, 'signingKey')) profile.signingKey = signingKey;
  if (Object.hasOwn(value, 'color')) profile.color = color;
  if (Object.hasOwn(value, 'icon')) profile.icon = icon;
  return profile;
};

const storedText = <Value>(value: Value) => (value === null ? null : profileText(value));

export const toPublicGitIdentityProfile = (value: StoredGitIdentityProfile): PublicGitIdentityProfile => {
  const account = readGitIdentityAccount(value.account);
  let transport: GitIdentityTransport = 'system';
  try { transport = parseIdentityTransport(value.transport); }
  catch { transport = 'system'; }
  if (transport === 'account' && !account) transport = 'system';
  const sshCredentialId = transport === 'ssh' ? profileText(value.sshCredentialId, { required: true }) : null;
  if (transport === 'ssh' && !sshCredentialId) transport = 'system';
  const profile: PublicGitIdentityProfile = {
    id: value.id,
    name: profileText(value.name, { required: true }) ?? value.userName,
    userName: value.userName,
    userEmail: value.userEmail,
    account,
    transport,
  };
  if (sshCredentialId) profile.sshCredentialId = sshCredentialId;
  const { signCommits } = value;
  if (isBoolean(signCommits)) profile.signCommits = signCommits;
  const signingKey = storedText(value.signingKey);
  const color = storedText(value.color);
  const icon = storedText(value.icon);
  if (signingKey !== null || value.signingKey === null) profile.signingKey = signingKey;
  if (color !== null || value.color === null) profile.color = color;
  if (icon !== null || value.icon === null) profile.icon = icon;
  return profile;
};

const isStoredProfile = (profile: unknown): profile is StoredGitIdentityProfile => isPlainObject(profile)
  && isString(profile.id) && Boolean(profile.id)
  && isString(profile.userName) && Boolean(profile.userName)
  && isString(profile.userEmail) && Boolean(profile.userEmail);

const parseState = <Value>(value: Value): GitIdentityState => {
  if (!isPlainObject(value) || Object.keys(value).length !== 1
    || !Array.isArray(value.profiles) || value.profiles.length > 256) throw invalidStore();
  const entries: unknown[] = value.profiles;
  const ids = new Set();
  const profiles: StoredGitIdentityProfile[] = [];
  for (const profile of entries) {
    if (!isStoredProfile(profile) || ids.has(profile.id)) throw invalidStore();
    ids.add(profile.id);
    profiles.push(profile);
  }
  return { profiles };
};

export function createGitIdentityStore({
  dataDir,
  filePath = dataDir ? path.join(dataDir, FILE_NAME) : undefined,
  fsImpl = fs,
  lockWaitMs = 2_000,
  legacyFilePath,
}: GitIdentityStoreOptions = {}) {
  if (!isString(filePath) || !path.isAbsolute(filePath)
    || (legacyFilePath !== undefined && (!isString(legacyFilePath) || !path.isAbsolute(legacyFilePath)))
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('Git identity store options are invalid');
  }
  const storePath = filePath;

  const emptyState = (): GitIdentityState => ({ profiles: [] });
  const readFile = (target: string, allowShippedMode = false) => {
    let handle: number;
    try {
      handle = fsImpl.openSync(target, fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      if (errorCode(error) === 'ELOOP') throw invalidStore(error);
      throw error;
    }
    try {
      const stats = fsImpl.fstatSync(handle);
      if (!stats.isFile()) throw invalidStore();
      const extraMode = process.platform !== 'win32' ? stats.mode & 0o077 : 0;
      if (extraMode !== 0 && !allowShippedMode) throw invalidStore();
      let state;
      try { state = parseState(JSON.parse(fsImpl.readFileSync(handle, 'utf8'))); }
      catch (error) {
        if (errorCode(error) === 'GIT_IDENTITY_STORE_INVALID') throw error;
        throw invalidStore(error);
      }
      return { state, needsModeMigration: extraMode !== 0 };
    } finally {
      fsImpl.closeSync(handle);
    }
  };
  const removeQuietly = (target: string) => {
    try { fsImpl.rmSync(target, { force: true }); } catch { return false; }
    return true;
  };
  const writeState = <State>(state: State) => {
    const parsed = parseState(state);
    fsImpl.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      fsImpl.chmodSync(temporary, 0o600);
      fsImpl.renameSync(temporary, storePath);
    } catch (error) {
      removeQuietly(temporary);
      throw error;
    }
    return parsed;
  };
  const readState = () => {
    const current = readFile(storePath, true);
    if (current) {
      if (current.needsModeMigration) writeState(current.state);
      return current.state;
    }
    if (!legacyFilePath || legacyFilePath === storePath) return emptyState();
    return withSourceControlFileLockSync(`${legacyFilePath}.lock`, () => {
      const legacy = readFile(legacyFilePath, true);
      if (!legacy) return emptyState();
      writeState(legacy.state);
      return legacy.state;
    }, { fsImpl, waitMs: lockWaitMs });
  };
  const transact = <Result>(operation: () => Result) => withSourceControlFileLockSync(`${storePath}.lock`, operation, {
    fsImpl, waitMs: lockWaitMs,
  });
  const loadProfiles = () => transact(readState);
  const saveProfiles = <Data>(data: Data) => transact(() => writeState(data));
  const getProfiles = () => transact(() => readState().profiles);
  const getProfile = <Id>(id: Id) => transact(() => readState().profiles.find((profile) => profile.id === id) || null);
  const createProfile = <Input>(profileData: Input) => transact(() => {
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
  const updateProfile = <Updates>(id: string, updates: Updates) => transact(() => {
    const publicUpdates = parsePublicGitIdentityProfile(updates, id);
    const state = readState();
    const index = state.profiles.findIndex((profile) => profile.id === id);
    const current = state.profiles[index];
    if (index === -1 || !current) throw new Error(`Profile with ID "${id}" not found`);
    const updated = { ...current, ...publicUpdates, id: current.id };
    state.profiles[index] = updated;
    writeState(state);
    return updated;
  });
  const deleteProfile = (id: string) => transact(() => {
    const state = readState();
    const profiles = state.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === state.profiles.length) throw new Error(`Profile with ID "${id}" not found`);
    writeState({ profiles });
    return true;
  });

  return Object.freeze({ loadProfiles, saveProfiles, getProfiles, getProfile, createProfile, updateProfile, deleteProfile });
}

const stores = new Map<string, ReturnType<typeof createGitIdentityStore>>();
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
export const getProfile = <Id>(id: Id) => defaultStore().getProfile(id);
export const createProfile = <Input>(profileData: Input) => defaultStore().createProfile(profileData);
export const updateProfile = <Updates>(id: string, updates: Updates) => defaultStore().updateProfile(id, updates);

export const deleteProfile = (id: string) => defaultStore().deleteProfile(id);
