import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneGitRepository, isGitAuthFailure, runGitNetwork } from './clone.js';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// A stand-in git that behaves like a schannel-only Git for Windows whose system
// config asks for OpenSSL (issue #4040): refuses unless a backend it has is set.
const fakeGit = (script) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fake-git-'));
  dirs.push(dir);
  const file = path.join(dir, 'git');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { gitBinary: file, calls: path.join(dir, 'calls') };
};

describe.skipIf(process.platform === 'win32')('runGitNetwork', () => {
  it('retries once on a backend the git build supports', async () => {
    const { gitBinary, calls } = fakeGit(`echo "$*" >> "$(dirname "$0")/calls"
case "$*" in *http.sslBackend=schannel*) exit 0;; esac
echo "fatal: Unsupported SSL backend 'openssl'. Supported SSL backends:" >&2
echo "	schannel" >&2
exit 128`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runGitNetwork(['clone', '--', 'https://example.com/r.git', 'dest'], { gitBinary });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith('-c http.sslBackend=schannel clone')).toBe(true);
  });

  it('does not retry other failures and logs what git said', async () => {
    const { gitBinary, calls } = fakeGit(`echo "$*" >> "$(dirname "$0")/calls"
echo "fatal: repository not found" >&2
exit 128`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runGitNetwork(['clone', '--', 'https://example.com/r.git', 'dest'], { gitBinary });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('repository not found');
  });
});

describe('isGitAuthFailure', () => {
  it.each([
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'remote: HTTP Basic: Access denied',
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
  ])('recognises a refused login: %s', (stderr) => {
    expect(isGitAuthFailure(stderr)).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(isGitAuthFailure('fatal: unable to access: Could not resolve host: example.com')).toBe(false);
    expect(isGitAuthFailure(undefined)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('cloneGitRepository', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('answers clone-auth-failed when the host refuses the login', async () => {
    const { gitBinary } = fakeGit(`echo "fatal: Authentication failed for 'https://example.com/r.git/'" >&2
exit 128`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await cloneGitRepository('https://example.com/r.git', 'dest', { gitBinary, lookup });

    expect(result).toEqual({ ok: false, code: 'clone-auth-failed' });
  });

  it('keeps clone-failed for other failures', async () => {
    const { gitBinary } = fakeGit(`echo "fatal: repository not found" >&2
exit 128`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await cloneGitRepository('https://example.com/r.git', 'dest', { gitBinary, lookup });

    expect(result).toEqual({ ok: false, code: 'clone-failed' });
  });
});
