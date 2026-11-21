import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTunnelProfilesMigrated,
  formatProfileTokenStatus,
  redactProfileForOutput,
  resolveToken,
  resolveProfileByName,
  writeManagedRemotePairsToDiskFromProfiles,
  writeTunnelProfilesToDisk,
} from './cli-tunnel-profiles.js';
import { getLegacyCloudflareManagedRemoteFilePath, getTunnelProfilesFilePath } from './cli-paths.js';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-profiles-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const profile = {
  id: 'saved',
  name: 'constructor',
  provider: 'cloudflare',
  mode: 'managed-remote',
  hostname: 'app.example.com',
  token: 'saved-token',
  createdAt: -1.5,
  updatedAt: 2.5,
};

describe('tunnel profile persistence', () => {
  it('keeps unchecked tokens unchecked until redaction or status formatting', () => {
    expect(redactProfileForOutput({ token: 42 }, true)).toEqual({ token: 42 });
    expect(redactProfileForOutput({ token: 42 }, false)).toEqual({ token: '***' });
    expect(formatProfileTokenStatus({ token: 42 })).toBe('token:missing');
  });

  it('preserves token source validation and file failures', () => {
    expect(resolveToken({ token: ' flag-token ' })).toBe('flag-token');
    expect(resolveToken({})).toBeUndefined();
    expect(resolveToken({ token: null })).toBeUndefined();
    expect(resolveToken({ token: 42 })).toBeUndefined();
    expect(() => resolveToken({ token: 'flag-token', tokenFile: 'missing' })).toThrow('Multiple token sources');
    expect(() => resolveToken({ tokenFile: path.join(dataDir, 'missing') })).toThrow('not found.');
  });

  it('normalizes profiles, deduplicates names, and preserves finite timestamps', () => {
    writeTunnelProfilesToDisk({
      profiles: [
        { ...profile, name: ' constructor ', provider: ' Cloudflare ', token: ' saved-token ' },
        { ...profile, id: 'duplicate', name: 'CONSTRUCTOR' },
        { ...profile, name: 'missing-token', token: 42 },
        'constructor',
        null,
      ],
    });

    const store = ensureTunnelProfilesMigrated({ shouldWarn: false });
    expect(store).toEqual({ version: 1, profiles: [profile] });
    expect(resolveProfileByName(store.profiles, 'CONSTRUCTOR', undefined).profile).toEqual(profile);
  });

  it('does not use a non-array profiles property as a list', () => {
    writeTunnelProfilesToDisk({ profiles: Object.prototype.constructor });

    expect(JSON.parse(fs.readFileSync(getTunnelProfilesFilePath(), 'utf8'))).toEqual({
      version: 1,
      profiles: [],
    });
  });

  it('replaces unchecked timestamp values with the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(900);
    writeTunnelProfilesToDisk({ profiles: [{ ...profile, createdAt: '12', updatedAt: Infinity }] });

    expect(ensureTunnelProfilesMigrated({ shouldWarn: false }).profiles).toEqual([
      { ...profile, createdAt: 900, updatedAt: 900 },
    ]);
  });

  it('keeps the legacy cloudflare projection and excludes other providers', () => {
    writeManagedRemotePairsToDiskFromProfiles({
      profiles: [profile, { ...profile, id: 'other', provider: 'ngrok' }],
    });

    expect(JSON.parse(fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8'))).toEqual({
      version: 1,
      tunnels: [{
        id: profile.id,
        name: profile.name,
        hostname: profile.hostname,
        token: profile.token,
        updatedAt: profile.updatedAt,
      }],
    });
  });

  it('migrates checked legacy entries while ignoring malformed ones', () => {
    fs.writeFileSync(getLegacyCloudflareManagedRemoteFilePath(), JSON.stringify({
      tunnels: [
        { id: 'old', name: 'old', hostname: profile.hostname, token: profile.token, updatedAt: 12.5 },
        { name: 'invalid', hostname: profile.hostname, token: false },
        null,
      ],
    }));

    expect(ensureTunnelProfilesMigrated({ shouldWarn: false }).profiles).toEqual([{
      ...profile,
      id: 'old',
      name: 'old',
      createdAt: 12.5,
      updatedAt: 12.5,
    }]);
  });
});
