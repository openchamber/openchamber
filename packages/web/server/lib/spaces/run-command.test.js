import { spawn, spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
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

  // A failing `git apply --check` prints a line or two per path; its exit code is the answer.
  it('keeps only the last bytes of each stream past the cap with keepTail, and still answers with the exit code', async () => {
    const flood = 'for (let i = 0; i < 4000; i += 1) process.stderr.write(`line ${i}\\n`.padStart(100, "x")); process.stdout.write("out"); process.exitCode = 3;';
    const done = await runCommand(node, ['-e', flood], { maxOutputBytes: 10_000, keepTail: true, timeoutMs: 20_000 });
    expect(done.code).toBe(3);
    expect(done.stdout).toBe('out');
    expect(Buffer.byteLength(done.stderr)).toBe(10_000);
    expect(done.stderr.endsWith(`${'line 3999\n'.padStart(100, 'x')}`)).toBe(true);
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
runCommand(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { killTree: true, keepAtExit: mode === 'keep', timeoutMs: 120000 }).catch(() => {});
const ready = setInterval(() => {
  if (!fs.existsSync(pidFile)) return;
  clearInterval(ready);
  if (mode === 'exit' || mode === 'throwing' || mode === 'keep') process.exit(0);
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

  // `keepAtExit`, for `git apply`: killed in the middle it leaves a part written, so an exit leaves it.
  // Windows has no such test: there libuv's job object ends the child with this process whatever we do.
  it.skipIf(process.platform === 'win32')('leaves the tree of a keepAtExit child alive when the process leaves with process.exit', async () => {
    const { child, grandchild } = await runWrapper('keep');
    expect(isRealPid(child) && isRealPid(grandchild)).toBe(true);
    expect(await waitFor(() => !isAlive(child) || !isAlive(grandchild), 1500)).toBe(false);
  });

  // The reviewer's probe: a `git apply` kept at exit whose smudge filter prints on stderr after the host
  // left. Through a pipe to the dead host the print was SIGPIPE, and the apply stopped with files
  // deleted; with the output in a file of its own it finishes, every file changed.
  it.skipIf(process.platform === 'win32')('lets a keepAtExit git apply finish after the process left, while its filter prints', { timeout: 40_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-kept-apply-'));
    try {
      const repo = path.join(directory, 'repo');
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
      const git = (args) => {
        const done = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
        if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
        return done.stdout;
      };
      fs.mkdirSync(repo);
      git(['init', '--quiet']);
      const names = Array.from({ length: 20 }, (_, index) => `f${String(index).padStart(2, '0')}.txt`);
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'as it was\n');
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'files']);
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'changed\n');
      const patch = path.join(directory, 'change.patch');
      fs.writeFileSync(patch, git(['diff', '--binary']));
      git(['checkout', '--quiet', '--', '.']);
      const noisy = path.join(directory, 'noisy-smudge.sh');
      fs.writeFileSync(noisy, '#!/bin/sh\nsleep 0.2\necho "a smudge filter that talks" >&2\ncat\n', { mode: 0o755 });
      git(['config', 'filter.noisy.smudge', noisy]);
      git(['config', 'filter.noisy.clean', 'cat']);
      fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=noisy\n');
      const wrapper = path.join(directory, 'host.mjs');
      fs.writeFileSync(wrapper, `
import { runCommand } from ${JSON.stringify(new URL('./run-command.js', import.meta.url).href)};
runCommand('git', ['-C', ${JSON.stringify(repo)}, 'apply', '--binary', ${JSON.stringify(patch)}], { env: ${JSON.stringify(env)}, killTree: true, keepAtExit: true, keepTail: true, maxOutputBytes: 65536, timeoutMs: 60000 }).catch(() => {});
setTimeout(() => process.exit(0), 1000);
`);
      const host = spawn(node, [wrapper], { stdio: 'ignore' });
      await new Promise((resolve) => { host.on('exit', resolve); });
      const holds = (name) => fs.existsSync(path.join(repo, name)) && fs.readFileSync(path.join(repo, name), 'utf8') === 'changed\n';
      // Four seconds of smudging in all, most of it after the host left.
      expect(await waitFor(() => names.every(holds), 20_000)).toBe(true);
      expect(git(['status', '--porcelain']).split('\n').filter(Boolean)).toEqual(names.map((name) => ` M ${name}`));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the stderr of a keepAtExit child back, its last maxOutputBytes with keepTail, and refuses more without it', async () => {
    const script = 'process.stderr.write("x".repeat(5000) + "end"); process.stdout.write("gone"); process.exitCode = 2;';
    expect(await runCommand(node, ['-e', script], { killTree: true, keepAtExit: true, keepTail: true, maxOutputBytes: 10 })).toEqual({ code: 2, stdout: '', stderr: 'xxxxxxxend' });
    await expect(runCommand(node, ['-e', script], { killTree: true, keepAtExit: true, maxOutputBytes: 10 })).rejects.toMatchObject({ code: 'command_output_too_large' });
    expect(await runCommand(node, ['-e', script], { killTree: true, keepAtExit: true })).toMatchObject({ code: 2, stderr: `${'x'.repeat(5000)}end` });
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('openchamber-stderr-'))).toEqual([]);
  });

  it('keeps a keepAtExit child out of the live set, and still kills its tree at the timeout', async () => {
    const running = runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { killTree: true, keepAtExit: true, timeoutMs: 1500 }).catch((error) => error);
    try {
      expect(liveTreeCount()).toBe(0);
    } finally {
      // Out of the set, only its timeout ends it: waited for even when the assertion failed.
      expect(await running).toMatchObject({ code: 'command_timeout' });
    }
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


// The caller stops a running child from outside, as code out does when the quarantine passes its
// size cap. The rejection is the caller's own reason, whatever the child's exit looked like.
describe('runCommand with an abort signal', () => {
  const leftovers = [];
  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      if (isRealPid(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  const abortListeners = (signal) => getEventListeners(signal, 'abort').length;
  const stopReason = () => new SpaceError('stopped_by_caller', 'the caller stopped it');

  it('starts nothing when the signal is already aborted, and rejects with its reason', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-abort-before-'));
    const marker = path.join(directory, 'started');
    try {
      const reason = stopReason();
      const error = await runCommand(node, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], { killTree: true, signal: AbortSignal.abort(reason) }).catch((caught) => caught);
      expect(error).toBe(reason);
      // The control: the same command without the signal does start and leave its marker.
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(fs.existsSync(marker)).toBe(false);
      expect(liveTreeCount()).toBe(0);
      await runCommand(node, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]);
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // On Windows this runs the real `taskkill /T`, whose child exits with code 1 and no signal.
  it('kills the whole tree while it runs, rejects with the reason once the child is gone, and forgets the tree', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-abort-during-'));
    const pidFile = path.join(directory, 'pids.json');
    try {
      const controller = new AbortController();
      const reason = stopReason();
      const started = Date.now();
      const running = runCommand(node, ['-e', parentOfSleeper(pidFile)], { killTree: true, timeoutMs: 60_000, signal: controller.signal }).catch((caught) => caught);
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0)).toBe(true);
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      leftovers.push(pids.grandchild, pids.child);
      expect(isAlive(pids.child) && isAlive(pids.grandchild)).toBe(true);
      expect(abortListeners(controller.signal)).toBe(1);
      controller.abort(reason);
      expect(await running).toBe(reason);
      expect(isAlive(pids.child)).toBe(false);
      expect(await waitFor(() => !isAlive(pids.grandchild))).toBe(true);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(liveTreeCount()).toBe(0);
      expect(abortListeners(controller.signal)).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('kills the child alone without killTree, and rejects with the reason', async () => {
    const controller = new AbortController();
    const reason = stopReason();
    const running = runCommand(node, ['-e', 'process.stdout.write("up"); setInterval(() => {}, 1000)'], { timeoutMs: 60_000, signal: controller.signal }).catch((caught) => caught);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    controller.abort(reason);
    expect(await running).toBe(reason);
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it('changes nothing about a run that already closed, and leaves no listener behind', async () => {
    const controller = new AbortController();
    expect(await runCommand(node, ['-e', 'process.stdout.write("ok")'], { killTree: true, signal: controller.signal })).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    expect(abortListeners(controller.signal)).toBe(0);
    controller.abort(stopReason());
    expect(liveTreeCount()).toBe(0);
  });

  // The timeout came first: its kill is the only one, and a late abort neither kills again nor
  // replaces the error.
  it('keeps the timeout as the error when the abort comes after it', async () => {
    const controller = new AbortController();
    const running = runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { killTree: true, timeoutMs: 500, signal: controller.signal }).catch((caught) => caught);
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    expect(abortListeners(controller.signal)).toBe(0);
    controller.abort(stopReason());
    expect(await running).toMatchObject({ code: 'command_timeout' });
    expect(liveTreeCount()).toBe(0);
  });

  // Whatever the caller aborts with, the rejection is a SpaceError: a string, null or nothing at all
  // would otherwise reach a caller that catches SpaceErrors.
  it.each([['a string', 'stopped'], ['null', null], ['nothing', undefined]])('rejects with a SpaceError when the reason is %s', async (_, reason) => {
    const controller = new AbortController();
    const running = runCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { killTree: true, timeoutMs: 60_000, signal: controller.signal }).catch((caught) => caught);
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    if (reason === undefined) controller.abort(); else controller.abort(reason);
    const error = await running;
    expect(error).toBeInstanceOf(SpaceError);
    expect(error).toMatchObject({ code: 'command_aborted' });
    expect(await runCommand(node, ['-e', ''], { signal: AbortSignal.abort(reason) }).catch((caught) => caught)).toMatchObject({ code: 'command_aborted' });
  });

  it('leaves no listener after a spawn failure', async () => {
    const controller = new AbortController();
    await expect(runCommand('/nonexistent/openchamber-no-such-binary', [], { killTree: true, signal: controller.signal })).rejects.toMatchObject({ code: 'command_spawn_failed' });
    expect(abortListeners(controller.signal)).toBe(0);
    expect(liveTreeCount()).toBe(0);
  });
});
