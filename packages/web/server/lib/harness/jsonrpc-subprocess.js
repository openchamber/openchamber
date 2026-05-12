import { spawn } from 'child_process';
import readline from 'readline';

/**
 * Creates a reusable JSON-RPC 2.0 subprocess manager.
 *
 * Spawns a child process and communicates via line-delimited JSON-RPC on
 * stdin/stdout.  Handles three message flows:
 *
 *  1. Outbound requests   – sendRequest(method, params) → Promise<result>
 *  2. Inbound requests    – subprocess asks us something, we respond via sendResponse
 *  3. Notifications       – fire-and-forget in both directions
 */
export function createJsonRpcSubprocess({
  command,
  args = [],
  cwd,
  env,
  requestTimeout = 20_000,
  onRequest,
  onNotification,
  onError,
  onExit,
}) {
  let nextId = 1;
  let alive = false;
  let shuttingDown = false;

  /** @type {Map<number, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  const child = spawn(command, args, {
    cwd,
    env: env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

  alive = true;

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  // --- stderr collection ---
  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (onError) {
        const text = chunk.toString('utf8').trim();
        if (text) {
          onError(new Error(`[stderr] ${text}`));
        }
      }
    });
  }

  // --- incoming message routing ---
  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (onError) {
        onError(new Error(`JSON parse error: ${line.slice(0, 200)}`));
      }
      return;
    }

    // Response to one of our outbound requests
    if (msg.id != null && !msg.method) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const errMsg = (typeof msg.error.message === 'string' && msg.error.message)
            || (typeof msg.error.data === 'string' && msg.error.data)
            || JSON.stringify(msg.error)
            || 'Unknown JSON-RPC error';
          entry.reject(new Error(errMsg));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // Request FROM the subprocess (has both id and method)
    if (msg.id != null && msg.method) {
      if (onRequest) {
        onRequest(msg.id, msg.method, msg.params);
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method && msg.id == null) {
      if (onNotification) {
        onNotification(msg.method, msg.params);
      }
      return;
    }

    // Unknown message shape — ignore
  });

  // --- process lifecycle ---
  child.once('error', (err) => {
    alive = false;
    rejectAllPending(err);
    if (onError) {
      onError(err);
    }
  });

  child.once('exit', (code, signal) => {
    alive = false;
    rejectAllPending(new Error(`Process exited (code=${code}, signal=${signal})`));
    rl.close();
    if (onExit) {
      onExit(code, signal);
    }
  });

  function rejectAllPending(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  // --- write helpers ---
  function writeLine(obj) {
    if (!alive || !child.stdin || child.stdin.destroyed) {
      throw new Error('Subprocess stdin not writable');
    }
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  // --- public API ---

  /**
   * Send a JSON-RPC request and wait for the response.
   * @param {string} method
   * @param {unknown} [params]
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<unknown>}
   */
  function sendRequest(method, params, options) {
    return new Promise((resolve, reject) => {
      if (!alive) {
        return reject(new Error('Subprocess is not alive'));
      }

      const id = nextId++;
      const timeout = options?.timeout ?? requestTimeout;

      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          entry.reject(new Error(`Request timeout: ${method} (id=${id}, ${timeout}ms)`));
        }
      }, timeout);

      pending.set(id, { resolve, reject, timer });

      try {
        const msg = { id, method };
        if (params !== undefined && params !== null) {
          msg.params = params;
        }
        writeLine(msg);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC response to a request initiated by the subprocess.
   * @param {number|string} id  The request id from onRequest
   * @param {unknown} [result]
   * @param {{ code?: number, message?: string, data?: unknown }} [error]
   */
  function sendResponse(id, result, error) {
    if (!alive) {
      return;
    }
    if (error) {
      writeLine({ id, error });
    } else {
      writeLine({ id, result: result ?? null });
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param {string} method
   * @param {unknown} [params]
   */
  function sendNotification(method, params) {
    if (!alive) {
      return;
    }
    const msg = { method };
    if (params !== undefined && params !== null) {
      msg.params = params;
    }
    writeLine(msg);
  }

  /**
   * Gracefully shut down the subprocess.
   * Sends a `shutdown` notification, waits up to `grace` ms, then kills.
   * @param {{ grace?: number }} [options]
   * @returns {Promise<void>}
   */
  function shutdown(options) {
    if (!alive || shuttingDown) {
      return Promise.resolve();
    }
    shuttingDown = true;

    return new Promise((resolve) => {
      const grace = options?.grace ?? 5000;

      const forceTimer = setTimeout(() => {
        kill();
        resolve();
      }, grace);

      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });

      try {
        sendNotification('shutdown');
      } catch {
        // stdin may already be closed
      }

      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch {
        // ignore
      }
    });
  }

  /**
   * Forcefully kill the subprocess.
   */
  function kill() {
    if (!child.killed) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // already dead
      }
    }
    alive = false;
    rejectAllPending(new Error('Subprocess killed'));
  }

  /**
   * @returns {boolean} Whether the subprocess is still alive.
   */
  function isAlive() {
    return alive;
  }

  /**
   * @returns {number|undefined} The PID of the subprocess.
   */
  function pid() {
    return child.pid;
  }

  return {
    sendRequest,
    sendResponse,
    sendNotification,
    shutdown,
    kill,
    isAlive,
    pid,
  };
}
