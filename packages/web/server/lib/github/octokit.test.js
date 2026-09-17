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

const { createOctokit, getOctokitForAccountId, getOctokitOrNull, getGitHubCliCredential, selectTokenForHost } = await import('./octokit.js');
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

  test('a GHE host with no gh token gets NO token, never the stored OAuth token', () => {
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: true,
    })).toBeNull();
    // gh CLI disabled is not a workaround — still no stored OAuth leak.
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: false,
    })).toBeNull();
  });

  test('a GHE host uses its own host-pinned gh token when present', () => {
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: OAuth,
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

  test('resolves a trusted enterprise host cli account id to a host-pinned octokit', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
    try {
      const resolved = await getOctokitForAccountId('github.example.com#cli:42');
      expect(resolved).not.toBeNull();
      expect(resolved.accountId).toBe('github.example.com#cli:42');
      expect(resolved.providerUserId).toBe('github.example.com#42');
      expect(resolved.source).toBe('cli');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });

  test('resolves a trusted enterprise host without the github.com CLI switch', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const settingsFile = path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: false }));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      // A stored gh login for the host is the consent; the github.com switch is
      // not involved, matching getOctokitForAccountId.
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
  test('resolves a trusted enterprise host #cli: account without the github.com switch', async () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const settingsFile = path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ghCliActive: false }));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 42, login: 'ghe-user' });
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
      // github.com keeps the switch rule: an exact github.com#cli: account still
      // needs the Settings switch, like getOctokitForAccountId.
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
});
