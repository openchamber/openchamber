import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeUpstreamAuthError, isOpenCodeUpstreamAuthRejection } from '../../../opencode/credential-auth-error.js';

// The credential source is wired through configureOpenCodeCredentials, the
// same seam server/index.js uses. Entries are credential rows as the
// running OpenCode lists them; the projection turns the active row of each
// integration into the legacy entry shape the providers consume.
//
// The provider also falls back to the legacy antigravity-accounts.json in
// ANTIGRAVITY_ACCOUNTS_PATHS (Codex review on PR #860). Both locations are
// derived at module load — one from OPENCODE_CONFIG_DIR, one from the home
// directory (USERPROFILE on Windows, HOME elsewhere) — so each test
// points both env vars at an empty temporary home and
// imports a fresh module registry; a real accounts file on the machine
// running the tests can never leak a candidate into these store-only cases.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let isolatedHome = null;

const loadProvider = async () => {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-antigravity-test-'));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.OPENCODE_CONFIG_DIR = path.join(isolatedHome, '.config', 'opencode');
  process.env.XDG_DATA_HOME = path.join(isolatedHome, '.local', 'share');
  vi.resetModules();
  const [{ configureOpenCodeCredentials }, { fetchQuota }] = await Promise.all([
    import('../../../opencode/auth.js'),
    import('./index.js'),
  ]);
  return { configureOpenCodeCredentials, fetchQuota };
};

const googleOAuthEntry = {
  id: 'cred_google_oauth',
  integrationID: 'google',
  label: 'Google',
  active: true,
  value: { type: 'oauth', methodID: 'antigravity', access: 'access-token', refresh: 'refresh-token', expires: 1 },
};

// A local OpenCode credential store under the isolated home, holding the
// google OAuth login with its refresh token — what the provider's direct
// store read sees on a signed-in machine.
const createLocalGoogleStore = () => {
  const dataDir = path.join(isolatedHome, '.local', 'share', 'opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'opencode.db'));
  db.exec(`create table credential (
    id text primary key,
    integration_id text,
    label text not null,
    value text not null,
    connector_id text,
    method_id text,
    active integer,
    time_created integer not null,
    time_updated integer not null
  )`);
  db.prepare('insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)')
    .run('cred_google_local', 'google', 'default', JSON.stringify({ type: 'oauth', methodID: 'antigravity', access: 'local-access-token', refresh: 'local-refresh-token', expires: 1 }), 1, 100, 100);
  db.close();
};

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
  isolatedHome = null;
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('Antigravity fetchQuota credential resolution', () => {
  it('resolves a google store entry in the projected shape as configured', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [googleOAuthEntry] });
    // Token refresh is refused, so a resolved candidate is observable as
    // the refresh-failure state (configured) rather than "Not configured".
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('does not produce configured:false when the credential store read throws', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('OpenCode is not connected yet');
      },
    });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to read OpenCode credential store');
    // A store that is simply not connected is not the shared upstream-auth
    // failure, so the result carries no classification marker (#1128).
    expect(result.credentialReadFailure).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('marks the store-read failure when the running OpenCode rejected the read', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('Authentication required');
      },
    });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to read OpenCode credential store');
    // The dispatcher turns this marker into the shared upstream-auth
    // classification (errorKind + shared error text) in providers/index.js.
    expect(result.credentialReadFailure).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('marks a non-bare store-read error when OpenCode marks its origin', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({
      list: async () => {
        throw new OpenCodeUpstreamAuthError('Credential request failed with status 401');
      },
    });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to read OpenCode credential store');
    expect(result.credentialReadFailure).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('does not treat bare auth text alone as OpenCode origin', async () => {
    const error = new Error('Authentication required');

    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(false);
  });

  it('still reports Not configured when the store reads fine but holds no google login', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [] });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('resolves the google login from the local store when the served projection withholds its refresh token', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    // The served projection keeps the refresh token server-side: the
    // google entry arrives with an access token only, which the store
    // resolver cannot use on its own — the direct store read must supply
    // the candidate instead.
    configureOpenCodeCredentials({
      list: async () => [{
        ...googleOAuthEntry,
        value: { type: 'oauth', methodID: 'antigravity', access: 'projected-access-token', expires: 1 },
      }],
      usesLocalStore: () => true,
      getLaunchEnvironment: () => ({ HOME: isolatedHome, XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share') }),
    });
    createLocalGoogleStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('resolves the google login from the local store when the served credential read fails', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('OpenCode is not connected yet');
      },
      usesLocalStore: () => true,
      getLaunchEnvironment: () => ({ HOME: isolatedHome, XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share') }),
    });
    createLocalGoogleStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('reports a store login the Antigravity client confirms is not its own as Not configured', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [googleOAuthEntry] });
    // A Gemini CLI OAuth login lives in the same google store entry, and
    // the stored credential carries no reliable marker of its issuing
    // client. The token endpoint's unauthorized_client answer is the
    // confirmed wrong-client rejection: that login is not an Antigravity
    // source at all, so the provider must not sit in a permanent
    // refresh-failure state for an account the user never configured.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized_client' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('keeps the refresh-failure state for an accounts-file login rejected as wrong-client', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [] });
    // The legacy accounts file is written by the Antigravity plugin
    // itself, so its token is Antigravity-issued by construction: even a
    // wrong-client-shaped rejection there is a broken account to surface,
    // not an unavailable source to hide.
    const accountsPath = path.join(isolatedHome, '.config', 'opencode', 'antigravity-accounts.json');
    fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
    fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [{ refreshToken: 'file-refresh-token' }], activeIndex: 0 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized_client' }), { status: 401 })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('does not read the local store for an external OpenCode with no google login', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    // A successful read from an external OpenCode (OPENCODE_HOST) that
    // holds no google login: the credential store on this machine belongs
    // to a different runtime and must not supply a candidate (Codex
    // review on PR #860).
    configureOpenCodeCredentials({
      list: async () => [],
      usesLocalStore: () => false,
    });
    createLocalGoogleStore();
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
