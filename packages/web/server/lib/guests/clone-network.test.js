import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_STDOUT_BYTES, cloneGitRepository, gitNetworkArgs, isGitAuthFailure, isPublicHostname, publicAddressesOf, runGit, runGitNetwork } from './clone.js';

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

describe.skipIf(process.platform === 'win32')('runGit stderr tail UTF-8 alignment (#1811)', () => {
  it('a tail cut inside a multi-byte character drops the split half instead of decoding U+FFFD', async () => {
    // 903 a + one 2-byte character + 4095 b = 5000 bytes; the 4096 tail cut
    // lands on the character's continuation byte.
    const { gitBinary } = fakeGit("head -c 903 /dev/zero | tr '\\0' 'a' >&2; printf '\\303\\251' >&2; head -c 4095 /dev/zero | tr '\\0' 'b' >&2; exit 1");
    const result = await runGit(['clone', 'src', 'dest'], { gitBinary });
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('b'.repeat(4095));
    expect(result.stderr?.startsWith('�')).toBe(false);
  });

  it('ASCII and under-cap tails are unchanged', async () => {
    const ascii = fakeGit("printf 'fatal: nope' >&2; exit 1");
    const asciiResult = await runGit(['clone', 'src', 'dest'], { gitBinary: ascii.gitBinary });
    expect(asciiResult.stderr).toBe('fatal: nope');

    const small = fakeGit("printf '\\303\\251clair' >&2; exit 1");
    const smallResult = await runGit(['clone', 'src', 'dest'], { gitBinary: small.gitBinary });
    expect(smallResult.stderr).toBe('éclair');
  });
});

describe.skipIf(process.platform === 'win32')('runGit captured stdout cap', () => {
  it('returns captured stdout under the cap whole', async () => {
    const { gitBinary } = fakeGit(`printf 'hello'`);
    const result = await runGit(['show', 'FETCH_HEAD:package.json'], { gitBinary, capture: true, maxCapturedStdoutBytes: 1024 });
    expect(result).toEqual({ ok: true, stdout: 'hello' });
  });

  it('resolves output-too-large over the cap with no stdout', async () => {
    const { gitBinary } = fakeGit(`head -c 10000 /dev/zero | tr '\\0' 'x'`);
    const result = await runGit(['show', 'FETCH_HEAD:package.json'], { gitBinary, capture: true, maxCapturedStdoutBytes: 1024 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('output-too-large');
    expect(result.stdout).toBeUndefined();
  });

  it('does not buffer stdout when capture is off, however large', async () => {
    const { gitBinary } = fakeGit(`head -c 10000 /dev/zero | tr '\\0' 'x'`);
    const result = await runGit(['clone', 'src', 'dest'], { gitBinary, maxCapturedStdoutBytes: 1024 });
    expect(result).toEqual({ ok: true, stdout: '' });
  });

  it('documents a default cap in the skills-catalog size class', () => {
    expect(MAX_CAPTURED_STDOUT_BYTES).toBe(4 * 1024 * 1024);
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

describe('isPublicHostname IPv6 local ranges (#1517)', () => {
  it.each(['fe80::1', 'fe81::1', 'fe9f::1', 'feaf::1', 'febf::1', 'fe80:0:0:0:0:0:0:1'])(
    'refuses the full fe80::/10 link-local range: %s',
    (host) => {
      expect(isPublicHostname(host)).toBe(false);
    },
  );

  it.each(['fec0::1', 'feff::1'])('refuses the deprecated fec0::/10 site-local range: %s', (host) => {
    expect(isPublicHostname(host)).toBe(false);
  });

  it.each(['fc00::1', 'fd12:3456::1', '::1'])('keeps refusing existing IPv6 controls: %s', (host) => {
    expect(isPublicHostname(host)).toBe(false);
  });

  it('keeps public addresses and hostnames public, and private IPv4 refused', () => {
    expect(isPublicHostname('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
    expect(isPublicHostname('93.184.216.34')).toBe(true);
    expect(isPublicHostname('example.com')).toBe(true);
    expect(isPublicHostname('10.0.0.1')).toBe(false);
    expect(isPublicHostname('192.168.1.1')).toBe(false);
  });
});

describe('publicAddressesOf / gitNetworkArgs IPv6 local ranges (#1517)', () => {
  it('refuses an in-range literal without resolving it', async () => {
    expect(await publicAddressesOf('fe90::1')).toBeNull();
    expect(await publicAddressesOf('fec0::1')).toBeNull();
  });

  it('fails closed when a DNS answer lands in fe80::/10, producing no curloptResolve args', async () => {
    const lookup = async () => [{ address: 'fe90::1', family: 6 }];
    expect(await publicAddressesOf('example.com', lookup)).toBeNull();
    expect(await gitNetworkArgs('https://example.com/org/panel.git', lookup)).toBeNull();
  });

  it('fails closed when any one of several DNS answers is in range', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: 'febf::1', family: 6 }];
    expect(await publicAddressesOf('example.com', lookup)).toBeNull();
    expect(await gitNetworkArgs('https://example.com/org/panel.git', lookup)).toBeNull();
  });

  it('still pins a public DNS answer into curloptResolve', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    expect(await gitNetworkArgs('https://example.com/org/panel.git', lookup)).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'http.curloptResolve=example.com:443:93.184.216.34',
    ]);
  });
});
