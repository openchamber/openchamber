import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { CliOptions } from './cli-args.js';
import {
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
} from './cli-paths.js';

const TUNNEL_PROFILES_VERSION = 1;
const MAX_TOKEN_FILE_BYTES = 8 * 1024;

export interface TunnelProfile {
  id: string;
  name: string;
  provider: string;
  mode: string;
  hostname: string;
  token: string;
  createdAt: number;
  updatedAt: number;
}

export interface TunnelProfilesStore {
  version: number;
  profiles: TunnelProfile[];
}

export interface TunnelProfilesInput {
  version?: unknown;
  profiles?: unknown;
}

function isProfileText(value: unknown): value is string {
  return typeof value === 'string';
}

function isProfileContainer(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isProfileList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isProfileTimestamp(value: unknown): value is number {
  return Number.isFinite(value);
}

function normalizeProfileProvider(value: string | null | undefined) {
  if (!isProfileText(value)) return '';
  return value.trim().toLowerCase();
}

function normalizeProfileMode(value: string | null | undefined) {
  if (!isProfileText(value)) return '';
  return value.trim().toLowerCase();
}

function normalizeProfileName(value: string | null | undefined) {
  if (!isProfileText(value)) return '';
  return value.trim();
}

function normalizeProfileHostname(value: string | null | undefined) {
  if (!isProfileText(value)) return '';
  return value.trim();
}

function normalizeProfileToken(value: string | null | undefined) {
  if (!isProfileText(value)) return '';
  return value.trim();
}

function suggestProfileNameFromHostname(hostname: string | null | undefined) {
  const normalizedHost = normalizeProfileHostname(hostname);
  if (!normalizedHost) return 'prod-main';
  const firstLabel = normalizedHost.split('.')[0] || normalizedHost;
  const sanitized = firstLabel.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'prod-main';
}

function maskToken(token: string | null | undefined) {
  if (!isProfileText(token) || token.length === 0) {
    return '***';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
}

function readTokenFromFileSafely(tokenFilePath: string) {
  const absolutePath = path.resolve(tokenFilePath);
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'ENOENT') {
      throw new Error(`Token file '${absolutePath}' not found.`);
    }
    if (isProfileContainer(error) && error.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Token file '${absolutePath}' must be a regular file.`);
  }
  if (stats.size <= 0) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  if (stats.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error(`Token file '${absolutePath}' is too large (max ${MAX_TOKEN_FILE_BYTES} bytes).`);
  }

  const raw = fs.readFileSync(realPath, 'utf8');
  if (raw.includes('\u0000')) {
    throw new Error(`Token file '${absolutePath}' appears to be binary. Use a plain text token file.`);
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  return value;
}

function resolveToken(options: Pick<Partial<CliOptions>, 'tokenStdin' | 'tokenFile' | 'token'>) {
  const sources = [
    options.tokenStdin ? 'stdin' : null,
    options.tokenFile ? 'file' : null,
    options.token ? 'flag' : null,
  ].filter(Boolean);

  if (sources.length > 1) {
    throw new Error(`Multiple token sources specified (${sources.join(', ')}). Use only one of --token, --token-file, or --token-stdin.`);
  }

  if (options.tokenStdin) {
    const fd = fs.openSync('/dev/stdin', 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      const value = buf.slice(0, bytesRead).toString('utf8').trim();
      if (!value) {
        throw new Error('No token received from stdin.');
      }
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  if (options.tokenFile) {
    return readTokenFromFileSafely(options.tokenFile);
  }

  return isProfileText(options.token) ? options.token.trim() : undefined;
}

function redactProfileForOutput<Profile extends { token?: unknown }>(profile: Profile | null | undefined, showSecrets = false) {
  if (!isProfileContainer(profile)) {
    return profile;
  }
  return {
    ...profile,
    token: showSecrets ? profile.token : maskToken(isProfileText(profile.token) ? profile.token : undefined),
  };
}

function redactProfilesForOutput(profiles: TunnelProfile[], showSecrets = false) {
  if (!Array.isArray(profiles)) {
    return profiles;
  }
  return profiles.map((entry) => redactProfileForOutput(entry, showSecrets));
}

function formatProfileTokenStatus(profile: { token?: unknown } | null | undefined, showSecrets = false) {
  const token = isProfileText(profile?.token) ? profile.token.trim() : '';
  if (!token) {
    return 'token:missing';
  }
  if (showSecrets) {
    return `token:${token}`;
  }
  return 'token:present';
}

function sanitizeTunnelProfilesData(data: TunnelProfilesInput | null | undefined): TunnelProfilesStore {
  const parsed = isProfileContainer(data) ? data : {};
  const list = isProfileList(parsed.profiles) ? parsed.profiles : [];
  const seen = new Set();
  const profiles: TunnelProfile[] = [];
  for (const entry of list) {
    if (!isProfileContainer(entry)) continue;
    const id = isProfileText(entry.id) && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
    const provider = normalizeProfileProvider(isProfileText(entry.provider) ? entry.provider : undefined);
    const mode = normalizeProfileMode(isProfileText(entry.mode) ? entry.mode : undefined);
    const name = normalizeProfileName(isProfileText(entry.name) ? entry.name : undefined);
    const hostname = normalizeProfileHostname(isProfileText(entry.hostname) ? entry.hostname : undefined);
    const token = normalizeProfileToken(isProfileText(entry.token) ? entry.token : undefined);
    if (!provider || !mode || !name || !hostname || !token) continue;
    const key = `${provider}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      id,
      name,
      provider,
      mode,
      hostname,
      token,
      createdAt: isProfileTimestamp(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now(),
    });
  }
  return { version: TUNNEL_PROFILES_VERSION, profiles };
}

