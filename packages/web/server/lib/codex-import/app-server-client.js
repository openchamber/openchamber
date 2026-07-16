import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const createCodexAppServerClient = ({
  spawn,
  command = process.env.CODEX_BINARY || process.env.CODEX_CLI_PATH || 'codex',
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) => {
  let child = null;
  let nextRequestId = 1;
  let closed = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    rejectPending(new Error('Codex app-server connection closed'));
    child?.kill();
    child = null;
  };

  const send = (message) => {
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error('Codex app-server is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method, params = {}) => {
    if (closed) {
      return Promise.reject(new Error('Codex app-server connection closed'));
    }

    const id = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timeout });

      try {
        send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const start = async () => {
    if (child) return;
    closed = false;
    const useWindowsCommandShim = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(command);
    const executable = useWindowsCommandShim ? (process.env.ComSpec || 'cmd.exe') : command;
    const windowsInvocation = /[\\/\s]|\.(?:cmd|bat)$/i.test(command)
      ? `call "${command.replace(/"/g, '""')}" app-server --stdio`
      : `${command} app-server --stdio`;
    const args = useWindowsCommandShim
      ? ['/d', '/s', '/c', windowsInvocation]
      : ['app-server', '--stdio'];
    child = spawn(executable, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.resume?.();

    child.once('error', (error) => {
      const wrapped = new Error(`Unable to start Codex app-server: ${error.message}`);
      wrapped.code = error.code;
      rejectPending(wrapped);
    });
    child.once('exit', (code, signal) => {
      if (closed) return;
      rejectPending(new Error(`Codex app-server exited (${signal || code || 'unknown'})`));
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (typeof message?.id !== 'number') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error.message || 'Codex app-server request failed'));
        return;
      }
      entry.resolve(message.result);
    });

    await request('initialize', {
      clientInfo: {
        name: 'openchamber',
        title: 'OpenChamber',
        version: '1',
      },
    });
    send({ method: 'initialized', params: {} });
  };

  return { start, request, close };
};
