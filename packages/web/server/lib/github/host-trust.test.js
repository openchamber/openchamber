import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { ghConfigDir } from './gh-config.js';

const { isTrustedGitHubHost, hasStoredGhLogin, listTrustedGitHubHosts } = await import('./host-trust.js');

// isTrustedGitHubHost reads GH_HOST and hosts.yml at call time (no memo), so
// tests just set and restore the environment around each case.
const previousGhHost = process.env.GH_HOST;
const previousGhConfigDir = process.env.GH_CONFIG_DIR;
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
const previousAppData = process.env.APPDATA;
const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const createdDirs = [];

const createHostsYaml = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'hosts.yml'), content);
  process.env.GH_CONFIG_DIR = dir;
  return dir;
};

afterEach(() => {
  if (previousGhHost === undefined) delete process.env.GH_HOST;
  else process.env.GH_HOST = previousGhHost;
  if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
  else process.env.GH_CONFIG_DIR = previousGhConfigDir;
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  Object.defineProperty(process, 'platform', previousPlatform);
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gh config directory', () => {
  test('uses the home default outside Windows even when APPDATA is set', () => {
    delete process.env.GH_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = path.join(os.tmpdir(), 'unused-appdata');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(ghConfigDir()).toBe(path.join(os.homedir(), '.config', 'gh'));
  });

  test('uses the home default on Windows when APPDATA is empty', () => {
    process.env.GH_CONFIG_DIR = '';
    process.env.XDG_CONFIG_HOME = '';
    process.env.APPDATA = '';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(ghConfigDir()).toBe(path.join(os.homedir(), '.config', 'gh'));
  });

  test('discovers Windows default logins without falling back from an override', () => {
    const dir = createHostsYaml('github.explicit.com:\n  user: octocat\n');
    fs.mkdirSync(path.join(dir, 'GitHub CLI'));
    fs.writeFileSync(path.join(dir, 'GitHub CLI', 'hosts.yml'), 'github.windows.com:\n  user: octocat\n');
    fs.mkdirSync(path.join(dir, 'gh'));
    fs.writeFileSync(path.join(dir, 'gh', 'hosts.yml'), 'github.xdg.com:\n  user: octocat\n');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = dir;
    process.env.GH_HOST = '';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.GH_CONFIG_DIR;

    expect(hasStoredGhLogin('github.windows.com')).toBe(true);
    expect(isTrustedGitHubHost('github.windows.com')).toBe(true);
    expect(listTrustedGitHubHosts()).toEqual(['github.windows.com']);

    process.env.XDG_CONFIG_HOME = dir;
    expect(listTrustedGitHubHosts()).toEqual(['github.xdg.com']);
    process.env.GH_CONFIG_DIR = dir;
    expect(listTrustedGitHubHosts()).toEqual(['github.explicit.com']);

    fs.unlinkSync(path.join(dir, 'hosts.yml'));
    expect(listTrustedGitHubHosts()).toEqual([]);
    expect(isTrustedGitHubHost('github.windows.com')).toBe(false);
    fs.writeFileSync(path.join(dir, 'hosts.yml'), '::: not: [valid\n');
    expect(listTrustedGitHubHosts()).toEqual([]);

    delete process.env.GH_CONFIG_DIR;
    fs.unlinkSync(path.join(dir, 'gh', 'hosts.yml'));
    expect(listTrustedGitHubHosts()).toEqual([]);
  });

  test('discovers enterprise logins under XDG_CONFIG_HOME', () => {
    const dir = createHostsYaml('');
    fs.mkdirSync(path.join(dir, 'gh'));
    fs.writeFileSync(path.join(dir, 'gh', 'hosts.yml'), 'github.acme.com:\n  user: octocat\n');
    process.env.XDG_CONFIG_HOME = dir;
    process.env.GH_HOST = '';
    delete process.env.GH_CONFIG_DIR;

    expect(hasStoredGhLogin('github.acme.com')).toBe(true);
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
    expect(listTrustedGitHubHosts()).toEqual(['github.acme.com']);
  });

  test('GH_CONFIG_DIR takes precedence without falling back to XDG_CONFIG_HOME', () => {
    const dir = createHostsYaml('github.explicit.com:\n  user: octocat\n');
    fs.mkdirSync(path.join(dir, 'gh'));
    fs.writeFileSync(path.join(dir, 'gh', 'hosts.yml'), 'github.xdg.com:\n  user: octocat\n');
    process.env.XDG_CONFIG_HOME = dir;

    expect(hasStoredGhLogin('github.explicit.com')).toBe(true);
    expect(hasStoredGhLogin('github.xdg.com')).toBe(false);

    process.env.GH_CONFIG_DIR = path.join(dir, 'missing');
    expect(hasStoredGhLogin('github.xdg.com')).toBe(false);
  });
});