function warnIfUnsafeFilePermissions(filePath: string, { shouldWarn = true } = {}) {
  if (process.platform === 'win32') {
    return;
  }
  if (!shouldWarn) {
    return;
  }
  try {
    const stats = fs.statSync(filePath);
    const perms = stats.mode & 0o777;
    if (perms & 0o077) {
      const octal = perms.toString(8).padStart(3, '0');
      console.warn(
        `Warning: Profile file '${filePath}' has permissions ${octal} (should be 600). ` +
        `Other users may be able to read tunnel tokens. Fix with: chmod 600 '${filePath}'`
      );
    }
  } catch {
    void 0;
  }
}

function readTunnelProfilesFromDisk(options: { shouldWarn?: boolean } = {}): TunnelProfilesStore {
  const filePath = getTunnelProfilesFilePath();
  try {
    warnIfUnsafeFilePermissions(filePath, options);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return sanitizeTunnelProfilesData(isProfileContainer(parsed) ? parsed : undefined);
  } catch {
    return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
  }
}

function writeTunnelProfilesToDisk(data: TunnelProfilesInput | null | undefined) {
  const filePath = getTunnelProfilesFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sanitizeTunnelProfilesData(data), null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeManagedRemotePairsToDiskFromProfiles(profilesData: TunnelProfilesInput | null | undefined) {
  const profiles = sanitizeTunnelProfilesData(profilesData).profiles;
  const cloudflareManagedRemote = profiles.filter(
    (entry) => entry.provider === 'cloudflare' && entry.mode === 'managed-remote'
  );

  const tunnels = cloudflareManagedRemote.map((entry) => ({
    id: entry.id,
    name: entry.name,
    hostname: entry.hostname,
    token: entry.token,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
  }));

  const filePath = getLegacyCloudflareManagedRemoteFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, tunnels }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readLegacyManagedRemoteEntries(): TunnelProfile[] {
  try {
    const raw = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const tunnels = isProfileContainer(parsed) && isProfileList(parsed.tunnels) ? parsed.tunnels : [];
    return tunnels
      .map((entry) => {
        if (!isProfileContainer(entry)) return null;
        const id = isProfileText(entry.id) && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
        const name = normalizeProfileName(isProfileText(entry.name) ? entry.name : undefined);
        const hostname = normalizeProfileHostname(isProfileText(entry.hostname) ? entry.hostname : undefined);
        const token = normalizeProfileToken(isProfileText(entry.token) ? entry.token : undefined);
        if (!name || !hostname || !token) return null;
        return {
          id,
          name,
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname,
          token,
          createdAt: isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now(),
          updatedAt: isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now(),
        };
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

function makeUniqueProfileName(provider: string, desiredName: string, existingProfiles: TunnelProfile[]) {
  const normalizedDesired = normalizeProfileName(desiredName);
  if (!normalizedDesired) {
    return '';
  }
  const existingNames = new Set(
    existingProfiles
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.name.toLowerCase())
  );

  if (!existingNames.has(normalizedDesired.toLowerCase())) {
    return normalizedDesired;
  }

  let index = 2;
  while (true) {
    const candidate = `${normalizedDesired}-${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTunnelProfilesMigrated(options: { shouldWarn?: boolean } = {}) {
  const current = readTunnelProfilesFromDisk(options);
  if (current.profiles.length > 0) {
    return current;
  }

  const legacyEntries = readLegacyManagedRemoteEntries();
  if (legacyEntries.length === 0) {
    return current;
  }

  const migratedProfiles: TunnelProfile[] = [];
  for (const entry of legacyEntries) {
    const name = makeUniqueProfileName(entry.provider, entry.name, migratedProfiles);
    migratedProfiles.push({ ...entry, name });
  }

  const migrated = sanitizeTunnelProfilesData({ version: TUNNEL_PROFILES_VERSION, profiles: migratedProfiles });
  writeTunnelProfilesToDisk(migrated);
  writeManagedRemotePairsToDiskFromProfiles(migrated);
  return migrated;
}

function resolveProfileByName(profiles: TunnelProfile[], profileName: string | null | undefined, provider: string | null | undefined) {
  const normalizedName = normalizeProfileName(profileName).toLowerCase();
  const normalizedProvider = normalizeProfileProvider(provider);
  const matches = profiles.filter((entry) => {
    if (entry.name.toLowerCase() !== normalizedName) return false;
    if (!normalizedProvider) return true;
    return entry.provider === normalizedProvider;
  });

  if (matches.length === 0) {
    return { profile: null, error: `No tunnel profile found for name '${profileName}'. Run 'openchamber tunnel profile list'.` };
  }
  if (matches.length > 1) {
    return { profile: null, error: `Profile name '${profileName}' exists for multiple providers. Use --provider <id>.` };
  }
  return { profile: matches[0], error: null };
}


export {
  normalizeProfileProvider,
  normalizeProfileMode,
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileToken,
  suggestProfileNameFromHostname,
  maskToken,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  formatProfileTokenStatus,
  warnIfUnsafeFilePermissions,
  writeTunnelProfilesToDisk,
  writeManagedRemotePairsToDiskFromProfiles,
  ensureTunnelProfilesMigrated,
  resolveProfileByName,
};
