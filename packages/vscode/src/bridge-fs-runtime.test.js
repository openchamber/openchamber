import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawnCalls = [];
let spawnExitCode = 0;
let spawnStdout = '/repo/.git\n/repo/.git\n';
let spawnStderr = '';
let spawnStdoutChunks = null;
let spawnStderrChunks = null;

const spawnMock = mock((file, args, options) => {
  spawnCalls.push({ file, args, options });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock(() => true);
  setTimeout(() => {
    if (spawnStdoutChunks) {
      for (const chunk of spawnStdoutChunks) {
        child.stdout.emit('data', chunk);
      }
    } else if (spawnStdout) {
      child.stdout.emit('data', Buffer.from(spawnStdout));
    }
    if (spawnStderrChunks) {
      for (const chunk of spawnStderrChunks) {
        child.stderr.emit('data', chunk);
      }
    } else if (spawnStderr) {
      child.stderr.emit('data', Buffer.from(spawnStderr));
    }
    child.emit('close', spawnExitCode, null);
  }, 10);
  return child;
});

mock.module('child_process', () => ({
  spawn: spawnMock,
}));

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

const {
  FS_EXEC_OUTPUT_MAX_BYTES,
  FS_READ_MAX_BYTES,
  clearGitReadCacheForTests,
  createFsExecOutputMaxBytes,
  createGitCheckIgnoreTimeoutMs,
  createGitReadCacheTtlMs,
  handleFsBridgeMessage,
} = await import('./bridge-fs-runtime');

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

describe('bridge fs exec git read cache', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnExitCode = 0;
    spawnStdout = '/repo/.git\n/repo/.git\n';
    spawnStderr = '';
    clearGitReadCacheForTests();
  });

  it('dedupes in-flight cacheable git reads and reuses fresh results', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const cwd = '/repo';

    const [first, second] = await Promise.all([
      handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
      handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
    ]);

    expect(first?.success).toBe(true);
    expect(second?.success).toBe(true);
    expect(spawnCalls).toHaveLength(1);

    const spacedCommand = 'git   rev-parse   --absolute-git-dir   --git-common-dir';
    const cached = await handleFsBridgeMessage({ id: '3', type: 'api:fs:exec', payload: { commands: [spacedCommand], cwd } }, deps);

    expect(spawnCalls).toHaveLength(1);
    expect(cached?.data?.results?.[0]).toMatchObject({
      command: spacedCommand,
      success: true,
      stdout: '/repo/.git\n/repo/.git',
    });
  });

  it('does not cache arbitrary exec commands', async () => {
    const command = 'git status --porcelain';
    const cwd = '/repo';

    await handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);
    await handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);

    expect(spawnCalls).toHaveLength(2);
  });
});

describe('bridge fs exec spawn launch', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnExitCode = 0;
    spawnStdout = '/repo/.git\n/repo/.git\n';
    spawnStderr = '';
    clearGitReadCacheForTests();
  });

  it('launches the command as a single argv entry, not an interpolated exec string', async () => {
    // A command packed with constructs an outer shell would rewrite if the
    // command were interpolated into a shell string: double quotes, $VAR,
    // and a single-quoted command substitution.
    const command = `printf '%s' "$(echo outer)" '$HOME'`;
    const cwd = '/repo';

    const response = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } },
      deps,
    );

    expect(response?.success).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    const expectedShell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    const expectedFlag = process.platform === 'win32' ? '/c' : '-c';
    expect(spawnCalls[0].file).toBe(expectedShell);
    expect(spawnCalls[0].args).toEqual([expectedFlag, command]);
    expect(spawnCalls[0].options).toMatchObject({ cwd, windowsHide: true });
  });

  it('reports a non-zero exit as a result instead of throwing', async () => {
    spawnExitCode = 3;
    spawnStdout = 'partial out\n';
    spawnStderr = 'boom\n';
    const command = 'git status --porcelain';
    const cwd = '/repo';

    const response = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } },
      deps,
    );

    expect(response?.success).toBe(true);
    expect(response?.data?.results?.[0]).toMatchObject({
      command,
      success: false,
      exitCode: 3,
      stdout: 'partial out',
      stderr: 'boom',
    });
  });
});

describe('bridge fs exec output cap env reader', () => {
  const name = 'OPENCHAMBER_FS_EXEC_OUTPUT_MAX_BYTES';
  let saved;
  beforeEach(() => {
    saved = process.env[name];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });

  it('falls back to 4 MiB when unset, not a plain decimal, or 0', () => {
    delete process.env[name];
    expect(createFsExecOutputMaxBytes()).toBe(FS_EXEC_OUTPUT_MAX_BYTES);
    for (const value of ['', ' ', '1e3', '0x10', '5.9', '-5', '0']) {
      process.env[name] = value;
      expect(createFsExecOutputMaxBytes()).toBe(FS_EXEC_OUTPUT_MAX_BYTES);
    }
  });

  it('honours a positive plain decimal value', () => {
    process.env[name] = '2048';
    expect(createFsExecOutputMaxBytes()).toBe(2048);
  });
});