describe('isTrustedGitHubHost', () => {
  test('always trusts github.com and an omitted host', () => {
    expect(isTrustedGitHubHost('github.com')).toBe(true);
    expect(isTrustedGitHubHost('GitHub.COM')).toBe(true);
    expect(isTrustedGitHubHost('')).toBe(true);
    expect(isTrustedGitHubHost(undefined)).toBe(true);
    expect(isTrustedGitHubHost(null)).toBe(true);
  });

  test('trusts the host the server itself targets (GH_HOST)', () => {
    process.env.GH_HOST = 'github.acme.internal';
    expect(isTrustedGitHubHost('github.acme.internal')).toBe(true);
    expect(isTrustedGitHubHost('GITHUB.ACME.INTERNAL')).toBe(true);
    expect(isTrustedGitHubHost('other.example.com')).toBe(false);
  });

  test('trusts a host gh has a stored login for (per-user token)', () => {
    createHostsYaml([
      'github.acme.com:',
      '  users:',
      '    octocat:',
      '      oauth_token: gho_enterprise_secret',
      '  user: octocat',
      '  git_protocol: https',
    ].join('\n'));
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
  });

  test('trusts a host with a direct oauth_token (older gh layout)', () => {
    createHostsYaml('github.acme.com:\n  oauth_token: gho_enterprise_secret\n');
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
  });

  test('rejects a host gh has never stored a login for', () => {
    expect(isTrustedGitHubHost('gitlab.com')).toBe(false);
  });

  test('fails closed when hosts.yml is missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    createdDirs.push(dir);
    // A config dir that exists but has no hosts.yml is "not trusted".
    process.env.GH_CONFIG_DIR = dir;
    expect(isTrustedGitHubHost('github.acme.com')).toBe(false);

    fs.writeFileSync(path.join(dir, 'hosts.yml'), '::: not: [valid\n');
    expect(isTrustedGitHubHost('github.acme.com')).toBe(false);
  });

  test('accepts a host whose entry records an account without a token (keyring-backed gh)', () => {
    // With the OS keyring, gh stores no oauth_token in hosts.yml — the entry
    // is just `user` plus settings. It is still a real stored login.
    createHostsYaml('github.acme.com:\n  user: octocat\n  git_protocol: https\n');
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
  });

  test('accepts a keyring-backed per-user entry with no token', () => {
    createHostsYaml('github.acme.com:\n  users:\n    octocat:\n');
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
  });

  test('rejects an entry that records no account', () => {
    // Settings only, no user/users/oauth_token: nothing proves gh logged in.
    createHostsYaml('ghe.example.com:\n  git_protocol: https\n');
    expect(isTrustedGitHubHost('ghe.example.com')).toBe(false);
  });

  test('matches a stored login recorded under mixed case', () => {
    createHostsYaml('GitHub.Acme.com:\n  users:\n    admin:\n      oauth_token: gho_acme\n');
    expect(isTrustedGitHubHost('github.acme.com')).toBe(true);
  });

  test('fails closed for a host entry with an empty value', () => {
    createHostsYaml('ghe.example.com:\n');
    expect(isTrustedGitHubHost('ghe.example.com')).toBe(false);
  });
});

describe('isTrustedGitHubHostOrStored', () => {
  test('trusts a host the user stored a PAT for even with no gh login and no environment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-trust-stored-'));
    createdDirs.push(dir);
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dir;
    try {
      const { createSourceControlAuthStore } = await import('../source-control/auth-storage.js');
      const store = createSourceControlAuthStore({ filePath: path.join(dir, 'source-control-auth.json') });
      await store.github.setAccount('ghe.stored.example.com', {
        accessToken: 'gho_stored', scope: 'repo', tokenType: 'token', user: { id: 3, login: 'pat-user' }, source: 'pat',
      });
      const { isTrustedGitHubHostOrStored } = await import('./host-trust.js');
      await expect(isTrustedGitHubHostOrStored('ghe.stored.example.com')).resolves.toBe(true);
      await expect(isTrustedGitHubHostOrStored('other.example.com')).resolves.toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
  });
});

describe('hasStoredGhLogin', () => {
  test('is true for a host with a stored login and false without one', () => {
    createHostsYaml('github.acme.com:\n  users:\n    admin:\n      oauth_token: gho_acme\n');
    expect(hasStoredGhLogin('github.acme.com')).toBe(true);
    expect(hasStoredGhLogin('GitHub.Acme.com')).toBe(true);
    expect(hasStoredGhLogin('other.example.com')).toBe(false);
  });

  test('is false for an entry that records no account and for github.com', () => {
    process.env.GH_HOST = '';
    createHostsYaml('ghe.example.com:\n  git_protocol: https\n');
    expect(hasStoredGhLogin('ghe.example.com')).toBe(false);
    // GH_HOST alone is trust, not a gh login.
    process.env.GH_HOST = 'github.corp.example';
    expect(hasStoredGhLogin('github.corp.example')).toBe(false);
    expect(hasStoredGhLogin('github.com')).toBe(false);
  });
});

describe('listTrustedGitHubHosts', () => {
  test('lists stored logins for non-github.com hosts only', () => {
    process.env.GH_HOST = '';
    createHostsYaml([
      'github.com:',
      '  user: octocat',
      'github.acme.com:',
      '  user: alice',
      'ghe.example.com:',
      '  users:',
      '    admin:',
      '  git_protocol: https',
      'gitlab.com:',
      '  user: ci',
      'empty.example.com:',
    ].join('\n'));
    expect(listTrustedGitHubHosts()).toEqual(['ghe.example.com', 'github.acme.com', 'gitlab.com']);
  });

  test('includes GH_HOST even without a hosts.yml login', () => {
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    process.env.GH_HOST = 'github.corp.example';
    expect(listTrustedGitHubHosts()).toEqual(['github.corp.example']);
  });

  test('fails closed with an unreadable config', () => {
    process.env.GH_HOST = '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    createdDirs.push(dir);
    process.env.GH_CONFIG_DIR = dir;
    expect(listTrustedGitHubHosts()).toEqual([]);
  });
});
