import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import { stopWindowsProcessTree } from './owned-process';

// Node stands in for `opencode serve --stdio`: one fixture exits when its stdin
// ends, the other ignores EOF the way a hung OpenCode would. The tree kill is
// recorded and done with SIGKILL, so the Windows order runs on any host.
const EXITS_ON_EOF = `process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); process.stdout.write('ready\\n');`;
const IGNORES_EOF = `process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('ready\\n');`;

const started: ChildProcess[] = [];

const startFixture = async (script: string) => {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  started.push(child);
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  return { child, closed };
};

const recordingKill = () => {
  const killed: number[] = [];
  return {
    killed,
    killTree: async (pid: number) => {
      killed.push(pid);
      process.kill(pid, 'SIGKILL');
    },
  };
};

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('a child that honors the stdin lease exits on its own and is not killed', async () => {
  const { child, closed } = await startFixture(EXITS_ON_EOF);
  const kill = recordingKill();

  await stopWindowsProcessTree(child, closed, { stdinLeaseGraceMs: 3000, killTree: kill.killTree });

  assert.equal(child.exitCode, 0);
  assert.deepEqual(kill.killed, []);
});

test('a child that ignores the lease is tree-killed once the grace runs out', async () => {
  const { child, closed } = await startFixture(IGNORES_EOF);
  const kill = recordingKill();
  const startedAt = Date.now();

  await stopWindowsProcessTree(child, closed, { stdinLeaseGraceMs: 300, killTree: kill.killTree });
  await closed;

  assert.ok(Date.now() - startedAt >= 300);
  assert.deepEqual(kill.killed, [child.pid]);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('without a lease the tree is killed at once', async () => {
  const { child, closed } = await startFixture(IGNORES_EOF);
  const kill = recordingKill();
  const startedAt = Date.now();

  await stopWindowsProcessTree(child, closed, { killTree: kill.killTree });
  await closed;

  assert.ok(Date.now() - startedAt < 2000);
  assert.deepEqual(kill.killed, [child.pid]);
});

test('a child that already exited is left alone', async () => {
  const { child, closed } = await startFixture(EXITS_ON_EOF);
  child.stdin?.end();
  await closed;
  const kill = recordingKill();

  await stopWindowsProcessTree(child, closed, { stdinLeaseGraceMs: 3000, killTree: kill.killTree });

  assert.deepEqual(kill.killed, []);
});
