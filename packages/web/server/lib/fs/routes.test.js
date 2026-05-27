import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFsRoutes } from './routes.js';

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
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
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
    resolveGitBinaryForSpawn: () => 'git',
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
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/write');
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
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'new' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/repo', { recursive: true });
    expect(fsPromises.writeFile).toHaveBeenCalledWith('/repo/file.txt', 'new', 'utf8');
  });
});

describe('fs exec git-read cache', () => {
  beforeEach(() => {
    delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS;
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

    await callExec(handler, { commands: [command], cwd: '/repo-a' });
    await callExec(handler, { commands: [command], cwd: '/repo-b' });

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

    await callExec(handler, { commands: [command], cwd: '/not-a-repo' });
    await callExec(handler, { commands: [command], cwd: '/not-a-repo' });

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
      await callExec(handler, { commands: [command], cwd: `/repo-${i}` });
    }
    const afterFill = calls.length;
    expect(afterFill).toBe(500);

    // One more distinct dir evicts the oldest entry (/repo-0).
    await callExec(handler, { commands: [command], cwd: '/repo-overflow' });
    // Evicted entry must re-run; a surviving entry must still be served.
    await callExec(handler, { commands: [command], cwd: '/repo-0' });   // evicted -> spawns
    await callExec(handler, { commands: [command], cwd: '/repo-499' }); // cached  -> no spawn

    expect(calls.length).toBe(afterFill + 2);
  });
});
