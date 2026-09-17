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

const { getOctokitOrNull, selectTokenForHost } = await import('./octokit.js');

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
  test('refuses an untrusted host before any token lookup, even with an enterprise token and working gh on PATH', () => {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    const previousToken = process.env.GH_ENTERPRISE_TOKEN;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.GH_ENTERPRISE_TOKEN = 'env-enterprise-token';
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      expect(getOctokitOrNull('gitlab.com')).toBeNull();
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

  test('lets github.com past the trust gate into token selection', () => {
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    fs.rmSync(ghInvoked, { force: true });
    try {
      getOctokitOrNull('github.com');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    // The gate always passes for github.com, so getGhCliToken runs a real gh;
    // the recorded host is proof gh token setup was consulted.
    const invoked = fs.existsSync(ghInvoked)
      ? fs.readFileSync(ghInvoked, 'utf8').split('\n').filter(Boolean)
      : [];
    expect(invoked).toContain('github.com');
  });
});
