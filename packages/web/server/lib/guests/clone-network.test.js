import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGitNetwork } from './clone.js';

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
