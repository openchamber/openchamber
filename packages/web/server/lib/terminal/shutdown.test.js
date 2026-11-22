import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import { shutdownTerminalProcesses } from './shutdown.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The grace a child gets to run its SIGTERM handler. Under the full suite's load a child can need longer
// than the old 1500 ms, and then SIGKILL lands first, so no SIGTERM is recorded. Each test still ends as
// soon as its children exit, so the longer grace only costs time when a child is slow.
const GRACE_MS = 5000;
test('Windows shutdown leaves teardown to each PTY and continues after a kill failure', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const posixKill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected POSIX signal'); });
  const signals = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await shutdownTerminalProcesses([
      { process: { pid: 100_001, kill: signal => { signals.push(signal); throw new Error('already gone'); } }, shellExecutable: 'cmd.exe' },
      { process: { pid: 100_002, kill: signal => { signals.push(signal); } }, shellExecutable: 'powershell.exe' },
    ]);
    assert.deepEqual(signals, [undefined, undefined]);
    assert.equal(posixKill.mock.calls.length, 0);
  } finally {
    posixKill.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
const script = `
const fs = require('node:fs');
const [file, mode] = process.argv.slice(1);
const record = event => fs.appendFileSync(file, JSON.stringify({ pid: process.pid, event }) + '\\n');
process.on('SIGHUP', () => record('SIGHUP'));
process.on('SIGTERM', () => {
  record('SIGTERM');
  if (mode === 'ignore') return;
  if (mode === 'parent') return process.exit(0);
  setTimeout(() => { record('complete'); process.exit(0); }, 250);
});
record('ready');
setInterval(() => {}, 1000);
`;

async function fixture(t, mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-shutdown-'));
  const file = path.join(dir, 'events.jsonl');
  const source = script + (mode === 'parent' ? `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}, file, 'worker'], { detached: true, stdio: 'ignore' }).unref();` : '');
  const child = spawn(process.execPath, ['-e', source, file, mode], { detached: true, stdio: 'ignore' });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const events = async () => { try { return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  t.onTestFinished(async () => {
    for (const pid of new Set([child.pid, ...(await events()).map(event => event.pid)])) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    await exit;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const count = mode === 'parent' ? 2 : 1;
  for (let i = 0; i < 100 && (await events()).filter(event => event.event === 'ready').length < count; i++) await delay(20);
  assert.equal((await events()).filter(event => event.event === 'ready').length, count);
  return { terminal: { process: { pid: child.pid, kill: signal => child.kill(signal) }, shellExecutable: '/bin/sh' }, events, exit };
}

test('graceful shutdown lets concurrent exec workloads finish without SIGHUP or SIGKILL', { skip: process.platform === 'win32' }, async t => {
  const first = await fixture(t, 'worker');
  const second = await fixture(t, 'worker');
  await shutdownTerminalProcesses([first.terminal, second.terminal], { graceMs: GRACE_MS });
  for (const run of [first, second]) {
    assert.deepEqual((await run.events()).map(event => event.event), ['ready', 'SIGTERM', 'complete']);
    assert.deepEqual(await run.exit, { code: 0, signal: null });
  }
});

test('waits for a separate process group after its parent exits', { skip: process.platform === 'win32' }, async t => {
  const run = await fixture(t, 'parent');
  await shutdownTerminalProcesses([run.terminal], { graceMs: GRACE_MS });
  const events = await run.events();
  assert.equal(events.filter(event => event.event === 'SIGTERM').length, 2);
  assert.equal(events.filter(event => event.event === 'complete').length, 1);
  assert.deepEqual(await run.exit, { code: 0, signal: null });
});

test('escalates a noncooperative workload only after the shared deadline', { skip: process.platform === 'win32' }, async t => {
  const run = await fixture(t, 'ignore');
  const start = Date.now();
  // A 350 ms grace let SIGKILL land before a starved child ran its SIGTERM handler under load.
  await shutdownTerminalProcesses([run.terminal], { graceMs: GRACE_MS });
  assert.ok(Date.now() - start >= GRACE_MS);
  assert.deepEqual((await run.events()).map(event => event.event), ['ready', 'SIGTERM']);
  assert.deepEqual(await run.exit, { code: null, signal: 'SIGKILL' });
});

test('an idle shell closes promptly and shutdown waits for its exit', { skip: process.platform === 'win32' }, async t => {
  const child = spawn('/bin/sh', ['-i'], { detached: true, stdio: 'pipe' });
  child.stdout.resume();
  child.stderr.resume();
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.onTestFinished(async () => { child.kill('SIGKILL'); await exit; });
  await delay(100);
  const start = Date.now();
  await shutdownTerminalProcesses([{ process: { pid: child.pid, kill: signal => child.kill(signal) }, shellExecutable: '/bin/sh' }]);
  // The bound is generous for a loaded machine; the shell must still close well before any grace period.
  assert.ok(Date.now() - start < 5000);
  assert.equal((await exit).signal, 'SIGHUP');
});
