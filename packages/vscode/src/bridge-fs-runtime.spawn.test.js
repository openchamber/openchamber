import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as os from 'node:os';

// Behaviour tests for api:fs:exec against the real child_process spawn:
// only `vscode` is mocked, so these run the actual shell the extension
// host would launch and pin the single-parse semantics the web server's
// spawn argv form has. The mocked launch-form tests live in
// bridge-fs-runtime.test.js.
mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {},
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  FileType: {
    Directory: 2,
  },
  window: {},
}));

const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value) => value,
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  parseDroppedFileReference: mock(),
  readUriAsAttachment: mock(),
};

const runOne = async (command) => {
  const response = await handleFsBridgeMessage(
    { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd: os.tmpdir() } },
    deps,
  );
  expect(response?.success).toBe(true);
  return response?.data?.results?.[0];
};

// The divergent cases are POSIX shell semantics; on Windows the handler
// launches cmd.exe /c, whose quoting rules are a different contract.
const onPosix = process.platform !== 'win32';

describe('bridge fs exec spawn behaviour (real shell)', () => {
  beforeEach(() => {
    process.env.SHELL = '/bin/sh';
    clearGitReadCacheForTests();
  });

  it('keeps a single-quoted $HOME literal', async () => {
    if (!onPosix) return;
    const result = await runOne("printf '%s' '$HOME'");
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: '$HOME' });
  });

  it('does not execute a single-quoted command substitution', async () => {
    if (!onPosix) return;
    const result = await runOne("printf '%s' '$(echo SUBSTITUTED)'");
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: '$(echo SUBSTITUTED)' });
  });

  it('sees a variable assigned earlier in the same command', async () => {
    if (!onPosix) return;
    const result = await runOne('X=hello; printf \'%s\' "$X"');
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'hello' });
  });

  it('returns output under the exec cap whole', async () => {
    if (!onPosix) return;
    const result = await runOne("head -c 100000 /dev/zero | tr '\\0' 'a'");
    expect(result.success).toBe(true);
    expect(result.stdout).toHaveLength(100000);
  });

  it('stops an over-cap stdout command and marks output-too-large', async () => {
    if (!onPosix) return;
    const result = await runOne("head -c 5000000 /dev/zero | tr '\\0' 'a'");
    expect(result.success).toBe(false);
    expect(result.error).toContain('output-too-large');
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.stdout.length).toBeLessThan(5000000);
  });

  it('bounds stderr the same way', async () => {
    if (!onPosix) return;
    const result = await runOne("head -c 5000000 /dev/zero | tr '\\0' 'e' >&2");
    expect(result.success).toBe(false);
    expect(result.error).toContain('output-too-large');
    expect(result.stderr.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.stderr.length).toBeLessThan(5000000);
  });

  it('settles an over-cap result promptly when a descendant holds the pipes', async () => {
    if (!onPosix) return;
    // The flooding descendant outlives a shell-only kill and keeps the
    // pipes open; the tree kill must settle the result anyway (#913).
    const startedAt = Date.now();
    const result = await runOne("yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' & sleep 60");
    expect(Date.now() - startedAt).toBeLessThan(20000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('output-too-large');
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('reports a non-zero exit with trimmed output instead of throwing', async () => {
    if (!onPosix) return;
    const result = await runOne("printf ' out '; printf ' err ' >&2; exit 3");
    expect(result).toMatchObject({ success: false, exitCode: 3, stdout: 'out', stderr: 'err' });
  });
});
