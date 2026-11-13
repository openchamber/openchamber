import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

// Token selection in getOctokitOrNull is pure (selectTokenForHost): the stored
// OAuth token is always a github.com credential (the device flow is hardcoded
// to github.com), so it must never reach an enterprise API root. An enterprise
// host only ever gets its own host-pinned gh CLI token.

// The two "trust" cases below spawn gh (getGhCliToken) for the entry paths, so
// isolate the server's own auth/config storage to a temp dir and put a real
// (fake) `gh` binary on PATH: a recorded invocation is proof the trust gate
// let the host through, and the absence of one proves it did not.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-octokit-trust-'));
process.env.OPENCHAMBER_DATA_DIR = tmpDataDir;

// Auth settings (gh CLI active/disabled) come from a data dir resolved at
// module load; pin it to a per-run directory so the trust-gate tests below are
// deterministic (github.com passes the gate only while gh CLI is active).
process.env.OPENCHAMBER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-octokit-data-'));
fs.writeFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json'), JSON.stringify({ ghCliActive: true }));

const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-octokit-gh-'));
const ghInvoked = path.join(ghBin, 'invoked-hosts.txt');
fs.writeFileSync(path.join(ghBin, 'gh'), [
  '#!/bin/sh',
  `printf '%s\\n' "$GH_HOST" >> '${ghInvoked}'`,
  'printf \'gh-token-%s\\n\' "$GH_HOST"',
  '',
].join('\n'));
fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
const previousPath = process.env.PATH;

const { createOctokit, getOctokitForAccountId, getOctokitForHost, getOctokitOrNull, getGitHubCliCredential, selectTokenForHost } = await import('./octokit.js');
const OAuth = 'github-com-oauth-token';

afterAll(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('selectTokenForHost token selection', () => {
  test('github.com keeps the stored OAuth fallback', () => {
    // No gh token, but a stored github.com OAuth token is valid for github.com.
    expect(selectTokenForHost('github.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: true,
    })).toBe(OAuth);
    expect(selectTokenForHost(undefined, {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: false,
    })).toBe(OAuth);
  });

  test('an enterprise host with no per-host credential and no gh token gets NO token, never the github.com OAuth token', () => {
    // The stored github.com OAuth token stays a github.com credential; callers
    // scope which stored token belongs to which host, so the github.com OAuth
    // token is never even a candidate for an enterprise host. With no per-host
    // token there is nothing to use at all.
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: null,
      ghCliActive: true,
    })).toBeNull();
    // gh CLI disabled is not a workaround — still no token.
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: null,
      ghCliActive: false,
    })).toBeNull();
    // A per-host PAT is the enterprise credential and is preferred by default.
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: 'ghe-pat',
      ghCliActive: false,
    })).toBe('ghe-pat');
    // A stored per-host PAT is preferred over gh until the instance's gh login is
    // explicitly activated; once it is, the gh token takes over.
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: 'ghe-pat',
      ghCliActive: true,
    })).toBe('ghe-pat');
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: 'ghe-pat',
      ghCliActive: false,
    })).toBe('ghe-pat');
  });

  test('a GHE host uses its own stored per-host gh token only while the instance is explicitly active', () => {
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: null,
      ghCliActive: false,
    })).toBeNull();
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: 'ghe-pat',
      ghCliActive: true,
    })).toBe('ghe-token');
  });

  test('a mixed-case github.com remote is still github.com', () => {
    // `git@GitHub.com:…` parses a mixed-case host; it must keep the github.com
    // token semantics (stored OAuth stays usable; no enterprise /api/v3 path),
    // never the enterprise branch.
    expect(selectTokenForHost('GitHub.com', {
      ghToken: 'gh-token',
      storedToken: OAuth,
      ghCliActive: false,
    })).toBe(OAuth);
    expect(selectTokenForHost('GitHub.com', {
      ghToken: 'gh-token',
      storedToken: OAuth,
      ghCliActive: true,
    })).toBe('gh-token');
    expect(selectTokenForHost('GitHub.COM', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: true,
    })).toBe(OAuth);
  });
});

