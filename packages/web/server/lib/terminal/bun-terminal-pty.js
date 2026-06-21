class EventEmitter {
  constructor() {
    this._listeners = [];
  }

  on(callback) {
    this._listeners.push(callback);
    return {
      dispose: () => {
        const idx = this._listeners.indexOf(callback);
        if (idx !== -1) this._listeners.splice(idx, 1);
      },
    };
  }

  fire(data) {
    for (const listener of [...this._listeners]) {
      listener(data);
    }
  }
}

export function spawn(file, args, opts = {}) {
  const argv = Array.isArray(args) ? args : [];
  const decoder = new TextDecoder('utf-8');
  const onDataEmitter = new EventEmitter();
  const onExitEmitter = new EventEmitter();
  let _closing = false;
  let _exited = false;
  let _terminalClosed = false;

  const cols = opts.cols || 80;
  const rows = opts.rows || 24;
  const cwd = opts.cwd || process.cwd();
  const closeTerminal = () => {
    if (_terminalClosed) {
      return;
    }

    _terminalClosed = true;
    try {
      proc.terminal?.close();
    } catch {
    }
  };

  const proc = Bun.spawn([file, ...argv], {
    cwd,
    env: opts.env,
    terminal: {
      cols,
      rows,
      name: opts.name || 'xterm-256color',
      data(_terminal, data) {
        const str = decoder.decode(data, { stream: true });
        if (str) onDataEmitter.fire(str);
      }
    }
  });

  proc.exited.then((exitCode) => {
    const remaining = decoder.decode();
    if (remaining) onDataEmitter.fire(remaining);
    closeTerminal();
    if (!_exited) {
      _exited = true;
      onExitEmitter.fire({ exitCode, signal: proc.signalCode });
    }
  }).catch(() => {
    closeTerminal();
    if (!_exited) {
      _exited = true;
      onExitEmitter.fire({ exitCode: -1, signal: proc.signalCode ?? null });
    }
  });

  return {
    get pid() {
      return proc.pid;
    },
    onData: (cb) => onDataEmitter.on(cb),
    onExit: (cb) => onExitEmitter.on(cb),
    write(data) {
      if (_closing) return;
      try {
        proc.terminal?.write(data);
      } catch {
      }
    },
    resize(cols, rows) {
      if (_closing) return;
      try {
        proc.terminal?.resize(cols, rows);
      } catch {
      }
    },
    kill(signal) {
      if (_closing) return;
      _closing = true;

      const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
      try {
        proc.kill(sig);
      } catch {
        closeTerminal();
      }
    },
    pause() {},
    resume() {},
  };
}
