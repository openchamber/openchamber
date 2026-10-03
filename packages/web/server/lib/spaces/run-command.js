import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';

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

/** What an abort rejects with: the caller's own SpaceError, or one of ours for any other reason. */
const abortReason = (signal, file, args) => (signal.reason instanceof SpaceError
  ? signal.reason
  : new SpaceError('command_aborted', `${file} ${args[0] ?? ''} was stopped by its caller`));

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
 * this process kills its tree too, see `liveTrees`, unless `options.keepAtExit` is true: then only a
 * timeout or an abort kills it, and it outlives an exit of this process, as a child without `killTree`
 * does on POSIX. It is for `git apply`, which, killed in the middle of writing, leaves the user's project
 * half changed, while left to run it finishes. Such a child also has no pipe back to this process on
 * its output, because a pipe dies with this process, and a filter of git's that then printed got
 * SIGPIPE and stopped the apply in the middle all the same, measured by a reviewer. Its stdout goes
 * nowhere and resolves as empty; its stderr goes into a file this process made and removed at once,
 * which it and the child each hold open, so no clean-up of anybody's can break the child's writes. At
 * `close` the last `maxOutputBytes` of it are read: the same window as `keepTail`, and without
 * `keepTail` a longer stderr is `command_output_too_large` then, after the child has ended.
 *
 * `options.signal` is an `AbortSignal` that lets the caller stop the child from outside: the child is
 * killed as a timeout kills it, and the rejection is the signal's reason when that reason is a
 * SpaceError, and `command_aborted` otherwise, so every rejection of this function is a SpaceError.
 * The caller then knows that it stopped the child, which the exit code cannot tell: on Windows a tree
 * ended by `taskkill` exits with code 1, not a signal. A signal that is already aborted starts nothing.
 *
 * `options.keepTail: true` turns the output cap into a window: past `maxOutputBytes`, each stream keeps
 * its last `maxOutputBytes` bytes and the child runs on. It is for a child whose exit code is the answer
 * and whose output is only shown: a `git apply --check` that fails prints a line or two for every path
 * that does not fit, and measured by a reviewer, tens of thousands of such paths passed four megabytes,
 * where the cap stopped the check and its answer was lost.
 *
 * Rejects with a SpaceError when the process cannot start (`command_spawn_failed`),
 * runs past `timeoutMs` (`command_timeout`), prints more than `maxOutputBytes`
 * (`command_output_too_large`), or dies from a signal (`command_killed`). The child
 * is killed in the first three cases.
 */
