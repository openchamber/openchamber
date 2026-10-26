import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedProcessRegistry } from './managed-process-registry.js';

// The registry takes its filesystem and child-process helpers as dependencies,
// so these tests inject fakes instead of mocking node builtins.
const readdirMock = vi.fn();
const readFileMock = vi.fn();
const rmMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
const renameMock = vi.fn();

// `execFileImpl` is the swappable per-test implementation, called with the same
// (cmd, args, opts, cb) shape the callback-style `execFile` uses; the injected
// `execFileAsync` adapts it to the `{ stdout, stderr }` promise the module awaits.
const execFileImpl = vi.fn();

const { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } = createManagedProcessRegistry({
  fs: {
    readdir: readdirMock,
    readFile: readFileMock,
    rm: rmMock,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
    rename: renameMock,
  },
  execFileAsync: (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      execFileImpl(cmd, args, opts, (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout: stdout ?? '', stderr: stderr ?? '' }));
    }),
});

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_KILL = process.kill;
const killMock = vi.fn();

const setPlatform = (platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const restorePlatform = () => {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
  }
};

const installKillMock = () => {
  Object.defineProperty(process, 'kill', { value: killMock, configurable: true });
};

const restoreKill = () => {
  Object.defineProperty(process, 'kill', { value: ORIGINAL_KILL, configurable: true });
};

