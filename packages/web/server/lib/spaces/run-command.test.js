import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { killLiveTrees, killProcessTree, liveTreeCount, runCommand } from './run-command.js';

const node = process.execPath;

// Only ever a real pid of a process this test started: an integer greater than 1.
const isRealPid = (pid) => Number.isInteger(pid) && pid > 1;
const isAlive = (pid) => {
  if (!isRealPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (condition, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return condition();
};

// A child that starts a grandchild, writes both pids to a file, and waits forever.
//
// On Windows the grandchild is started with `detached`. Every Node process puts the children it
// starts into a job object of its own, which kills them when that Node process goes; here that Node
// process is the child, so a grandchild started the plain way dies with the child, and the control
// below would prove nothing there. git is not Node and uses no job object: measured on Windows,
// killing only git left its `docker exec` running. The detached grandchild stays out of the child's
// job, which is the shape git gives `docker exec`.
// It still has the child as its parent, which is what `taskkill /T` follows. On POSIX `detached`
// would move it into a process group of its own, out of reach of the group kill, so it is not used there.
const parentOfSleeper = (pidFile) => `
const { spawn } = require('node:child_process');
const windows = process.platform === 'win32';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: windows, windowsHide: true });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;

describe('runCommand', () => {
  it('resolves the exit code and both outputs, also for a non-zero exit', async () => {
    const result = await runCommand(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;']);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('writes stdin to the child and closes it', async () => {
    const result = await runCommand(node, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'hello' });
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' });
  });

  it('writes a Buffer to the child byte for byte', async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 128, 0]);
    const result = await runCommand(node, ['-e', 'const chunks = []; process.stdin.on("data", (chunk) => chunks.push(chunk)).on("end", () => process.stdout.write(Buffer.concat(chunks).toString("hex")))'], { stdin: bytes });
    expect(result.stdout).toBe(bytes.toString('hex'));
  });

  it('runs the child in the given working directory', async () => {
    const directory = fs.realpathSync(os.tmpdir());
    const result = await runCommand(node, ['-e', 'process.stdout.write(process.cwd())'], { cwd: directory });
    expect(result.stdout).toBe(directory);
  });

  it('closes stdin when there is no input, so a reader does not hang', async () => {
    const result = await runCommand(node, ['-e', 'process.stdin.on("data", () => {}).on("end", () => process.stdout.write("closed"))']);
    expect(result.stdout).toBe('closed');
  });

  it('passes arguments as they are, with no shell in between', async () => {
    const argument = '$(echo injected); echo "also" && `id`';
    const result = await runCommand(node, ['-e', 'process.stdout.write(process.argv[1])', argument]);
    expect(result.stdout).toBe(argument);
  });

  it('kills the child and rejects when it runs past the timeout', async () => {
    const started = Date.now();
    await expect(runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 })).rejects.toMatchObject({
      name: 'SpaceError',
      code: 'command_timeout',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills the child and rejects when it prints more than the cap', async () => {
    const flood = 'const chunk = "x".repeat(65536); setInterval(() => process.stdout.write(chunk), 1);';
    await expect(runCommand(node, ['-e', flood], { maxOutputBytes: 100_000, timeoutMs: 20_000 })).rejects.toMatchObject({
      code: 'command_output_too_large',
    });
  });

  it('rejects when the executable does not exist', async () => {
    await expect(runCommand('/nonexistent/openchamber-no-such-binary', ['version'])).rejects.toMatchObject({
      code: 'command_spawn_failed',
      details: { errno: 'ENOENT' },
    });
  });
});

describe('runCommand with killTree', () => {
  const leftovers = [];
  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      if (isRealPid(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  /** Runs the parent until its timeout and resolves the two pids and whether the child was still alive when the rejection came. */
  const runParent = async (options) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tree-'));
    const pidFile = path.join(directory, 'pids.json');
    try {
      const error = await runCommand(node, ['-e', parentOfSleeper(pidFile)], { timeoutMs: 3000, ...options }).catch((caught) => caught);
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      const childAliveAtRejection = isAlive(pids.child);
      leftovers.push(pids.grandchild, pids.child);
      expect(error).toMatchObject({ code: 'command_timeout' });
      return { ...pids, childAliveAtRejection };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };

  // The control: without the option a timeout kills the child alone, and the grandchild lives on.
  // This is what a git push over ext:: did with its docker exec, measured on three machines.
  it('leaves a grandchild running without the option', async () => {
    const { grandchild } = await runParent({});
    expect(isRealPid(grandchild)).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(isAlive(grandchild)).toBe(true);
  });

  it('kills the grandchild too when the whole tree is killed', async () => {
    const { grandchild } = await runParent({ killTree: true });
    expect(isRealPid(grandchild)).toBe(true);
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
  });

  // A caller removes its temporary folder right after the rejection. On Windows a child that still
  // held a file there made that removal fail with EBUSY and hid the real error.
  it('rejects only after the killed child is gone', async () => {
    const { child, childAliveAtRejection } = await runParent({ killTree: true });
    expect(isRealPid(child)).toBe(true);
    expect(childAliveAtRejection).toBe(false);
  });

  it('still resolves an ordinary run with the option', async () => {
    expect(await runCommand(node, ['-e', 'process.stdout.write("ok")'], { killTree: true })).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });
});

describe('killProcessTree', () => {
  const recorder = () => {
    const calls = [];
    return {
      calls,
      kill: (pid, signal) => { calls.push(['kill', pid, signal]); },
      spawnProcess: (file, args, options) => {
        calls.push(['spawn', file, args, options]);
        // A taskkill that finishes at once.
        return { once: (event, handler) => { if (event === 'exit') handler(0); } };
      },
    };
  };
  const fakeChild = (pid) => ({ pid, kill: () => { throw new Error('the child alone must not be signalled here'); } });

  // A fake process with pid 1 once became kill(-1) and closed every program on a developer's machine.
  it.each([null, undefined, 0, 1, -1, -4242, 1.5, Number.NaN, '4242'])('refuses to signal anything for pid %s', async (pid) => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const { calls, kill, spawnProcess } = recorder();
      expect(await killProcessTree(fakeChild(pid), { platform, kill, spawnProcess, systemRoot: 'C:\\Windows' })).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('signals the process group on POSIX', async () => {
    const { calls, kill, spawnProcess } = recorder();
    expect(await killProcessTree(fakeChild(4242), { platform: 'linux', kill, spawnProcess })).toBe(true);
    expect(calls).toEqual([['kill', -4242, 'SIGKILL']]);
  });

  it('runs taskkill by its absolute System32 path on Windows, hidden and without a shell, and waits for it', async () => {
    const { calls, kill, spawnProcess } = recorder();
    expect(await killProcessTree(fakeChild(4242), { platform: 'win32', kill, spawnProcess, systemRoot: 'C:\\Windows' })).toBe(true);
    expect(calls).toEqual([['spawn', 'C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4242'], { shell: false, windowsHide: true, stdio: 'ignore' }]]);
  });

  it('waits until taskkill has exited', async () => {
    const { kill } = recorder();
    let exitedAt = 0;
    const slow = () => ({
      once: (event, handler) => {
        if (event === 'exit') setTimeout(() => { exitedAt = Date.now(); handler(0); }, 200);
      },
    });
    await killProcessTree(fakeChild(4242), { platform: 'win32', kill, spawnProcess: slow, systemRoot: 'C:\\Windows' });
    expect(exitedAt).toBeGreaterThan(0);
  });

  it('stops waiting for a taskkill that never ends', async () => {
    const { kill } = recorder();
    const silent = () => ({ once: () => {} });
    const started = Date.now();
    expect(await killProcessTree(fakeChild(4242), { platform: 'win32', kill, spawnProcess: silent, systemRoot: 'C:\\Windows', waitMs: 50 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('runCommand with killTree when the process itself goes', () => {
  const leftovers = [];
  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      if (isRealPid(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  // A stand-in for the server: it starts a killTree child that never ends, then leaves. `exit` leaves
  // with process.exit; `sigint` leaves from its own SIGINT handler, the way the server's handlers end.
  const WRAPPER = (moduleUrl, parentScript) => `
import fs from 'node:fs';
import { runCommand } from ${JSON.stringify(moduleUrl)};
const [pidFile, mode] = process.argv.slice(2);
if (mode === 'sigint') process.on('SIGINT', () => process.exit(130));
// An exit listener registered before ours that throws, as the serve command registers one earlier.
if (mode === 'throwing') process.on('exit', () => { throw new Error('an earlier exit listener'); });
runCommand(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { killTree: true, timeoutMs: 120000 }).catch(() => {});
const ready = setInterval(() => {
  if (!fs.existsSync(pidFile)) return;
  clearInterval(ready);
  if (mode === 'exit' || mode === 'throwing') process.exit(0);
  fs.writeFileSync(pidFile + '.ready', '');
  setInterval(() => {}, 1000);
}, 50);
`;

  const runWrapper = async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tree-exit-'));
    try {
      const pidFile = path.join(directory, 'pids.json');
      const wrapperPath = path.join(directory, 'wrapper.mjs');
      fs.writeFileSync(wrapperPath, WRAPPER(new URL('./run-command.js', import.meta.url).href, parentOfSleeper(pidFile)));
      const wrapper = spawn(node, [wrapperPath, pidFile, mode], { stdio: 'ignore' });
      const exited = new Promise((resolve) => { wrapper.on('exit', resolve); });
      if (mode === 'sigint') {
        expect(await waitFor(() => fs.existsSync(`${pidFile}.ready`))).toBe(true);
        expect(isRealPid(wrapper.pid)).toBe(true);
        process.kill(wrapper.pid, 'SIGINT');
      }
      await exited;
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      leftovers.push(pids.grandchild, pids.child);
      return pids;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };

  // On Windows this is the test that shows the exit handler is needed there: the grandchild is
  // started outside the child's job, as git's `docker exec` is outside ours, so only the handler's
  // `taskkill /T` reaches it.
  it('kills the tree of a live child when the process leaves with process.exit', async () => {
    const { child, grandchild } = await runWrapper('exit');
    expect(isRealPid(child) && isRealPid(grandchild)).toBe(true);
    expect(await waitFor(() => !isAlive(child) && !isAlive(grandchild), 5000)).toBe(true);
  });

  it('still kills the tree when an exit listener registered before ours throws', async () => {
    const { child, grandchild } = await runWrapper('throwing');
    expect(isRealPid(child) && isRealPid(grandchild)).toBe(true);
    expect(await waitFor(() => !isAlive(child) && !isAlive(grandchild), 5000)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('kills the tree of a live child when the process leaves from its own SIGINT handler', async () => {
    const { child, grandchild } = await runWrapper('sigint');
    expect(isRealPid(child) && isRealPid(grandchild)).toBe(true);
    expect(await waitFor(() => !isAlive(child) && !isAlive(grandchild), 5000)).toBe(true);
  });
});

// A grandchild that left the process group (setsid) survives the group kill, and it holds the
// child's stdout, so the child's pipes never close. Only the bound on that wait ends it.
describe.skipIf(process.platform === 'win32')('runCommand with killTree and a grandchild that escaped', () => {
  it('stops waiting for the close at its bound', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tree-escape-'));
    const pidFile = path.join(directory, 'escaped.pid');
    const script = `
const { spawn } = require('node:child_process');
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(escaped.pid));
setInterval(() => {}, 1000);
`;
    const started = Date.now();
    try {
      await expect(runCommand(node, ['-e', script], { timeoutMs: 1000, killTree: true, killWaitMs: 300 })).rejects.toMatchObject({ code: 'command_timeout' });
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (isRealPid(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('the exit handler and its set of live trees', () => {
  it('registers one exit listener, however many killTree children run', async () => {
    await runCommand(node, ['-e', ''], { killTree: true });
    const listeners = process.listenerCount('exit');
    for (let run = 0; run < 3; run += 1) {
      await runCommand(node, ['-e', ''], { killTree: true });
    }
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it.each([null, undefined, 0, 1, -1, 1.5, Number.NaN, '4242'])('signals nothing at exit for a child with pid %s', (pid) => {
    for (const platform of ['linux', 'win32']) {
      const calls = [];
      killLiveTrees({
        children: [{ pid }],
        platform,
        kill: (...args) => { calls.push(['kill', ...args]); },
        spawnSyncProcess: (...args) => { calls.push(['spawnSync', ...args]); },
        systemRoot: 'C:\\Windows',
      });
      expect(calls).toEqual([]);
    }
  });

  it('kills the group on POSIX and runs taskkill on Windows, synchronously, and never throws', () => {
    const calls = [];
    killLiveTrees({ children: [{ pid: 4242 }], platform: 'linux', kill: (...args) => { calls.push(['kill', ...args]); throw new Error('ESRCH'); } });
    killLiveTrees({ children: [{ pid: 4242 }], platform: 'win32', spawnSyncProcess: (file, args, options) => { calls.push(['spawnSync', file, args, options.windowsHide]); throw new Error('gone'); }, systemRoot: 'C:\\Windows' });
    expect(calls).toEqual([
      ['kill', -4242, 'SIGKILL'],
      ['spawnSync', 'C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4242'], true],
    ]);
  });

  it('empties the live set once it has killed', async () => {
    const running = runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { killTree: true, timeoutMs: 3000 }).catch((error) => error);
    try {
      expect(await waitFor(() => liveTreeCount() === 1)).toBe(true);
      const killed = [];
      // The POSIX path with an injected kill on every platform, so nothing real ends the child here: on
      // Windows the real path would run taskkill, and the child would end with code 1 before its timeout.
      killLiveTrees({ platform: 'linux', kill: (pid) => { killed.push(pid); } });
      expect(liveTreeCount()).toBe(0);
      expect(killed).toHaveLength(1);
      expect(killed[0]).toBeLessThan(-1);
    } finally {
      // The real kill comes from the timeout, and the test waits for it even when an assertion failed.
      expect(await running).toMatchObject({ code: 'command_timeout' });
    }
  });

  it('keeps nothing in the set after a spawn failure, a timeout or a normal run', async () => {
    await expect(runCommand('/nonexistent/openchamber-no-such-binary', [], { killTree: true })).rejects.toMatchObject({ code: 'command_spawn_failed' });
    expect(liveTreeCount()).toBe(0);
    await expect(runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { killTree: true, timeoutMs: 500 })).rejects.toMatchObject({ code: 'command_timeout' });
    expect(liveTreeCount()).toBe(0);
    await runCommand(node, ['-e', ''], { killTree: true });
    expect(liveTreeCount()).toBe(0);
  });

  // A child that exited while an escaped grandchild holds its pipes: its pid must not be kept, or the
  // exit handler would kill whatever has that pid by then.
  it.skipIf(process.platform === 'win32')('drops a child from the set when it exits, even while its pipes stay open', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tree-exited-'));
    const pidFile = path.join(directory, 'pids.json');
    const script = `
const { spawn } = require('node:child_process');
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, escaped: escaped.pid }));
setTimeout(() => process.exit(0), 200);
`;
    const running = runCommand(node, ['-e', script], { killTree: true, timeoutMs: 3000, killWaitMs: 200 }).catch((error) => error);
    try {
      expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
      const { child } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      expect(await waitFor(() => !isAlive(child))).toBe(true);
      expect(await waitFor(() => liveTreeCount() === 0, 2000)).toBe(true);
      expect(await running).toMatchObject({ code: 'command_timeout' });
    } finally {
      const { escaped } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (isRealPid(escaped) && isAlive(escaped)) process.kill(escaped, 'SIGKILL');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

