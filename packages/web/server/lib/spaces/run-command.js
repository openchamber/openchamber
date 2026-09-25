import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { SpaceError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// How long a tree kill waits for `taskkill` and for the child to close before it gives up waiting.
const KILL_WAIT_MS = 5_000;

// Children started with `killTree` whose own process has not exited yet. A `killTree` child leads a
// process group of its own on POSIX, so a Ctrl-C that reaches the server's group does not reach it,
// and measured, it outlived the server. When this process exits, each of these trees is killed
// synchronously. No signal handler is installed here: the server has its own, which end in
// `process.exit`, and those decide how it shuts down.
//
// Windows needs this too. libuv puts each child it starts into a job object that kills its members
// when this Node process goes, whatever way it goes, but the job is created with silent breakaway:
// only the processes libuv adds are members, "and *their* subprocesses are not", as libuv's
// src/win/process.c says. git is a member and dies with us; the `docker exec` git starts is not.
//
// An entry leaves the set when the child itself exits, not when its pipes close: an escaped
// grandchild can hold the pipes for ever, and a pid that exited long ago may belong to somebody else.
const liveTrees = new Set();
let exitHandlerInstalled = false;

/** How many `killTree` children are live, for the tests. */
export const liveTreeCount = () => liveTrees.size;

/**
 * Kills each tree synchronously, refusing any pid that is not an integer greater than 1, and never
 * throws: it runs from `process.on('exit')`, where nothing asynchronous finishes. `children` defaults
 * to the live set, which is emptied; the rest is injectable for the tests.
 */
export function killLiveTrees({
  children = liveTrees,
  platform = process.platform,
  kill = (pid, signal) => process.kill(pid, signal),
  spawnSyncProcess = spawnSync,
  systemRoot = process.env.SystemRoot,
} = {}) {
  for (const child of children) {
    const pid = child?.pid;
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      if (platform === 'win32') {
        if (systemRoot) {
          spawnSyncProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
            shell: false, windowsHide: true, stdio: 'ignore', timeout: KILL_WAIT_MS,
          });
        }
      } else {
        kill(-pid, 'SIGKILL');
      }
    } catch {
      // Already gone, or nothing more can be done from an exit handler.
    }
  }
  if (children === liveTrees) liveTrees.clear();
}

const killLiveTreesAtExit = () => killLiveTrees();

const trackTree = (child) => {
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    // First in line: a listener registered earlier that throws would otherwise stop ours.
    process.prependListener('exit', killLiveTreesAtExit);
  }
  liveTrees.add(child);
};

/**
 * Runs one executable with an argument array and resolves `{ code, stdout, stderr }`
 * for any exit code. The executable is spawned directly, never through a shell.
 *
 * `options.stdin` is a string or a Buffer. A Buffer goes to the child byte for byte, which is
 * how the tarballs of a development build reach the tools filler. `options.cwd` is the
 * working directory of the child, and `options.env` its whole environment when given.
 *
 * `options.killTree: true` makes a kill end the child's whole process tree instead of the child
 * alone. It is for a child that starts children of its own that hold a connection open: a
 * `git push` over `ext::` runs `docker exec`, and measured on three machines, killing only the
 * `git` process left that `docker exec` running on the host. See `killProcessTree`. The rejection
 * then waits until the kill has done its work and the child has closed, at most five seconds, so a
 * caller that cleans up afterwards does not race processes that still hold its files. Measured on
 * Windows: without the wait, removing the temporary folder failed with EBUSY and hid the timeout.
 * `options.killWaitMs` changes that bound, for the tests. While a `killTree` child runs, an exit of
 * this process kills its tree too, see `liveTrees`.
 *
 * Rejects with a SpaceError when the process cannot start (`command_spawn_failed`),
 * runs past `timeoutMs` (`command_timeout`), prints more than `maxOutputBytes`
 * (`command_output_too_large`), or dies from a signal (`command_killed`). The child
 * is killed in the first three cases.
 */
export function runCommand(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdin = options.stdin ?? '';
  const killTree = options.killTree === true;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
        // On POSIX the child leads a process group of its own, so the kill can reach its children.
        // Never on Windows: there `detached` gives the child a console of its own.
        detached: killTree && process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
      return;
    }

    if (killTree) trackTree(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let closed = false;
    const closeWaiters = [];
    const waitForClose = () => new Promise((resolveWait) => {
      if (closed) {
        resolveWait();
        return;
      }
      const bound = setTimeout(resolveWait, killWaitMs);
      closeWaiters.push(() => { clearTimeout(bound); resolveWait(); });
    });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!killTree) {
        child.kill('SIGKILL');
        reject(error);
        return;
      }
      killProcessTree(child, { waitMs: killWaitMs }).then(waitForClose).then(() => reject(error));
    };

    const timer = setTimeout(() => {
      fail(new SpaceError('command_timeout', `${file} ${args[0] ?? ''} did not finish within ${timeoutMs} ms and was stopped`));
    }, timeoutMs);

    const capture = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes) {
        fail(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes and was stopped`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', capture(stdoutChunks));
    child.stderr.on('data', capture(stderrChunks));

    child.on('error', (error) => {
      liveTrees.delete(child);
      fail(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
    });

    child.on('exit', () => {
      liveTrees.delete(child);
    });

    child.on('close', (code, signal) => {
      closed = true;
      for (const wake of closeWaiters.splice(0)) wake();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === null) {
        reject(new SpaceError('command_killed', `${file} ${args[0] ?? ''} was stopped by signal ${signal}`));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    // A child that exits without reading its input closes the pipe first.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Kills a child and every process it started. Resolves true once the kill is under way and done
 * as far as we can tell, false when it refused, and never rejects.
 *
 * POSIX: the child was spawned with `detached: true`, so it leads a process group, and the
 * signal goes to that group. Windows: `taskkill.exe /T /F`, named by its absolute path under
 * `SystemRoot` and spawned directly, hidden, with no shell.
 *
 * A pid that is not an integer greater than 1 is refused and nothing is signalled. A fake process
 * with pid 1 once became `kill(-1)` and closed every program on a developer's machine, and a pid
 * of 0 would signal our own process group. Tests hand in fakes with `pid: null`.
 *
 * On Windows it resolves when `taskkill` exits, or after `waitMs` if it does not.
 *
 * `platform`, `kill`, `spawnProcess`, `systemRoot` and `waitMs` are injectable for the tests.
 */
export async function killProcessTree(child, {
  platform = process.platform,
  kill = (pid, signal) => process.kill(pid, signal),
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot,
  waitMs = KILL_WAIT_MS,
} = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const killChildOnly = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };
  if (platform === 'win32') {
    if (!systemRoot) {
      killChildOnly();
      return true;
    }
    await new Promise((resolveKill) => {
      const bound = setTimeout(resolveKill, waitMs);
      const done = () => { clearTimeout(bound); resolveKill(); };
      try {
        const killer = spawnProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', () => { killChildOnly(); done(); });
        killer.once('exit', done);
      } catch {
        killChildOnly();
        done();
      }
    });
    return true;
  }
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    killChildOnly();
  }
  return true;
}
