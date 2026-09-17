import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const { isTrustedGitHubHost } = await import('./host-trust.js');

// isTrustedGitHubHost reads GH_HOST and hosts.yml at call time (no memo), so
// tests just set and restore the environment around each case.
const previousGhHost = process.env.GH_HOST;
const previousGhConfigDir = process.env.GH_CONFIG_DIR;
const createdDirs = [];

const createHostsYaml = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'hosts.yml'), content);
  process.env.GH_CONFIG_DIR = dir;
};

afterEach(() => {
  if (previousGhHost === undefined) delete process.env.GH_HOST;
  else process.env.GH_HOST = previousGhHost;
  if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
  else process.env.GH_CONFIG_DIR = previousGhConfigDir;
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
