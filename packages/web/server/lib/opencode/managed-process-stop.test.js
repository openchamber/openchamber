import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { stopOpenCodeByClosingStdin } from './managed-process-stop.js';

// Node stands in for `opencode serve --stdio`: one fixture exits when its stdin
// ends, the other ignores EOF the way a hung OpenCode would.
const EXITS_ON_EOF = `process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); process.stdout.write('ready\\n');`;
const IGNORES_EOF = `process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('ready\\n');`;

const started = [];

const startFixture = async (script) => {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  started.push(child);
  await once(child.stdout, 'data');
  return child;
};

const recordingKill = () => {
  const killed = [];
  return {
    killed,
    forceKillTree: (pid) => {
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

describe('stopOpenCodeByClosingStdin', () => {
  it('lets OpenCode exit on its own when it honors the stdin lease', async () => {
    const child = await startFixture(EXITS_ON_EOF);
    const kill = recordingKill();

    await expect(stopOpenCodeByClosingStdin(child, { forceKillTree: kill.forceKillTree, graceMs: 3000 })).resolves.toBe('exited');

    expect(child.exitCode).toBe(0);
    expect(kill.killed).toEqual([]);
  });

  it('force-kills the tree once the grace period runs out', async () => {
    const child = await startFixture(IGNORES_EOF);
    const kill = recordingKill();
    const startedAt = Date.now();

    await expect(stopOpenCodeByClosingStdin(child, { forceKillTree: kill.forceKillTree, graceMs: 300 })).resolves.toBe('killed');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(kill.killed).toEqual([child.pid]);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('does nothing for a process that already exited', async () => {
    const child = await startFixture(EXITS_ON_EOF);
    child.stdin.end();
    await once(child, 'close');
    const kill = recordingKill();

    await expect(stopOpenCodeByClosingStdin(child, { forceKillTree: kill.forceKillTree })).resolves.toBe('exited');

    expect(kill.killed).toEqual([]);
  });

  it('force-kills at once when there is no stdin lease to close', async () => {
    const child = await startFixture(IGNORES_EOF);
    child.stdin.destroy();
    const kill = recordingKill();
    const startedAt = Date.now();

    await expect(stopOpenCodeByClosingStdin(child, { forceKillTree: kill.forceKillTree, graceMs: 5000 })).resolves.toBe('killed');

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(kill.killed).toEqual([child.pid]);
  });
});
