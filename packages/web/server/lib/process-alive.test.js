import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from './process-alive.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const spawnSleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });

describe('isProcessAlive', () => {
  it('reports a running process as alive and a killed one as dead', async () => {
    const child = spawnSleeper();
    try {
      expect(isProcessAlive(child.pid)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => { child.once('exit', resolve); });
    }
    expect(isProcessAlive(child.pid)).toBe(false);
  });

  it('reports a pid that names no process as dead', () => {
    // Above the kernel's maximum pid (2^22), so it cannot name a process.
    expect(isProcessAlive(1 << 24)).toBe(false);
  });

  it('reports a zombie as dead even though signal 0 still finds it', async () => {
    if (process.platform !== 'linux') return;
    // A middle process starts a leaf and is then stopped, so it cannot
    // collect the leaf: once the leaf is killed it stays a zombie — dead,
    // but still answering signal 0. This is the shape a killed grandchild
    // takes under an init that does not reap adopted orphans (#2495), and
    // it is deterministic here because the stopped middle never runs.
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-zombie-'));
    const leafPidFile = path.join(root, 'leaf-pid');
    const middle = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(leafPidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    try {
      await expect.poll(() => fs.existsSync(leafPidFile), { timeout: 5000 }).toBe(true);
      const leafPid = Number(fs.readFileSync(leafPidFile, 'utf8'));
      expect(isProcessAlive(leafPid)).toBe(true);
      process.kill(middle.pid, 'SIGSTOP');
      process.kill(leafPid, 'SIGKILL');
      // The leaf is now an uncollectable zombie: still in the process
      // table in state Z, so the signal-0 check the tests used before
      // reports it alive forever.
      await expect.poll(() => {
        try {
          const stat = fs.readFileSync(`/proc/${leafPid}/stat`, 'utf8');
          return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
        } catch { return 'gone'; }
      }, { timeout: 5000 }).toBe('Z');
      expect(() => process.kill(leafPid, 0)).not.toThrow();
      expect(isProcessAlive(leafPid)).toBe(false);
    } finally {
      try { process.kill(middle.pid, 'SIGKILL'); } catch { /* already exited */ }
      await sleep(50);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