// Helper to make given pids look alive on signal-0 (returns true); any other
// pid throws ESRCH (dead). Non-zero signals always "succeed" so `killOrphan`'s
// signalTree is inert under test.
const killAliveFor = (alivePids) =>
  killMock.mockImplementation((pid, signal) => {
    if (signal === 0 || signal === undefined) {
      if (alivePids.includes(pid)) return true;
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  });

// Configure `execFileImpl` with a (cmd, args, opts, cb) dispatcher.
const execFileYields = (dispatch) =>
  execFileImpl.mockImplementation((cmd, args, opts, cb) => dispatch(cmd, args, opts, cb));

beforeEach(() => {
  readdirMock.mockReset();
  readFileMock.mockReset();
  rmMock.mockReset();
  mkdirMock.mockReset();
  writeFileMock.mockReset();
  renameMock.mockReset();
  execFileImpl.mockReset();
  killMock.mockReset();
  installKillMock();
});

afterEach(() => {
  restoreKill();
  restorePlatform();
});

describe('reapOrphanedProcesses', () => {
  it('returns zero counts when the registry directory is missing', async () => {
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await reapOrphanedProcesses();

    expect(result).toEqual({ inspected: 0, reaped: 0 });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('drops registry entries whose pid is already dead, without spawning anything', async () => {
    readdirMock.mockResolvedValue(['99999.json']);
    readFileMock.mockResolvedValue(
      JSON.stringify({ pid: 99999, ownerPid: 12345, port: 4096, binary: '/opencode', runtime: 'web' }),
    );
    killMock.mockImplementation(() => {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    });
    rmMock.mockResolvedValue();

    const result = await reapOrphanedProcesses();

    expect(result).toEqual({ inspected: 1, reaped: 0 });
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  describe('on Windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('reaps an opencode image whose owner is gone', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: 'opencode.exe', runtime: 'desktop' }),
      );
      // pid 777 alive, owner 12345 dead.
      killAliveFor([777]);
      execFileYields((cmd, _args, _opts, cb) => {
        if (cmd === 'tasklist') return cb(null, 'opencode.exe', '');
        if (cmd === 'taskkill') return cb(null, '', '');
        cb(new Error(`unexpected cmd: ${cmd}`));
      });
      rmMock.mockResolvedValue();

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 1 });
      expect(execFileImpl).toHaveBeenCalledWith(
        'tasklist',
        expect.any(Array),
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
      expect(execFileImpl).toHaveBeenCalledWith(
        'taskkill',
        expect.any(Array),
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
    });

    it('leaves a non-opencode image alone even if the owner is gone', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: 'opencode.exe', runtime: 'desktop' }),
      );
      killAliveFor([777]);
      execFileYields((_cmd, _args, _opts, cb) => cb(null, 'notepad.exe', ''));
      rmMock.mockResolvedValue();

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 0 });
      const calls = execFileImpl.mock.calls.filter(([cmd]) => cmd === 'taskkill');
      expect(calls).toHaveLength(0);
    });

    it('leaves an opencode image whose owner is still alive', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: 'opencode.exe', runtime: 'desktop' }),
      );
      // Both alive.
      killAliveFor([777, 12345]);
      execFileYields((_cmd, _args, _opts, cb) => cb(null, 'opencode.exe', ''));

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 0 });
      const calls = execFileImpl.mock.calls.filter(([cmd]) => cmd === 'taskkill');
      expect(calls).toHaveLength(0);
    });
  });

  describe('on Unix', () => {
    beforeEach(() => setPlatform('linux'));

    it('reaps a reparented opencode serve matching the recorded port', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: '/opencode', runtime: 'web' }),
      );
      // pid 777 stays "alive"; killOrphan's signalTree is inert (mock returns
      // true for non-zero signals), and its wait loop sees isPidAlive true so
      // it exhausts the SIGTERM wait then sends SIGKILL and sleeps 300ms.
      killAliveFor([777]);
      execFileYields((cmd, _args, _opts, cb) => {
        if (cmd === 'ps') return cb(null, '1 /usr/bin/opencode serve --port 4096\n', '');
        cb(new Error(`unexpected cmd: ${cmd}`));
      });
      rmMock.mockResolvedValue();

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 1 });
    });

    it('leaves a process whose command is not our opencode serve', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: '/opencode', runtime: 'web' }),
      );
      killAliveFor([777]);
      execFileYields((cmd, _args, _opts, cb) => {
        if (cmd === 'ps') return cb(null, '1 /some/other/binary serve\n', '');
        cb(new Error(`unexpected cmd: ${cmd}`));
      });

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 0 });
    });

    it('leaves a process still owned by a live owner (not reparented)', async () => {
      readdirMock.mockResolvedValue(['777.json']);
      readFileMock.mockResolvedValue(
        JSON.stringify({ pid: 777, ownerPid: 12345, port: 4096, binary: '/opencode', runtime: 'web' }),
      );
      killAliveFor([777, 12345]);
      execFileYields((cmd, _args, _opts, cb) => {
        if (cmd === 'ps') return cb(null, '12345 /usr/bin/opencode serve --port 4096\n', '');
        cb(new Error(`unexpected cmd: ${cmd}`));
      });

      const result = await reapOrphanedProcesses({ log: () => {} });

      expect(result).toEqual({ inspected: 1, reaped: 0 });
    });
  });
});

describe('registerManagedProcess', () => {
  it('writes an entry file atomically via tmp + rename', async () => {
    mkdirMock.mockResolvedValue();
    writeFileMock.mockResolvedValue();
    renameMock.mockResolvedValue();

    await registerManagedProcess({ pid: 4242, ownerPid: 12345, port: 4096, binary: '/opencode', runtime: 'desktop' });

    expect(mkdirMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('4242.json.tmp-'),
      expect.any(String),
    );
    expect(renameMock).toHaveBeenCalledWith(
      expect.stringContaining('4242.json.tmp-'),
      expect.stringContaining('4242.json'),
    );
  });

  it('is a no-op for a non-integer pid', async () => {
    await registerManagedProcess({ pid: 'not-a-pid' });

    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe('unregisterManagedProcess', () => {
  it('removes the entry file', async () => {
    rmMock.mockResolvedValue();

    await unregisterManagedProcess(4242);

    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining('4242.json'), { force: true });
  });

  it('is a no-op for a non-integer pid', async () => {
    await unregisterManagedProcess(undefined);

    expect(rmMock).not.toHaveBeenCalled();
  });
});
