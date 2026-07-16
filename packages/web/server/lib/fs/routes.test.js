import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

// Fake child process: emits the configured stdout then closes with the given code.
const createSpawn = ({ stdoutByCommand = {}, exitCode = 0 } = {}) => {
  const calls = [];
  const spawn = vi.fn((_shell, args) => {
    const command = args[args.length - 1];
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const out = stdoutByCommand[command];
      if (out) child.stdout.emit('data', Buffer.from(out));
      child.emit('close', exitCode, null);
    });
    return child;
  });
  return { spawn, calls };
};

const createDeferredSpawn = ({ stdoutByCommand = {}, exitCode = 0 } = {}) => {
  const calls = [];
  const pending = [];
  const spawn = vi.fn((_shell, args) => {
    const command = args[args.length - 1];
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    pending.push({ child, command });
    return child;
  });
  const closeNext = () => {
    const entry = pending.shift();
    if (!entry) return;
    const out = stdoutByCommand[entry.command];
    if (out) entry.child.stdout.emit('data', Buffer.from(out));
    entry.child.emit('close', exitCode, null);
  };
  return { spawn, calls, closeNext };
};

const registerExec = ({ spawn }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      stat: async () => ({ isDirectory: () => true }),
    },
    spawn,
    crypto: { randomUUID: (() => { let n = 0; return () => `job-${n++}`; })() },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/exec');
};

const registerWrite = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/write');
};

const registerRead = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/read');
};

const registerRaw = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/raw');
};

const registerMkdir = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/mkdir');
};

const registerClone = ({ cloneRepository, fsPromises = {} }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }),
      mkdir: vi.fn(async () => undefined),
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/augmented/bin',
    cloneRepository,
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/clone');
};

const registerList = ({ getIgnoredPaths }) => {
  const { app, getRoute } = createRouteRegistry();
  const dirents = [
    { name: 'ignored.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    { name: 'visible.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
  ];
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => dirents),
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/augmented/bin',
    getIgnoredPaths,
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/list');
};

const callExec = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callWrite = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callRead = async (handler, query) => {
  const res = createMockResponse();
  await handler({ query }, res);
  return res;
};

const callRaw = async (handler, query) => {
  const res = createMockResponse();
  await handler({ query }, res);
  return res;
};

const callMkdir = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callClone = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

describe('fs clone', () => {
  it('delegates cloning to the bounded Git service without changing the response', async () => {
    const cloneRepository = vi.fn(async () => 'Cloning into repo...');
    const handler = registerClone({ cloneRepository });

    const res = await callClone(handler, {
      remoteUrl: 'https://example.com/owner/repo.git',
      destinationPath: '/repo/clone',
    });

    expect(cloneRepository).toHaveBeenCalledWith({
      remoteUrl: 'https://example.com/owner/repo.git',
      destination: '/repo/clone',
      identity: null,
      pathEnvironment: '/augmented/bin',
    });
    expect(res.body).toEqual({
      success: true,
      path: '/repo/clone',
      output: 'Cloning into repo...',
    });
  });

  it('preserves the destination-exists conflict response after reservation wait', async () => {
    const cloneRepository = vi.fn(async () => {
      const error = new Error('Destination path already exists');
      error.code = 'EEXIST';
      throw error;
    });
    const handler = registerClone({ cloneRepository });

    const res = await callClone(handler, {
      remoteUrl: 'https://example.com/owner/repo.git',
      destinationPath: '/repo/clone',
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Destination path already exists' });
  });
});

describe('fs list Git ignore filtering', () => {
  it('delegates ignore checks to the classified Git service', async () => {
    const getIgnoredPaths = vi.fn(async () => ['ignored.txt']);
    const handler = registerList({ getIgnoredPaths });
    const res = createMockResponse();

    await handler({ query: { path: '/repo', respectGitignore: 'true' } }, res);

    expect(getIgnoredPaths).toHaveBeenCalledWith(
      '/repo',
      ['ignored.txt', 'visible.txt'],
      { signal: expect.anything() },
    );
    expect(res.body.entries.map((entry) => entry.name)).toEqual(['visible.txt']);
  });

  it('fails open when the classified ignore check fails', async () => {
    const getIgnoredPaths = vi.fn(async () => {
      throw new Error('ignore check failed');
    });
    const handler = registerList({ getIgnoredPaths });
    const res = createMockResponse();

    await handler({ query: { path: '/repo', respectGitignore: 'true' } }, res);

    expect(res.body.entries.map((entry) => entry.name)).toEqual(['ignored.txt', 'visible.txt']);
  });

  it('aborts a timed-out ignore check, fails open, and leaves no unsettled work', async () => {
    const previousTimeout = process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
    process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = '25';
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    let activeChecks = 0;
    let observedAbort = false;

    try {
      const getIgnoredPaths = vi.fn((_directory, _paths, { signal }) => {
        activeChecks += 1;
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            observedAbort = true;
            activeChecks -= 1;
            reject(new Error('ignore check aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      });
      const handler = registerList({ getIgnoredPaths });
      const res = createMockResponse();
      const request = handler({ query: { path: '/repo', respectGitignore: 'true' } }, res);

      await request;
      await Promise.resolve();

      expect(observedAbort).toBe(true);
      expect(activeChecks).toBe(0);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(res.body.entries.map((entry) => entry.name)).toEqual(['ignored.txt', 'visible.txt']);
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      if (previousTimeout === undefined) {
        delete process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
      } else {
        process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});

describe('fs write', () => {
  it('does not rewrite a file when content is unchanged', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => 'same'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'same' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('writes a file when content changed', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'new' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/repo', { recursive: true });
    const tmp = fsPromises.writeFile.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/file\.txt\.tmp-/);
    expect(fsPromises.writeFile).toHaveBeenCalledWith(tmp, 'new', 'utf8');
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/file.txt');
    expect(fsPromises.unlink).not.toHaveBeenCalled();
  });

  it('writes through existing symlinks without replacing the link', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/repo/target.txt';
        return targetPath;
      }),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.body).toEqual({ success: true, path: '/repo/link.txt' });
    expect(fsPromises.readFile).toHaveBeenCalledWith('/repo/target.txt', 'utf8');
    const tmp = fsPromises.writeFile.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/target\.txt\.tmp-/);
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/target.txt');
    expect(fsPromises.rename).not.toHaveBeenCalledWith(expect.any(String), '/repo/link.txt');
  });

  it('rejects existing symlinks that resolve outside the workspace', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/outside/target.txt';
        return targetPath;
      }),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });
});

describe('fs read', () => {
  it('rejects outside workspace reads without a grant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/etc/passwd', allowOutsideWorkspace: 'true' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file access requires a grant' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allows outside workspace reads with an exact-path grant', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/plan.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-read' },
    });
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
      path: '/outside/plan.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('secret');
  });

  it('rejects outside workspace grants for a different canonical path', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/a.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-mismatch' },
    });
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
      path: '/outside/b.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file grant does not match requested path' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('sets no-referrer on raw responses served through outside file grants', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('secret')),
    };
    const grant = await mintOutsideFileGrant('/outside/image.png', {
      scopes: ['raw'],
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-raw' },
    });
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/outside/image.png',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
  });

  it('rejects outside workspace mkdir without a trusted directory grant', async () => {
    const fsPromises = {
      mkdir: vi.fn(async () => undefined),
    };
    const handler = registerMkdir(fsPromises);

    const res = await callMkdir(handler, { path: '/tmp/staging', allowOutsideWorkspace: true });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Outside workspace directory creation requires a grant' });
    expect(fsPromises.mkdir).not.toHaveBeenCalled();
  });

  it('logs when empty-read retries are exhausted after non-empty stat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => ''),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/file.txt' });

    expect(res.body).toBe('');
    expect(fsPromises.readFile).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Read retry exhausted for /repo/file.txt'));
    warn.mockRestore();
  });
});