export function runCommand(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const keepTail = options.keepTail === true;
  const stdin = options.stdin ?? '';
  const killTree = options.killTree === true;
  const keepAtExit = options.keepAtExit === true;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  const abortSignal = options.signal;

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortReason(abortSignal, file, args));
      return;
    }
    // Where a keepAtExit child's stderr goes: a file already removed from its folder, open here and in the child.
    let errorFile = null;
    const closeErrorFile = () => {
      if (errorFile === null) return;
      try { fs.closeSync(errorFile.fd); } catch { /* already closed */ }
      fs.rmSync(errorFile.folder, { recursive: true, force: true });
      errorFile = null;
    };
    if (keepAtExit) {
      try {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-stderr-'));
        errorFile = { folder, fd: fs.openSync(path.join(folder, 'stderr'), 'w+') };
      } catch (error) {
        reject(new SpaceError('command_spawn_failed', `Could not start ${file}: no file for its output: ${error.message}`, { errno: error.code ?? null }));
        return;
      }
    }
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
        stdio: errorFile === null ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', errorFile.fd],
      });
    } catch (error) {
      closeErrorFile();
      reject(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
      return;
    }

    if (killTree && !keepAtExit) trackTree(child);
    // The child holds its own copy now; with the name gone, nothing that cleans folders can take it away.
    // Where the system refuses to remove an open file, the folder goes at `close`.
    if (errorFile !== null) fs.rmSync(errorFile.folder, { recursive: true, force: true });

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    const heldBytes = new Map([[stdoutChunks, 0], [stderrChunks, 0]]);
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
      abortSignal?.removeEventListener('abort', stop);
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
    const stop = () => fail(abortReason(abortSignal, file, args));
    abortSignal?.addEventListener('abort', stop, { once: true });

    // Only the last `maxOutputBytes` of the stream stay, and nothing fails.
    const window = (chunks) => (chunk) => {
      chunks.push(chunk);
      let held = heldBytes.get(chunks) + chunk.length;
      while (held - chunks[0].length >= maxOutputBytes) held -= chunks.shift().length;
      if (held > maxOutputBytes) {
        chunks[0] = chunks[0].subarray(held - maxOutputBytes);
        held = maxOutputBytes;
      }
      heldBytes.set(chunks, held);
    };
    const capture = (chunks) => (keepTail ? window(chunks) : (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes) {
        fail(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes and was stopped`));
        return;
      }
      chunks.push(chunk);
    });

    child.stdout?.on('data', capture(stdoutChunks));
    child.stderr?.on('data', capture(stderrChunks));
    /** The last `maxOutputBytes` of the stderr file, and its whole length. */
    const readErrorFile = () => {
      const size = fs.fstatSync(errorFile.fd).size;
      const kept = Buffer.alloc(Math.min(size, maxOutputBytes));
      fs.readSync(errorFile.fd, kept, 0, kept.length, size - kept.length);
      return { size, kept };
    };

    child.on('error', (error) => {
      liveTrees.delete(child);
      closeErrorFile();
      fail(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
    });

    child.on('exit', () => {
      liveTrees.delete(child);
    });

    child.on('close', (code, signal) => {
      closed = true;
      for (const wake of closeWaiters.splice(0)) wake();
      if (settled) {
        closeErrorFile();
        return;
      }
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', stop);
      if (code === null) {
        closeErrorFile();
        reject(new SpaceError('command_killed', `${file} ${args[0] ?? ''} was stopped by signal ${signal}`));
        return;
      }
      if (errorFile !== null) {
        let read;
        try {
          read = readErrorFile();
        } catch (error) {
          reject(new SpaceError('command_output_unreadable', `The output of ${file} ${args[0] ?? ''} could not be read back: ${error.message}`, { exitCode: code }));
          return;
        } finally {
          closeErrorFile();
        }
        if (!keepTail && read.size > maxOutputBytes) {
          reject(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes`));
          return;
        }
        stderrChunks.push(read.kept);
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

// How much of a streamed command's stderr is kept for its error message.
const STREAM_STDERR_BYTES = 4 * 1024;

/**
 * A command's stdin and stdout as one duplex stream that an `http.Agent` can use as a socket.
 * Written for `docker exec --interactive` with the bridge inside a space, which joins the two
 * pipes to the loopback port of the server there: the dispatcher's requests travel through
 * this and never through a network of the space. Everything an `http` client calls on a
 * `net.Socket` is here: `setNoDelay`, `setKeepAlive`, `setTimeout`, `ref` and `unref`, and
 * `destroy`, which kills the command. Backpressure runs both ways through the pipes.
 *
 * The stream ends when the command's stdout ends. A command that exits with a code other than
 * zero, or before it wrote anything, destroys the stream with `command_stream_failed` and the
 * tail of its stderr, so a bridge that could not reach the server inside says so.
 */
class CommandStream extends Duplex {
  #child;
  #file;
  #args;
  #stderr = [];
  #stderrBytes = 0;
  #receivedBytes = 0;
  #closed = false;
  #timer = null;

  constructor(child, file, args) {
    super({ allowHalfOpen: false });
    this.#child = child;
    this.#file = file;
    this.#args = args;
    this.timeout = 0;
    // A failure that arrives before a consumer listens must not end the process. Whoever holds
    // the stream still gets the error; this listener only keeps it from being uncaught.
    this.on('error', () => {});

    child.stdout.on('data', (chunk) => {
      this.#receivedBytes += chunk.length;
      this.#touch();
      if (!this.push(chunk)) child.stdout.pause();
    });
    // The readable side ends at the command's `close`, not at stdout's `end`, so that a command
    // which failed can still end the stream with its reason rather than with a bare end.
    child.stderr.on('data', (chunk) => {
      if (this.#stderrBytes >= STREAM_STDERR_BYTES) return;
      this.#stderr.push(chunk.subarray(0, STREAM_STDERR_BYTES - this.#stderrBytes));
      this.#stderrBytes += chunk.length;
    });
    child.stdin.on('error', (error) => {
      // After the command has ended, its input closing is not news.
      if (!this.#closed) this.destroy(this.#failure(`its input closed: ${error.code ?? error.message}`));
    });
    child.on('error', (error) => {
      this.#closed = true;
      this.destroy(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
    });
    child.on('close', (code, signal) => {
      this.#closed = true;
      if (this.destroyed) return;
      // A clean end: the readable side ends, the writable side follows (`allowHalfOpen: false`),
      // and nothing is destroyed here, so what is still buffered is read.
      if (code === 0 && this.#receivedBytes > 0) {
        this.push(null);
        return;
      }
      const why = code === null ? `stopped by signal ${signal}` : `exited with code ${code}`;
      this.destroy(this.#failure(`${why}${this.#stderrText() ? `: ${this.#stderrText()}` : ''}`));
    });
  }

  #stderrText() {
    return Buffer.concat(this.#stderr).toString('utf8').trim();
  }

  #failure(what) {
    return new SpaceError('command_stream_failed', `${this.#file} ${this.#args[0] ?? ''} ${what}`);
  }

  #touch() {
    if (this.timeout > 0) this.setTimeout(this.timeout);
  }

  _read() {
    this.#child.stdout.resume();
  }

  _write(chunk, _encoding, callback) {
    this.#touch();
    if (this.#closed) {
      callback(this.#failure('has ended'));
      return;
    }
    this.#child.stdin.write(chunk, callback);
  }

  _final(callback) {
    if (this.#closed) {
      callback();
      return;
    }
    this.#child.stdin.end(callback);
  }

  _destroy(error, callback) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#child.stdout.removeAllListeners('data');
    try {
      this.#child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    callback(error);
  }

  /** Emits `timeout` after `milliseconds` without a byte in either direction. Zero cancels it. */
  setTimeout(milliseconds, callback) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.timeout = milliseconds;
    if (callback) this.once('timeout', callback);
    if (milliseconds > 0) {
      this.#timer = setTimeout(() => { this.#timer = null; this.emit('timeout'); }, milliseconds);
      this.#timer.unref?.();
    }
    return this;
  }

  setNoDelay() { return this; }

  setKeepAlive() { return this; }

  ref() { return this; }

  unref() { return this; }
}

/**
 * Starts one executable with an argument array and hands back its stdin and stdout as a
 * `CommandStream`. The executable is spawned directly, never through a shell, hidden on
 * Windows. It is the transport of the place contract's `connect`. A command that cannot be
 * started throws `command_spawn_failed` at once.
 */
export function openCommandStream(file, args) {
  let child;
  try {
    child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null });
  }
  return new CommandStream(child, file, args);
}