describe('bridge fs env readers', () => {
  const readers = [
    ['OPENCHAMBER_GIT_READ_CACHE_TTL_MS', createGitReadCacheTtlMs, 30_000],
    ['OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS', createGitCheckIgnoreTimeoutMs, 2500],
  ];

  for (const [name, read, fallback] of readers) {
    describe(name, () => {
      let saved;
      beforeEach(() => {
        saved = process.env[name];
      });
      afterEach(() => {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      });

      it('falls back when the variable is unset or not a plain decimal', () => {
        delete process.env[name];
        expect(read()).toBe(fallback);
        // '' and ' ' read as 0 under bare Number(...): that would disable the
        // cache / disarm the kill timeout. Exponent, hex and fractional
        // spellings are numbers the user never wrote.
        for (const value of ['', ' ', '1e3', '0x10', '5.9', '-5', '10ms']) {
          process.env[name] = value;
          expect(read()).toBe(fallback);
        }
      });

      it('honours a plain decimal value, including an explicit 0', () => {
        process.env[name] = '0';
        expect(read()).toBe(0);
        process.env[name] = '1500';
        expect(read()).toBe(1500);
      });
    });
  }
});

describe('bridge fs check-ignore timeout timer bound', () => {
  const name = 'OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS';
  let saved;
  beforeEach(() => {
    saved = process.env[name];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });

  it('falls back to the default above the timer maximum', () => {
    process.env[name] = '2147483647';
    expect(createGitCheckIgnoreTimeoutMs()).toBe(2_147_483_647);
    process.env[name] = '3000000000';
    expect(createGitCheckIgnoreTimeoutMs()).toBe(2500);
    process.env[name] = '9007199254740993';
    expect(createGitCheckIgnoreTimeoutMs()).toBe(2500);
  });
});

describe('bridge fs read size cap', () => {
  let dir;
  const readDeps = {
    ...deps,
    resolveFileReadPath: mock(async (target) => ({ ok: true, resolvedPath: target })),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-bridge-fs-read-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a small file exactly as before', async () => {
    const file = path.join(dir, 'small.txt');
    fs.writeFileSync(file, 'hello');
    const response = await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: { path: file } }, readDeps);
    expect(response.success).toBe(true);
    expect(response.data.content).toBe('hello');
    expect(response.data.path).toBe(file);
  });

  it('returns a file at the cap', async () => {
    const file = path.join(dir, 'at-cap.txt');
    fs.writeFileSync(file, 'a'.repeat(FS_READ_MAX_BYTES));
    const response = await handleFsBridgeMessage({ id: '2', type: 'api:fs:read', payload: { path: file } }, readDeps);
    expect(response.success).toBe(true);
    expect(response.data.content.length).toBe(FS_READ_MAX_BYTES);
  });

  it('refuses a file over the cap with an error naming the limit', async () => {
    const file = path.join(dir, 'over-cap.txt');
    fs.writeFileSync(file, 'a'.repeat(FS_READ_MAX_BYTES + 1));
    const response = await handleFsBridgeMessage({ id: '3', type: 'api:fs:read', payload: { path: file } }, readDeps);
    expect(response.success).toBe(false);
    expect(response.error).toBe(`File exceeds maximum size of ${FS_READ_MAX_BYTES} bytes`);
  });
});

describe('bridge fs exec chunked output decoding (#1590)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnExitCode = 0;
    spawnStdout = '';
    spawnStderr = '';
    spawnStdoutChunks = null;
    spawnStderrChunks = null;
    clearGitReadCacheForTests();
  });

  afterEach(() => {
    spawnStdoutChunks = null;
    spawnStderrChunks = null;
  });

  const execOne = async (command) => {
    const response = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd: '/repo' } },
      deps,
    );
    expect(response?.success).toBe(true);
    return response?.data?.results?.[0];
  };

  it('decodes stdout split inside multi-byte characters exactly like one chunk', async () => {
    const text = 'café \u{1F511} end';
    const full = Buffer.from(text, 'utf8');
    // Split inside the 2-byte é (bytes 3-4) and inside the 4-byte key
    // (bytes 6-9): per-chunk toString() turned each half into U+FFFD.
    spawnStdoutChunks = [full.subarray(0, 4), full.subarray(4, 8), full.subarray(8)];

    const chunked = await execOne('printf chunked');
    expect(chunked?.stdout).toBe(text);

    spawnStdoutChunks = null;
    spawnStdout = text;
    const control = await execOne('printf control');
    expect(chunked?.stdout).toBe(control?.stdout);
  });

  it('decodes stderr split inside multi-byte characters exactly like one chunk', async () => {
    const text = 'café \u{1F511} end';
    const full = Buffer.from(text, 'utf8');
    spawnStderrChunks = [full.subarray(0, 4), full.subarray(4, 8), full.subarray(8)];

    const chunked = await execOne('printf chunked >&2');
    expect(chunked?.stderr).toBe(text);
  });

  it('keeps the capped prefix on a whole character instead of inventing U+FFFD', async () => {
    // One byte of headroom, then a 2-byte é straddling the cap: the kept
    // prefix must end before it, with no replacement character added.
    const prefix = 'a'.repeat(FS_EXEC_OUTPUT_MAX_BYTES - 1);
    spawnStdoutChunks = [Buffer.from(prefix + 'é', 'utf8')];

    const result = await execOne('printf capped');
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('output-too-large');
    expect(result?.stdout).toBe(prefix);
    expect(result?.stdout).not.toContain('\uFFFD');
  });
});