describe('getOctokitOrNull host trust', () => {
  test('refuses an untrusted host before any token lookup, even with an enterprise token and working gh on PATH', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    const previousToken = process.env.GH_ENTERPRISE_TOKEN;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.GH_ENTERPRISE_TOKEN = 'env-enterprise-token';
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      expect(await getOctokitOrNull('gitlab.com')).toBeNull();
    } finally {
      if (previousToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN;
      else process.env.GH_ENTERPRISE_TOKEN = previousToken;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
    // The refusal happens before gh is consulted: no `gh auth token` process,
    // so the environment's enterprise token never leaves for gitlab.com.
    expect(fs.existsSync(ghInvoked)).toBe(false);
  });

  test('lets github.com past the trust gate into token selection', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n  user: octocat\n  oauth_token: gho_ambient\n');
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      await getOctokitOrNull('github.com');
    } finally {
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
    // The gate always passes for github.com, so getGhCliToken runs a real gh;
    // the recorded host is proof gh token setup was consulted.
    const invoked = fs.existsSync(ghInvoked)
      ? fs.readFileSync(ghInvoked, 'utf8').split('\n').filter(Boolean)
      : [];
    expect(invoked).toContain('github.com');
  });

  test('resolves a trusted enterprise host cli account id to a host-pinned octokit only after the instance is activated', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
    const { setGhCliActiveForHost } = await import('./auth.js');
    try {
      await setGhCliActiveForHost('github.example.com', true);
      const resolved = await getOctokitForAccountId('github.example.com#cli:42');
      expect(resolved).not.toBeNull();
      expect(resolved.accountId).toBe('github.example.com#cli:42');
      expect(resolved.providerUserId).toBe('github.example.com#42');
      expect(resolved.source).toBe('cli');
      // Without the activation the instance's gh login is not usable — the
      // github.com Settings switch is not the enterprise instance's activation.
      await setGhCliActiveForHost('github.example.com', false);
      await expect(getOctokitForAccountId('github.example.com#cli:42')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });

  test('resolves nothing for a host#cli: id while that instance gh login is not activated, even with a stored credential', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-cli-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
    const { setGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('./auth.js');
    let storedId = null;
    try {
      const credential = await setGitHubAuthForHost('github.example.com', {
        accessToken: 'gho_stored', user: { id: 42, login: 'ghe-user' }, source: 'pat',
      });
      storedId = credential.credentialId;
      // The stored PAT may belong to someone else; a gh-bound project never
      // runs as it.
      expect(await getOctokitForAccountId('github.example.com#cli:42')).toBeNull();
    } finally {
      if (storedId) await removeGitHubAuthAccountForHost('github.example.com', storedId);
      globalThis.fetch = previousFetch;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });

  test('trusts a host the user stored a PAT for with no gh config and no environment', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-trust-stored-'));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    const previousPatToken = process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GH_ENTERPRISE_TOKEN;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
    const { setGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('./auth.js');
    let storedId = null;
    try {
      const credential = await setGitHubAuthForHost('stored.only.example.com', {
        accessToken: 'gho_stored', user: { id: 42, login: 'ghe-user' }, source: 'pat',
      });
      storedId = credential.credentialId;
      expect(await getOctokitForHost('stored.only.example.com')).not.toBeNull();
    } finally {
      if (storedId) await removeGitHubAuthAccountForHost('stored.only.example.com', storedId);
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPatToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN;
      else process.env.GH_ENTERPRISE_TOKEN = previousPatToken;
      globalThis.fetch = previousFetch;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });

  test('resolves a trusted enterprise host only after the instance is activated, and github.com#cli: keeps the Settings switch', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const settingsFile = path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: false }));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      // The github.com Settings switch is not the enterprise instance's
      // activation: without it the host gets no octokit, and github.com without
      // the switch and no stored account still gets none either.
      expect(await getOctokitOrNull('github.example.com')).toBeNull();
      // The switch is the consent: a trusted host with a gh login and the switch
      // off must not spawn gh at all.
      expect(fs.existsSync(ghInvoked)).toBe(false);
      process.env.GH_CONFIG_DIR = ghConfigDir;
      const { setGhCliActiveForHost } = await import('./auth.js');
      await setGhCliActiveForHost('github.example.com', true);
      expect(await getOctokitOrNull('github.example.com')).not.toBeNull();
      // github.com keeps the switch rule: gh CLI inactive, no gh token and no
      // stored account means no octokit.
      expect(await getOctokitOrNull('github.com')).toBeNull();
    } finally {
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: true }));
    }
  });

  test('refuses an untrusted host cli account id without a token lookup', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    const previousToken = process.env.GH_ENTERPRISE_TOKEN;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.GH_ENTERPRISE_TOKEN = 'env-enterprise-token';
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('must not reach the network');
    };
    try {
      await expect(getOctokitForAccountId('gitlab.com#cli:7')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN;
      else process.env.GH_ENTERPRISE_TOKEN = previousToken;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });
});

