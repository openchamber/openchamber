import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import {
  getLinearAuth,
  getLinearAuthWorkspaces,
  setLinearAuth,
  activateLinearAuth,
  clearLinearAuth,
  toLinearPublicStatus,
  getLinearClientId,
  getLinearRedirectUri,
  isLinearAccessTokenStale,
  getLinearAuthFilePath,
  configureLinearVaultReader,
  readLinearVaultToken,
  getLinearSessionCommentsEnabled,
  setLinearSessionCommentsEnabled,
  getLinearStorageState,
  LinearAuthError,
  DEFAULT_LINEAR_CLIENT_ID_VALUE,
} from './auth.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-auth-'));

describe('Linear auth storage', () => {
  let dataDir;
  let previousDataDir;
  let previousPort;
  let previousClientId;
  let previousRedirect;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    previousPort = process.env.OPENCHAMBER_PORT;
    previousClientId = process.env.OPENCHAMBER_LINEAR_CLIENT_ID;
    previousRedirect = process.env.OPENCHAMBER_LINEAR_REDIRECT_URI;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    delete process.env.OPENCHAMBER_LINEAR_CLIENT_ID;
    delete process.env.OPENCHAMBER_LINEAR_SCOPES;
    delete process.env.OPENCHAMBER_LINEAR_REDIRECT_URI;
    delete process.env.OPENCHAMBER_PORT;
  });

  afterEach(() => {
    restoreEnv('OPENCHAMBER_DATA_DIR', previousDataDir);
    restoreEnv('OPENCHAMBER_PORT', previousPort);
    restoreEnv('OPENCHAMBER_LINEAR_CLIENT_ID', previousClientId);
    restoreEnv('OPENCHAMBER_LINEAR_REDIRECT_URI', previousRedirect);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns disconnected when no auth file exists', () => {
    expect(getLinearAuth()).toBeNull();
    expect(toLinearPublicStatus(null)).toEqual({ connected: false });
  });

  it('persists tokens without exposing them on the public status', () => {
    setLinearAuth({
      accessToken: 'lin_oauth_access',
      refreshToken: 'lin_oauth_refresh',
      expiresAt: Date.now() + 60_000,
      scope: 'read,write',
      user: { id: 'user-1', name: 'Ada', displayName: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: 'https://example.com/a.png' },
      organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
    });

    const stored = getLinearAuth();
    expect(stored.accessToken).toBe('lin_oauth_access');
    expect(stored.refreshToken).toBe('lin_oauth_refresh');
    expect(stored.workspaceId).toBe('org-1');
    const publicStatus = toLinearPublicStatus(stored);
    expect(publicStatus).toEqual({
      connected: true,
      source: 'oauth',
      user: {
        id: 'user-1',
        name: 'Ada',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        avatarUrl: 'https://example.com/a.png',
      },
      organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
      scope: 'read,write',
      workspaces: [{
        id: 'org-1',
        name: 'OpenChamber',
        urlKey: 'openchamber',
        current: true,
        source: 'oauth',
        user: {
          id: 'user-1',
          name: 'Ada',
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          avatarUrl: 'https://example.com/a.png',
        },
        authorizedAt: stored.authorizedAt,
      }],
    });
    expect(JSON.stringify(publicStatus)).not.toContain('lin_oauth');
    const file = JSON.parse(fs.readFileSync(getLinearAuthFilePath(), 'utf8'));
    expect(file.accessToken).toBeUndefined();
    expect(file.workspaces).toHaveLength(1);
    expect(file.workspaces[0].accessToken).toBe('lin_oauth_access');
  });

  it('keeps the previous refresh token when a later write omits it', () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1,
    });
    setLinearAuth({
      accessToken: 'access-2',
      expiresAt: 2,
    });
    expect(getLinearAuth().refreshToken).toBe('refresh-1');
    expect(getLinearAuth().accessToken).toBe('access-2');
  });

  it('rotates the refresh token when a new one is provided', () => {
    setLinearAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    setLinearAuth({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    expect(getLinearAuth().refreshToken).toBe('refresh-2');
  });

  it('rejects a write without an access token', () => {
    expect(() => setLinearAuth({ refreshToken: 'refresh-1' })).toThrow('accessToken is required');
  });

  it('treats a missing or past expiry as stale', () => {
    expect(isLinearAccessTokenStale(null)).toBe(true);
    expect(isLinearAccessTokenStale(Date.now() - 1)).toBe(true);
    expect(isLinearAccessTokenStale(Date.now() + 10 * 60_000)).toBe(false);
  });

  it('uses the baked-in client id unless env or settings override it', () => {
    expect(getLinearClientId()).toBe(DEFAULT_LINEAR_CLIENT_ID_VALUE);
    process.env.OPENCHAMBER_LINEAR_CLIENT_ID = 'env-client';
    expect(getLinearClientId()).toBe('env-client');
  });

  it('uses the stable public broker callback by default', () => {
    process.env.OPENCHAMBER_PORT = '3001';
    expect(getLinearRedirectUri()).toBe('https://api.openchamber.dev/v1/oauth/linear/callback');
    process.env.OPENCHAMBER_LINEAR_REDIRECT_URI = 'http://localhost:3000/linear/oauth/callback';
    expect(getLinearRedirectUri()).toBe('http://localhost:3000/linear/oauth/callback');
  });

  it('deletes the auth file on clear', () => {
    setLinearAuth({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(fs.existsSync(getLinearAuthFilePath())).toBe(true);
    expect(clearLinearAuth()).toBe(true);
    expect(fs.existsSync(getLinearAuthFilePath())).toBe(false);
    expect(getLinearAuth()).toBeNull();
  });

  it('migrates a legacy single-workspace file', () => {
    fs.writeFileSync(getLinearAuthFilePath(), JSON.stringify({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      user: { id: 'user-1', name: 'Ada' },
      organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
    }), 'utf8');

    const stored = getLinearAuth();
    expect(stored.accessToken).toBe('legacy-access');
    expect(stored.workspaceId).toBe('org-1');
    expect(stored.current).toBe(true);
    const file = JSON.parse(fs.readFileSync(getLinearAuthFilePath(), 'utf8'));
    expect(file.workspaces).toHaveLength(1);
    expect(file.accessToken).toBeUndefined();
  });

  it('stores a second workspace and activates it without dropping the first', () => {
    setLinearAuth({
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      user: { id: 'user-a', name: 'Ada' },
      organization: { id: 'org-a', name: 'Alpha', urlKey: 'alpha' },
    });
    setLinearAuth({
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      user: { id: 'user-b', name: 'Ben' },
      organization: { id: 'org-b', name: 'Beta', urlKey: 'beta' },
    });

    expect(getLinearAuth().workspaceId).toBe('org-b');
    expect(getLinearAuthWorkspaces().map((entry) => entry.id).sort()).toEqual(['org-a', 'org-b']);
    expect(activateLinearAuth('org-a')).toBe(true);
    expect(getLinearAuth().workspaceId).toBe('org-a');
    expect(getLinearAuth().accessToken).toBe('access-a');
    expect(getLinearAuthWorkspaces().find((entry) => entry.id === 'org-b').current).toBe(false);
  });

  it('drops only the current workspace on unscoped clear', () => {
    setLinearAuth({
      accessToken: 'access-a',
      organization: { id: 'org-a', name: 'Alpha', urlKey: 'alpha' },
      user: { id: 'user-a', name: 'Ada' },
    });
    setLinearAuth({
      accessToken: 'access-b',
      organization: { id: 'org-b', name: 'Beta', urlKey: 'beta' },
      user: { id: 'user-b', name: 'Ben' },
    });
    expect(clearLinearAuth()).toBe(true);
    expect(getLinearAuth().workspaceId).toBe('org-a');
    expect(getLinearAuth().accessToken).toBe('access-a');
    expect(getLinearAuthWorkspaces()).toHaveLength(1);
  });

  it('refuses to build a write on a malformed auth file, leaving its bytes untouched', () => {
    setLinearAuth({
      accessToken: 'access-a',
      organization: { id: 'org-a', name: 'Alpha', urlKey: 'alpha' },
      user: { id: 'user-a', name: 'Ada' },
    });
    setLinearAuth({
      accessToken: 'access-b',
      organization: { id: 'org-b', name: 'Beta', urlKey: 'beta' },
      user: { id: 'user-b', name: 'Ben' },
    });
    const filePath = getLinearAuthFilePath();
    const torn = fs.readFileSync(filePath, 'utf8').slice(0, 40);
    fs.writeFileSync(filePath, torn);

    // Read-only paths keep answering, but malformed is distinguishable
    // from never-connected.
    expect(getLinearAuth()).toBeNull();
    expect(getLinearAuthWorkspaces()).toEqual([]);
    expect(getLinearStorageState().authFile).toBe('malformed');
    expect(toLinearPublicStatus(null)).toMatchObject({ connected: false, code: 'MALFORMED' });

    let thrown = null;
    try {
      setLinearAuth({ accessToken: 'access-new', organization: { id: 'org-new', name: 'New' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinearAuthError);
    expect(thrown.code).toBe('MALFORMED');
    expect(() => activateLinearAuth('org-a')).toThrow(/not valid JSON/);
    // clear turns the refusal into its existing false answer, not a delete.
    expect(clearLinearAuth('org-a')).toBe(false);

    // Both stored tokens survive: the file is byte-for-byte what it was.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(torn);
    expect(fs.readdirSync(dataDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('refuses a write when the auth file holds valid JSON that is not an object', () => {
    fs.writeFileSync(getLinearAuthFilePath(), '["not-a-store"]', 'utf8');
    expect(() => setLinearAuth({ accessToken: 'access-1' })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(getLinearAuthFilePath(), 'utf8')).toBe('["not-a-store"]');
  });

  it('refuses a write when the auth file cannot be read at all', () => {
    fs.mkdirSync(getLinearAuthFilePath());
    expect(() => setLinearAuth({ accessToken: 'access-1' })).toThrow();
    expect(fs.statSync(getLinearAuthFilePath()).isDirectory()).toBe(true);
  });

  it('refuses a session-comments toggle on a malformed settings file, leaving it untouched', () => {
    const settingsPath = path.join(dataDir, 'settings.json');
    const torn = '{"theme":"dark","linearClientId":"x';
    fs.writeFileSync(settingsPath, torn);
    expect(getLinearSessionCommentsEnabled()).toBe(false);
    expect(getLinearStorageState().settingsFile).toBe('malformed');
    expect(() => setLinearSessionCommentsEnabled(true)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(torn);
  });

  it('refuses an oversized auth file as MALFORMED, leaving its bytes untouched', () => {
    const filePath = getLinearAuthFilePath();
    const oversized = JSON.stringify({ accessToken: 'x'.repeat(4 * 1024 * 1024) });
    fs.writeFileSync(filePath, oversized, 'utf8');
    expect(fs.statSync(filePath).size).toBeGreaterThan(4 * 1024 * 1024);

    expect(getLinearAuth()).toBeNull();
    expect(getLinearStorageState().authFile).toBe('malformed');

    let thrown = null;
    try {
      setLinearAuth({ accessToken: 'access-new' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinearAuthError);
    expect(thrown.code).toBe('MALFORMED');
    expect(thrown.message).not.toContain('xxxx');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(oversized);
  });

  it('still reads a settings file between the auth cap and the settings cap', () => {
    const settingsPath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      linearClientId: 'settings-client',
      pad: 'y'.repeat(5 * 1024 * 1024),
    }), 'utf8');
    expect(getLinearClientId()).toBe('settings-client');
    expect(getLinearStorageState().settingsFile).toBe('valid');
  });

  it('refuses an oversized settings file as MALFORMED, leaving it untouched', () => {
    const settingsPath = path.join(dataDir, 'settings.json');
    const oversized = JSON.stringify({ pad: 'y'.repeat(8 * 1024 * 1024) });
    fs.writeFileSync(settingsPath, oversized, 'utf8');
    expect(fs.statSync(settingsPath).size).toBeGreaterThan(8 * 1024 * 1024);

    expect(getLinearSessionCommentsEnabled()).toBe(false);
    expect(getLinearStorageState().settingsFile).toBe('malformed');
    expect(() => setLinearSessionCommentsEnabled(true)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(oversized);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO at the auth path as MALFORMED without blocking', () => {
    execFileSync('mkfifo', [getLinearAuthFilePath()]);
    expect(getLinearStorageState().authFile).toBe('malformed');
    expect(getLinearAuth()).toBeNull();
    expect(() => setLinearAuth({ accessToken: 'access-1' })).toThrow(/not valid JSON/);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO at the settings path as MALFORMED without blocking', () => {
    const settingsPath = path.join(dataDir, 'settings.json');
    execFileSync('mkfifo', [settingsPath]);
    expect(getLinearStorageState().settingsFile).toBe('malformed');
    expect(getLinearSessionCommentsEnabled()).toBe(false);
    expect(() => setLinearSessionCommentsEnabled(true)).toThrow(/not valid JSON/);
  });

  it('changes only its own key when toggling session comments on a healthy settings file', () => {
    const settingsPath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', linearClientId: 'x' }), 'utf8');
    expect(setLinearSessionCommentsEnabled(true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      linearClientId: 'x',
      linearSessionComments: true,
    });
    expect(getLinearSessionCommentsEnabled()).toBe(true);
  });

  it('still toggles session comments when no settings file exists yet', () => {
    expect(setLinearSessionCommentsEnabled(true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({
      linearSessionComments: true,
    });
  });

  it('does not bump authorizedAt when a later write opts out of activate', () => {
    setLinearAuth({
      accessToken: 'access-1',
      user: { id: 'user-1', name: 'Ada' },
      organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
    });
    const file = JSON.parse(fs.readFileSync(getLinearAuthFilePath(), 'utf8'));
    file.workspaces[0].authorizedAt = 111;
    fs.writeFileSync(getLinearAuthFilePath(), JSON.stringify(file, null, 2), 'utf8');

    setLinearAuth({
      accessToken: 'access-1',
      user: { id: 'user-1', name: 'Ada' },
      organization: { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' },
      workspaceId: 'org-1',
    }, { activate: false });
    expect(getLinearAuth().authorizedAt).toBe(111);
    expect(getLinearAuth().current).toBe(true);
  });
});

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

describe('Linear vault credentials (#304)', () => {
  let dataDir;
  let previousDataDir;
  const REFERENCE = 'op://Private/Linear/api-key';
  const USER = { id: 'user-1', name: 'Ada', displayName: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: 'https://example.com/a.png' };
  const ORG = { id: 'org-1', name: 'OpenChamber', urlKey: 'openchamber' };

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    restoreEnv('OPENCHAMBER_DATA_DIR', previousDataDir);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores only the reference, never a key, and reports source vault', () => {
    setLinearAuth({ tokenReference: REFERENCE, user: USER, organization: ORG });
    const stored = getLinearAuth();
    expect(stored.tokenReference).toBe(REFERENCE);
    expect(stored.accessToken).toBeNull();
    expect(stored.tokenType).toBe('apiKey');
    const fileText = fs.readFileSync(getLinearAuthFilePath(), 'utf8');
    expect(fileText).toContain(REFERENCE);
    const status = toLinearPublicStatus(stored);
    expect(status.connected).toBe(true);
    expect(status.source).toBe('vault');
    expect(getLinearAuthWorkspaces()[0].source).toBe('vault');
    expect(JSON.stringify(status)).not.toContain(REFERENCE);
  });

  it('rejects an invalid reference and a token-plus-reference write', () => {
    expect(() => setLinearAuth({ tokenReference: 'not-a-reference', user: USER, organization: ORG })).toThrow();
    expect(() => setLinearAuth({ tokenReference: REFERENCE, accessToken: 'lin_x', user: USER, organization: ORG })).toThrow(/mutually exclusive/);
    expect(getLinearAuth()).toBeNull();
  });

  it('resolves the reference through the configured vault reader only', async () => {
    configureLinearVaultReader(async (reference) => (reference === REFERENCE
      ? { ok: true, value: 'lin_api_secret' }
      : { ok: false, reason: 'not-found' }));
    await expect(readLinearVaultToken(REFERENCE)).resolves.toEqual({ ok: true, value: 'lin_api_secret' });
    await expect(readLinearVaultToken('op://Private/Linear/other')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });
});
