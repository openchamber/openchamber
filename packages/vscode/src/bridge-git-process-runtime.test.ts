import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGitExecMaxOutputBytes,
  createGitExecTimeoutMs,
  execGit,
  GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
  GIT_EXEC_DEFAULT_TIMEOUT_MS,
  stopGitProcesses,
} from './bridge-git-process-runtime';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readPids = async (marker: string) => (await fs.readFile(marker, 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(Number);

const waitForPids = async (marker: string, count: number) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pids = await readPids(marker);
    if (pids.length === count) return pids;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture processes did not start');
};

// Windows keeps a killed process's working directory busy until it has fully exited. Bun ignores
// the `maxRetries` option of `fs.rm`, so the retry is spelled out.
const removeWhenReleased = async (directory: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 50 || !(error instanceof Error && 'code' in error && error.code === 'EBUSY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

const holdingCommand = (marker: string) => `
  process.on('SIGTERM', () => {});
  require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
  setInterval(() => {}, 1000);
`;

test('a Git process terminated by a signal is never reported as successful', { skip: process.platform === 'win32' }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-git-'));
  try {
    const result = await execGit(['-c', 'alias.oc-interrupt=!kill -TERM "$PPID"', 'oc-interrupt'], cwd);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// Twelve processes, a 1.5 s deadline and a tree kill each take about 4.5 s on Windows, too close to
// Bun's 5 s default under a parallel run.
test('repeated read deadlines terminate the processes, not just the waiters', { timeout: 30_000 }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-deadlines-'));
  const marker = path.join(cwd, 'pids');
  try {
    const requests = Array.from({ length: 12 }, () => execGit(['-e', holdingCommand(marker)], cwd, {
      binary: process.execPath, timeoutMs: 1500,
    }));
    const pids = await waitForPids(marker, 12);
    assert.ok(pids.every(alive), 'all twelve commands must actually run');
    const results = await Promise.all(requests);
    assert.ok(results.every((result) => result.exitCode !== 0 && result.stderr.includes('timed out')));
    assert.deepEqual(pids.filter(alive), []);
  } finally {
    for (const pid of await readPids(marker)) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await removeWhenReleased(cwd);
  }
});

test('drains verbose stderr and sends EOF to non-interactive command stdin', async () => {
  const result = await execGit(['-e', `
    const fs = require('node:fs');
    for (let i = 0; i < 32; i++) fs.writeSync(2, Buffer.alloc(65536, 'x'));
    process.stdin.on('end', () => process.stdout.write('eof'));
    process.stdin.resume();
  `], os.tmpdir(), { binary: process.execPath, timeoutMs: 3000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'eof');
  assert.equal(result.stderr.length, 2 * 1024 * 1024);
});

test('returns output under the per-call cap whole with its real exit code', async () => {
  const result = await execGit(['-e', `
    process.stdout.write('hello');
    process.stderr.write('warn');
    process.exitCode = 3;
  `], os.tmpdir(), { binary: process.execPath, maxOutputBytes: 1024, timeoutMs: 3000 });
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'warn');
  assert.equal(result.exitCode, 3);
});

test('over-cap stdout terminates the child and resolves output-too-large', { timeout: 30_000 }, async () => {
  const result = await execGit(['-e', `
    process.stdout.write('x'.repeat(10000));
    setInterval(() => {}, 1000);
  `], os.tmpdir(), { binary: process.execPath, maxOutputBytes: 1024, timeoutMs: 3000 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 1024);
  assert.match(result.stderr, /output-too-large/);
});

test('over-cap stderr terminates the child and resolves output-too-large', { timeout: 30_000 }, async () => {
  const result = await execGit(['-e', `
    process.stderr.write('e'.repeat(10000));
    setInterval(() => {}, 1000);
  `], os.tmpdir(), { binary: process.execPath, maxOutputBytes: 512, timeoutMs: 3000 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /output-too-large/);
});

test('decodes stdout and stderr split inside multi-byte characters like one chunk', async () => {
  const text = 'café 🔑 end';
  const chunked = await execGit(['-e', `
    const bytes = Buffer.from(${JSON.stringify(text)}, 'utf8');
    for (const stream of [process.stdout, process.stderr]) {
      stream.write(bytes.subarray(0, 4));
      setTimeout(() => {
        stream.write(bytes.subarray(4, 8));
        setTimeout(() => stream.write(bytes.subarray(8)), 20);
      }, 20);
    }
  `], os.tmpdir(), { binary: process.execPath, timeoutMs: 3000 });
  const control = await execGit(['-e', `
    const text = ${JSON.stringify(text)};
    process.stdout.write(text);
    process.stderr.write(text);
  `], os.tmpdir(), { binary: process.execPath, timeoutMs: 3000 });

  assert.equal(chunked.exitCode, 0);
  assert.equal(chunked.stdout, text);
  assert.equal(chunked.stderr, text);
  assert.equal(chunked.stdout, control.stdout);
  assert.equal(chunked.stderr, control.stderr);
});

test('keeps a capped stdout prefix on a whole character', async () => {
  const result = await execGit(['-e', `
    process.stdout.write(Buffer.from('café', 'utf8'));
    setInterval(() => {}, 1000);
  `], os.tmpdir(), { binary: process.execPath, maxOutputBytes: 4, timeoutMs: 3000 });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'caf');
  assert.doesNotMatch(result.stdout, /\uFFFD/);
  assert.match(result.stderr, /output-too-large/);
});

test('git exec env readers fall back to the documented defaults', () => {
  const timeoutEnv = process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
  const outputEnv = process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES;
  try {
    delete process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
    delete process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES;
    assert.equal(createGitExecTimeoutMs(), GIT_EXEC_DEFAULT_TIMEOUT_MS);
    assert.equal(createGitExecMaxOutputBytes(), GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES);
    process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = '250';
    process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES = '2048';
    assert.equal(createGitExecTimeoutMs(), 250);
    assert.equal(createGitExecMaxOutputBytes(), 2048);
    process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = '5.9';
    process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES = '0';
    assert.equal(createGitExecTimeoutMs(), GIT_EXEC_DEFAULT_TIMEOUT_MS);
    process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = '2147483648';
    assert.equal(createGitExecTimeoutMs(), GIT_EXEC_DEFAULT_TIMEOUT_MS);
    assert.equal(createGitExecMaxOutputBytes(), GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES);
  } finally {
    if (timeoutEnv === undefined) delete process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
    else process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = timeoutEnv;
    if (outputEnv === undefined) delete process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES;
    else process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES = outputEnv;
  }
});

test('a command with no caller deadline is bounded by the default timeout', { timeout: 30_000 }, async () => {
  const timeoutEnv = process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
  process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = '200';
  try {
    const result = await execGit(['-e', 'setInterval(() => {}, 1000);'], os.tmpdir(), { binary: process.execPath });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timed out after 200ms/);
  } finally {
    if (timeoutEnv === undefined) delete process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
    else process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = timeoutEnv;
  }
});

test('a caller deadline wins over the default timeout', { timeout: 30_000 }, async () => {
  const timeoutEnv = process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
  process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = '60000';
  try {
    const started = Date.now();
    const result = await execGit(['-e', 'setInterval(() => {}, 1000);'], os.tmpdir(), {
      binary: process.execPath, timeoutMs: 200,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timed out after 200ms/);
    assert.ok(Date.now() - started < 10000);
  } finally {
    if (timeoutEnv === undefined) delete process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS;
    else process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS = timeoutEnv;
  }
});

test('deactivation terminates outstanding Git work and rejects new launches', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-stop-'));
  const marker = path.join(cwd, 'pids');
  try {
    const pending = execGit(['-e', holdingCommand(marker)], cwd, { binary: process.execPath });
    const pids = await waitForPids(marker, 1);
    await stopGitProcesses();
    assert.notEqual((await pending).exitCode, 0);
    assert.deepEqual(pids.filter(alive), []);
    const after = await execGit(['-e', holdingCommand(marker)], cwd, { binary: process.execPath });
    assert.notEqual(after.exitCode, 0);
    assert.equal((await readPids(marker)).length, 1);
  } finally {
    for (const pid of await readPids(marker)) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
