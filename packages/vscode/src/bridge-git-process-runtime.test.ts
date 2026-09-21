import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execGit, stopGitProcesses } from './bridge-git-process-runtime';

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

test('repeated read deadlines terminate the processes, not just the waiters', async () => {
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
    await fs.rm(cwd, { recursive: true, force: true });
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