describe('fs exec git-read cache', () => {
  beforeEach(() => {
    delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
  });

  it('rejects background command execution', async () => {
    const { spawn } = createSpawn();
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/repo', background: true });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Background command execution is not allowed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects command execution outside the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = createSpawn();
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(spawn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches an allowlisted git rev-parse across identical requests', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [command], cwd: '/repo' });
    const second = await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(first.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(second.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(second.body.success).toBe(true);
    // Spawned once; the second request is served from cache.
    expect(calls.length).toBe(1);
  });

  it('dedupes concurrent identical git-read requests while the first is in flight', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls, closeNext } = createDeferredSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = callExec(handler, { commands: [command], cwd: '/repo' });
    const second = callExec(handler, { commands: [command], cwd: '/repo' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);

    closeNext();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(secondRes.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(calls.length).toBe(1);
  });

  it('returns the current request command for normalized cache hits', async () => {
    const firstCommand = 'git   rev-parse   --absolute-git-dir';
    const secondCommand = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [firstCommand]: '/repo/.git\n' } });
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [firstCommand], cwd: '/repo' });
    const second = await callExec(handler, { commands: [secondCommand], cwd: '/repo' });

    expect(first.body.results[0].command).toBe(firstCommand);
    expect(second.body.results[0].command).toBe(secondCommand);
    expect(calls.length).toBe(1);
  });

  it('keys the cache by working directory', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/x/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/a' });
    await callExec(handler, { commands: [command], cwd: '/repo/b' });

    expect(calls.length).toBe(2);
  });

  it('never caches non-allowlisted commands', async () => {
    const command = 'git status';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: 'clean\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('does not cache failed git-read results', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: {}, exitCode: 128 });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });
    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });

    expect(calls.length).toBe(2);
  });

  it('disables caching when TTL is 0', async () => {
    process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS = '0';
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('re-runs once a cached entry ages past the TTL', async () => {
    vi.useFakeTimers();
    try {
      const command = 'git rev-parse --absolute-git-dir';
      const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
      const handler = registerExec({ spawn }); // default 30s TTL

      await callExec(handler, { commands: [command], cwd: '/repo' });
      vi.advanceTimersByTime(31_000);
      await callExec(handler, { commands: [command], cwd: '/repo' });

      // Stale entry is not served; a fresh subprocess fires.
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the cache by evicting the least-recently-used entry past the count cap', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn(); // exit 0, empty stdout — still cacheable
    const handler = registerExec({ spawn });

    // Fill to the 500-entry ceiling with distinct working directories.
    for (let i = 0; i < 500; i += 1) {
      await callExec(handler, { commands: [command], cwd: `/repo/worktree-${i}` });
    }
    const afterFill = calls.length;
    expect(afterFill).toBe(500);

    // One more distinct dir evicts the oldest entry (/repo/worktree-0).
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-overflow' });
    // Evicted entry must re-run; a surviving entry must still be served.
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-0' });   // evicted -> spawns
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-499' }); // cached  -> no spawn

    expect(calls.length).toBe(afterFill + 2);
  });
});

describe('fs raw download Content-Disposition', () => {
  it('uses RFC 5987 filename*= encoding for non-ASCII filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/repo/文件.txt',
      download: 'true',
    });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('文件.txt'));
    // ASCII fallback strips non-ASCII chars, leaving extension
    expect(cd).toContain('filename=".txt"');
  });

  it('uses plain filename for ASCII-only filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, { path: '/repo/readme.txt', download: 'true' });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
    expect(cd).toContain('filename="readme.txt"');
    expect(cd).toContain("filename*=UTF-8''readme.txt");
  });
});
