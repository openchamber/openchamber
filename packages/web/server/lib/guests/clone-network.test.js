import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneGitRepository, isGitAuthFailure, runGit, runGitNetwork } from './clone.js';
import { checkGuestUpdate } from './updates.js';

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

describe.skipIf(process.platform === 'win32')('runGit timeout', () => {
  // A stand-in git that never finishes and records the signal it receives.
  const hangingGit = (onTerm) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-hang-git-'));
    dirs.push(dir);
    const marker = path.join(dir, 'signal');
    const file = path.join(dir, 'git');
    fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'SIGTERM'); ${onTerm} });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    return { gitBinary: file, marker };
  };

  it('sends SIGTERM first so git can clean up after itself', async () => {
    const { gitBinary, marker } = hangingGit('process.exit(1);');
    const started = Date.now();

    const result = await runGit(['fetch'], { gitBinary, timeoutMs: 1000 });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('falls back to SIGKILL when the child ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGKILL') child.emit('close', null);
      return true;
    });
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValueOnce(child);
    syncBuiltinESMExports();
    try {
      const pending = runGit(['fetch'], { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      expect(await pending).toEqual({ ok: false, stderr: '' });
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
      vi.useRealTimers();
    }
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
  it('answers clone-auth-failed when the host refuses the login', async () => {
    const { gitBinary } = fakeGit(`echo "fatal: Authentication failed for 'https://example.com/r.git/'" >&2
exit 128`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await cloneGitRepository('https://example.com/r.git', 'dest', { gitBinary });

    expect(result).toEqual({ ok: false, code: 'clone-auth-failed' });
  });

  it('keeps clone-failed for other failures', async () => {
    const { gitBinary } = fakeGit(`echo "fatal: repository not found" >&2
exit 128`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await cloneGitRepository('https://example.com/r.git', 'dest', { gitBinary });

    expect(result).toEqual({ ok: false, code: 'clone-failed' });
  });

  describe('with a Git identity that signs in with a connected account', () => {
    const token = 'account-private-token';
    const source = 'https://github.com/acme/private-extension.git';
    const account = { provider: 'github', instance: 'github.com', accountId: 'github-account' };
    const gitAccounts = () => ({
      readAccount: vi.fn(async () => ({ credentialId: 'github-account', credentialRevision: 1, providerUserId: 'github.com#42' })),
      credentialResolver: {
        resolve: vi.fn(async ({ endpoint }) => ({
          mode: 'managed', transport: 'https', username: 'x-access-token', password: token, allowedEndpoint: endpoint,
        })),
      },
    });
    // Asks the helpers it was configured with for the login, the way git does when the host answers 401.
    const loginRecordingGit = () => fakeGit(`echo "$*" >> "$(dirname "$0")/calls"
printf '%s' "$GIT_CONFIG_NOSYSTEM:$GIT_CONFIG_GLOBAL" > "$(dirname "$0")/config-env"
helper=""
for arg in "$@"; do case "$arg" in credential.helper=!*) helper="\${arg#credential.helper=!}";; esac; done
[ -n "$helper" ] || exit 128
printf 'protocol=https\\nhost=github.com\\npath=acme/private-extension.git\\n\\n' | sh -c "$helper get" > "$(dirname "$0")/login"`);

    it('clones over HTTPS with that account, without putting its token on the command line', async () => {
      const { createProfile } = await import('../git/identity-storage.js');
      createProfile({ id: 'work-account', name: 'Work', userName: 'Work', userEmail: 'work@example.com', transport: 'account', account });
      const { gitBinary, calls } = loginRecordingGit();
      const accounts = gitAccounts();

      const result = await cloneGitRepository(source, 'dest', { gitBinary, gitIdentityId: 'work-account', gitAccounts: accounts });

      expect(result).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(path.dirname(gitBinary), 'login'), 'utf8')).toBe(`username=x-access-token\npassword=${token}\n\n`);
      expect(fs.readFileSync(calls, 'utf8')).not.toContain(token);
      expect(accounts.readAccount).toHaveBeenCalledWith(account);
      // No system or user Git config: a server-side insteadOf, helper or proxy must not see the login.
      expect(fs.readFileSync(path.join(path.dirname(gitBinary), 'config-env'), 'utf8')).toBe('1:/dev/null');
    });

    it('fails instead of falling back to the server login when no account can be read', async () => {
      const { createProfile } = await import('../git/identity-storage.js');
      createProfile({ id: 'gone-account', name: 'Gone', userName: 'Gone', userEmail: 'gone@example.com', transport: 'account', account });
      const { gitBinary, calls } = loginRecordingGit();
      const accounts = gitAccounts();
      accounts.readAccount.mockResolvedValue(null);

      const result = await cloneGitRepository(source, 'dest', { gitBinary, gitIdentityId: 'gone-account', gitAccounts: accounts });

      expect(result).toEqual({ ok: false, code: 'clone-failed' });
      expect(fs.existsSync(calls)).toBe(false);
    });

    it('checks for updates with that account', async () => {
      const { createProfile } = await import('../git/identity-storage.js');
      createProfile({ id: 'update-account', name: 'Update', userName: 'Update', userEmail: 'update@example.com', transport: 'account', account });
      const manifest = JSON.stringify({ name: 'fixture', version: '1.1.0',
        openchamber: { apiVersion: 1, contributes: { panel: { id: 'fixture', name: 'Fixture', icon: 'window', entry: 'panel/index.html' } } } });
      const { gitBinary } = fakeGit(`case "$1" in
  init) exit 0;;
  show) [ -s "$(dirname "$0")/login" ] && printf '%s' '${manifest}' && exit 0; exit 128;;
esac
helper=""
for arg in "$@"; do case "$arg" in credential.helper=!*) helper="\${arg#credential.helper=!}";; esac; done
[ -n "$helper" ] || exit 128
printf 'protocol=https\\nhost=github.com\\npath=acme/private-extension.git\\n\\n' | sh -c "$helper get" > "$(dirname "$0")/login"`);

      const result = await checkGuestUpdate({
        guest: { version: '1.0.0', packageRoot: '/extensions/fixture' },
        origin: { url: source, gitIdentityId: 'update-account' },
        gitBinary, gitAccounts: gitAccounts(),
      });

      expect(result).toEqual({ available: true, version: '1.1.0', requested: [] });
    });
  });
});