describe('getGitHubCliCredential git transport', () => {
  test('resolves a trusted enterprise host #cli: account only after the instance is activated', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const settingsFile = path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: false }));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
    const { setGhCliActiveForHost } = await import('./auth.js');
    await setGhCliActiveForHost('github.example.com', true);
    try {
      const credential = await getGitHubCliCredential('github.example.com#cli:42');
      expect(credential).toMatchObject({
        credentialId: 'github.example.com#cli:42',
        accountId: 'github.example.com#cli:42',
        credentialRevision: 1,
        providerUserId: 'github.example.com#42',
        accessToken: 'gh-token-github.example.com',
        source: 'cli',
        status: 'valid',
      });
      // The activation is per instance: without it the same account is not
      // usable, github.com#cli: still needs the Settings switch, and an
      // untrusted host never resolves.
      await setGhCliActiveForHost('github.example.com', false);
      await expect(getGitHubCliCredential('github.example.com#cli:42')).resolves.toBeNull();
      await expect(getGitHubCliCredential('github.com#cli:42')).resolves.toBeNull();
      // The trust gate still applies: an untrusted host never resolves.
      await expect(getGitHubCliCredential('gitlab.com#cli:7')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: true }));
    }
  });
});

describe('reused gh token', () => {
  test('a token GitHub refuses is asked from gh again', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-refused-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n  user: octocat\n');
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ message: 'Bad credentials' }, { status: 401 });
    const ghRuns = () => fs.readFileSync(ghInvoked, 'utf8').split('\n').filter(Boolean).length;
    const { getGhCliToken } = await import('./gh-cli-credential.js');
    try {
      const token = await getGhCliToken('github.com');
      expect(await getGhCliToken('github.com')).toBe(token);
      expect(ghRuns()).toBe(1);
      // A stored token's refusal leaves the gh answer alone.
      await expect(createOctokit('stored-token', '7', 'github.com').rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 });
      expect(await getGhCliToken('github.com')).toBe(token);
      expect(ghRuns()).toBe(1);
      await expect(createOctokit(token, '', 'github.com').rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 });
      expect(await getGhCliToken('github.com')).toBe(token);
      expect(ghRuns()).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });
});

describe('enterprise-host octokit request URLs', () => {
  test('GraphQL goes to /api/graphql and REST to /api/v3 on the host root', async () => {
    const requestedUrls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      requestedUrls.push(String(url));
      return Response.json(
        options.method === 'GET' ? { id: 42, login: 'ghe-user' } : { data: { viewer: { id: 42, login: 'ghe-user' } } },
      );
    };
    try {
      const octokit = createOctokit('ghe-token', '', 'github.example.com');
      await octokit.graphql('{ viewer { id login } }');
      await octokit.rest.users.getAuthenticated();
      expect(requestedUrls.map((url) => new URL(url).origin + new URL(url).pathname)).toEqual([
        'https://github.example.com/api/graphql',
        'https://github.example.com/api/v3/user',
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('refuses redirects so the credential header never leaves the instance', async () => {
    const requested = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      requested.push(options);
      return Response.json({ id: 42, login: 'ghe-user' });
    };
    try {
      await createOctokit('ghe-pat', '', 'github.example.com').rest.users.getAuthenticated();
      // A redirect would carry the token to another origin; the request is
      // refused instead (the same rule as GitLab's client).
      expect(requested).toHaveLength(1);
      expect(requested[0].redirect).toBe('error');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
