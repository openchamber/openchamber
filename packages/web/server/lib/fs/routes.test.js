import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';

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

const registerUpload = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => {
        if (targetPath === '/repo') return targetPath;
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      stat: async () => ({ isDirectory: () => false }),
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
  return getRoute('POST', '/api/fs/upload');
};

const registerRead = (fsPromises, resolveProjectDirectory = async () => ({ directory: '/repo' })) => {
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
    resolveProjectDirectory,
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
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
    resolveGitBinaryForSpawn: () => 'git',
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
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/mkdir');
};

const registerReveal = ({ fsPromises, spawn, platform = 'linux' }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn,
    platform,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/reveal');
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

const callUpload = async (handler, {
  body = Buffer.from('upload'),
  chunks,
  includeContentLength = true,
  path: filePath = '/repo/file.bin',
  overwrite = false,
} = {}) => {
  const res = createMockResponse();
  const uploadChunks = chunks ?? [body];
  const headers = { 'content-type': 'application/octet-stream' };
  if (includeContentLength) headers['content-length'] = String(body.length);
  const req = {
    headers,
    query: { path: filePath, overwrite: overwrite ? 'true' : undefined },
    async *[Symbol.asyncIterator]() {
      yield* uploadChunks;
    },
  };
  await handler(req, res);
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

const callReveal = async (handler, body) => {
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

describe('fs upload', () => {
  it('streams a binary file to temp storage before committing it without overwrite', async () => {
    const write = vi.fn(async (_buffer, _offset, length) => ({ bytesWritten: length }));
    const close = vi.fn(async () => undefined);
    const fsPromises = {
      open: vi.fn(async () => ({ write, close })),
      link: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerUpload(fsPromises);

    const body = Buffer.from([0, 1, 2, 255]);
    const res = await callUpload(handler, {
      body,
      chunks: [body.subarray(0, 2), body.subarray(2)],
    });

    expect(res.body).toEqual({ success: true, path: '/repo/file.bin' });
    const tmp = fsPromises.open.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/file\.bin\.upload-/);
    expect(fsPromises.open).toHaveBeenCalledWith(tmp, 'wx');
    expect(write).toHaveBeenNthCalledWith(1, Buffer.from([0, 1]), 0, 2, null);
    expect(write).toHaveBeenNthCalledWith(2, Buffer.from([2, 255]), 0, 2, null);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fsPromises.link).toHaveBeenCalledWith(tmp, '/repo/file.bin');
    expect(fsPromises.unlink).toHaveBeenCalledWith(tmp);
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of silently replacing an existing file', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isDirectory: () => false })),
      open: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
    };
    const handler = registerUpload(fsPromises);

    const res = await callUpload(handler);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'File already exists', reason: 'already-exists' });
    expect(fsPromises.open).not.toHaveBeenCalled();
  });

  it('atomically replaces a file only when overwrite is explicit', async () => {
    const write = vi.fn(async (_buffer, _offset, length) => ({ bytesWritten: length }));
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isDirectory: () => false })),
      open: vi.fn(async () => ({ write, close: vi.fn(async () => undefined) })),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerUpload(fsPromises);

    const res = await callUpload(handler, { overwrite: true });

    expect(res.body).toEqual({ success: true, path: '/repo/file.bin' });
    const tmp = fsPromises.open.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/file\.bin\.upload-/);
    expect(write).toHaveBeenCalledWith(Buffer.from('upload'), 0, 6, null);
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/file.bin');
  });

  it('rejects an existing directory before reading the upload body', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      open: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
    };
    const handler = registerUpload(fsPromises);

    const res = await callUpload(handler);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Specified path is a directory' });
    expect(fsPromises.open).not.toHaveBeenCalled();
  });

  it('rejects a destination parent that resolves outside the workspace', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath === '/repo/link' ? '/outside' : targetPath),
      open: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
    };
    const handler = registerUpload(fsPromises);

    const res = await callUpload(handler, { path: '/repo/link/file.bin' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(fsPromises.open).not.toHaveBeenCalled();
  });

  it('cleans up a partial temp file when the configured streaming limit is exceeded', async () => {
    const previous = process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES;
    process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES = '5';
    const write = vi.fn(async (_buffer, _offset, length) => ({ bytesWritten: length }));
    const fsPromises = {
      open: vi.fn(async () => ({ write, close: vi.fn(async () => undefined) })),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    try {
      const handler = registerUpload(fsPromises);
      const res = await callUpload(handler, {
        body: Buffer.from('123456'),
        chunks: [Buffer.from('123'), Buffer.from('456')],
        includeContentLength: false,
      });

      expect(res.statusCode).toBe(413);
      expect(res.body).toEqual({ error: 'File exceeds maximum size of 5 bytes' });
      expect(write).toHaveBeenCalledWith(Buffer.from('123'), 0, 3, null);
      expect(fsPromises.link).not.toHaveBeenCalled();
      expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/repo\/file\.bin\.upload-/));
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES;
      else process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES = previous;
    }
  });

  it('rejects a declared oversized upload before opening a temp file', async () => {
    const previous = process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES;
    process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES = '5';
    const fsPromises = {
      open: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
    };
    try {
      const handler = registerUpload(fsPromises);
      const res = await callUpload(handler, { body: Buffer.from('123456') });

      expect(res.statusCode).toBe(413);
      expect(res.body).toEqual({ error: 'File exceeds maximum size of 5 bytes' });
      expect(fsPromises.open).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES;
      else process.env.OPENCHAMBER_FS_UPLOAD_MAX_BYTES = previous;
    }
  });

  it('keeps the existing file when a target appears before the atomic commit', async () => {
    const error = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const fsPromises = {
      open: vi.fn(async () => ({
        write: vi.fn(async (_buffer, _offset, length) => ({ bytesWritten: length })),
        close: vi.fn(async () => undefined),
      })),
      link: vi.fn(async () => { throw error; }),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerUpload(fsPromises);

    const res = await callUpload(handler);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'File already exists', reason: 'already-exists' });
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/repo\/file\.bin\.upload-/));
  });
});

describe('fs read', () => {
  it('reads workspace files through symlinks that resolve outside the workspace', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/shared/target.txt';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'shared'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/link.txt' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('shared');
    expect(fsPromises.readFile).toHaveBeenCalledWith('/shared/target.txt', 'utf8');
  });

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

  it('reads files inside the workspace whose canonical path escapes through a symlinked directory', async () => {
    // ~/test_folder -> /outside/shared: the requested path is lexically inside
    // the workspace, the realpath is not. The read must follow the symlink
    // instead of rejecting it as an outside path.
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link/file.txt') return '/outside/shared/file.txt';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 5 })),
      readFile: vi.fn(async () => 'hello'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/link/file.txt' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(fsPromises.readFile).toHaveBeenCalledWith('/outside/shared/file.txt', 'utf8');
  });

  it('rejects reads of canonical paths outside the workspace that no workspace symlink reaches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/outside/shared/file.txt' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads files under a symlinked project root addressed via the client-sent lexical directory', async () => {
    // /home/user/proj -> /real/proj: the validated base is canonical but the
    // client (and the file tree) address files under the lexical root.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/home/user/proj') return '/real/proj';
        if (targetPath === '/home/user/proj/file.txt') return '/real/proj/file.txt';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 4 })),
      readFile: vi.fn(async () => 'data'),
    };
    const handler = registerRead(fsPromises, async () => ({
      directory: '/real/proj',
      requestedDirectory: '/home/user/proj',
    }));
    const res = createMockResponse();

    await handler({
      query: { path: '/home/user/proj/file.txt' },
      get: (name) => (name === 'x-opencode-directory' ? '/home/user/proj' : undefined),
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('data');
    expect(fsPromises.readFile).toHaveBeenCalledWith('/real/proj/file.txt', 'utf8');
    warn.mockRestore();
  });

  it('rejects path traversal that escapes the workspace even when it passes through a symlinked directory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link') return '/outside/shared';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/sub/../../etc/passwd' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
describe('fs reveal', () => {
  it.each([
    ['linux', 'xdg-open', ['/repo']],
    ['darwin', 'open', ['-R', '/repo/file.txt']],
  ])('returns a controlled error when the %s launcher is unavailable', async (platform, command, args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
      return child;
    });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
      platform,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to launch file browser' });
    expect(spawn).toHaveBeenCalledWith(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
    expect(child.unref).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('unrefs a detached launcher only after it spawns successfully', async () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('returns a controlled error when the launcher throws synchronously', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawnError = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn: vi.fn(() => { throw spawnError; }),
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to launch file browser' });
    expect(error).toHaveBeenCalledWith('Failed to reveal path:', expect.objectContaining({ cause: spawnError }));
    error.mockRestore();
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

describe('fs list symlink path space (issue 2627)', () => {
  const registerList = (fsPromises) => {
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
      resolveProjectDirectory: async () => ({ directory: '/workspace' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      openchamberUserConfigRoot: '/home/user/.config',
    });
    return getRoute('GET', '/api/fs/list');
  };

  const callList = async (handler, query) => {
    const res = createMockResponse();
    await handler({ query }, res);
    return res;
  };

  it('keeps entry paths in the requested path space when listing through a symlink', async () => {
    const dirents = [
      {
        name: 'src',
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
      },
      {
        name: 'README.md',
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
      },
    ];
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => (
        targetPath === '/workspace/pkg' ? '/real/pkg' : targetPath
      )),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => dirents),
    };
    const handler = registerList(fsPromises);

    const res = await callList(handler, { path: '/workspace/pkg' });

    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('/workspace/pkg');
    expect(res.body.entries).toEqual([
      {
        name: 'src',
        path: '/workspace/pkg/src',
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
      },
      {
        name: 'README.md',
        path: '/workspace/pkg/README.md',
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      },
    ]);
    expect(fsPromises.readdir).toHaveBeenCalledWith('/real/pkg', { withFileTypes: true });
  });

  for (const code of ['EACCES', 'EPERM']) {
    it(`maps ${code} to the os-permission contract`, async () => {
      const error = Object.assign(new Error('denied'), { code });
      const handler = registerList({
        stat: vi.fn(async () => ({ isDirectory: () => true })),
        readdir: vi.fn(async () => { throw error; }),
      });

      const res = await callList(handler, { path: '/workspace/protected' });

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Access to directory denied', reason: 'os-permission' });
    });
  }
});

describe('fs git-dirs', () => {
  const createDirent = (name, type) => ({
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
  });

  // tree maps directory path -> [[name, type], ...]
  const registerGitDirs = (tree, { stat, readdir: readdirOverride } = {}) => {
    const { app, getRoute } = createRouteRegistry();
    const readdir = readdirOverride ?? vi.fn(async (dirPath) => (tree[dirPath] ?? []).map(([name, type]) => createDirent(name, type)));
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises: {
        realpath: async (targetPath) => targetPath,
        stat: stat ?? vi.fn(async (targetPath) => ({ isDirectory: () => Boolean(tree[targetPath]) })),
        readdir,
      },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: async () => ({ directory: '/workspace' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      openchamberUserConfigRoot: '/home/user/.config',
    });
    return { handler: getRoute('GET', '/api/fs/git-dirs'), readdir };
  };

  const callGitDirs = async (handler, query) => {
    const res = createMockResponse();
    await handler({ query: query ?? {} }, res);
    return res;
  };

  it('returns an empty list when the root itself is a repository', async () => {
    const { handler, readdir } = registerGitDirs({
      '/workspace': [['.git', 'dir'], ['proj-a', 'dir']],
      '/workspace/proj-a': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: '/workspace', repositories: [] });
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it('finds nested repositories with a .git directory', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['proj-a', 'dir'], ['proj-b', 'dir']],
      '/workspace/proj-a': [['.git', 'dir'], ['src', 'dir']],
      '/workspace/proj-a/src': [['index.ts', 'file']],
      '/workspace/proj-b': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([
      { path: '/workspace/proj-a', name: 'proj-a' },
      { path: '/workspace/proj-b', name: 'proj-b' },
    ]);
  });

  it('treats a .git file (linked worktree) as a repository boundary', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['worktree', 'dir']],
      '/workspace/worktree': [['.git', 'file']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/worktree', name: 'worktree' }]);
  });

  it('stops descending at repository boundaries', async () => {
    const { handler, readdir } = registerGitDirs({
      '/workspace': [['outer', 'dir']],
      '/workspace/outer': [['.git', 'dir'], ['inner', 'dir']],
      '/workspace/outer/inner': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/outer', name: 'outer' }]);
    expect(readdir).not.toHaveBeenCalledWith('/workspace/outer/inner', { withFileTypes: true });
  });

  it('does not descend past the depth cap', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['a', 'dir']],
      '/workspace/a': [['b', 'dir']],
      '/workspace/a/b': [['c', 'dir']],
      '/workspace/a/b/c': [['.git', 'dir'], ['d', 'dir']],
      '/workspace/a/b/c/d': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/a/b/c', name: 'c' }]);
  });

  it('skips junk directories', async () => {
    const { handler, readdir } = registerGitDirs({
      '/workspace': [['node_modules', 'dir'], ['dist', 'dir'], ['real', 'dir']],
      '/workspace/node_modules': [['dep', 'dir']],
      '/workspace/node_modules/dep': [['.git', 'dir']],
      '/workspace/dist': [['.git', 'dir']],
      '/workspace/real': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/real', name: 'real' }]);
    expect(readdir).not.toHaveBeenCalledWith('/workspace/node_modules', { withFileTypes: true });
  });

  it('never descends into symbolic links', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['link', 'symlink'], ['real', 'dir']],
      '/workspace/real': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/real', name: 'real' }]);
  });

  it('returns repositories in deterministic order', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['zebra', 'dir'], ['alpha', 'dir']],
      '/workspace/zebra': [['.git', 'dir']],
      '/workspace/alpha': [['.git', 'dir']],
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.body.repositories.map((repo) => repo.name)).toEqual(['alpha', 'zebra']);
  });

  it('returns 400 when path is missing', async () => {
    const { handler } = registerGitDirs({});

    const res = await callGitDirs(handler, {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Path is required');
  });

  it('returns 400 when the path is not a directory', async () => {
    const { handler } = registerGitDirs({
      '/workspace': [['file.txt', 'file']],
    }, {
      stat: vi.fn(async (targetPath) => ({ isDirectory: () => targetPath !== '/workspace/file.txt' })),
    });

    const res = await callGitDirs(handler, { path: '/workspace/file.txt' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Specified path is not a directory', reason: 'not-directory' });
  });

  it('returns 404 when the directory does not exist', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const { handler } = registerGitDirs({}, {
      stat: vi.fn(async () => { throw error; }),
    });

    const res = await callGitDirs(handler, { path: '/workspace/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Directory not found', reason: 'not-found' });
  });

  for (const code of ['EACCES', 'EPERM']) {
    it(`maps root ${code} to the os-permission contract`, async () => {
      const error = Object.assign(new Error('denied'), { code });
      const { handler } = registerGitDirs({}, {
        stat: vi.fn(async () => ({ isDirectory: () => true })),
        readdir: vi.fn(async () => { throw error; }),
      });

      const res = await callGitDirs(handler, { path: '/workspace' });

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Access to directory denied', reason: 'os-permission' });
    });
  }

  it('skips unreadable subtrees without failing the scan', async () => {
    const tree = {
      '/workspace': [['blocked', 'dir'], ['open', 'dir']],
      '/workspace/open': [['.git', 'dir']],
    };
    const blockedError = Object.assign(new Error('denied'), { code: 'EACCES' });
    const { handler } = registerGitDirs(tree, {
      readdir: vi.fn(async (dirPath) => {
        if (dirPath === '/workspace/blocked') {
          throw blockedError;
        }
        return (tree[dirPath] ?? []).map(([name, type]) => createDirent(name, type));
      }),
    });

    const res = await callGitDirs(handler, { path: '/workspace' });

    expect(res.statusCode).toBe(200);
    expect(res.body.repositories).toEqual([{ path: '/workspace/open', name: 'open' }]);
  });
});

describe('fs stat directory scope (issue 3019)', () => {
  // Wires the real project-directory runtime so the stat route resolves the
  // workspace exactly as the server does: explicit x-opencode-directory header
  // first, then the settings.lastDirectory fallback. The renderer's file
  // reference probes must send the header because lastDirectory reflects the
  // directory the UI last browsed, not the session's directory.
  const registerStatWithProjectDirectoryRuntime = () => {
    const projectDirectoryRuntime = createProjectDirectoryRuntime({
      fsPromises: {
        stat: async (targetPath) => {
          if (targetPath === '/repo-a' || targetPath === '/repo-b') {
            return { isDirectory: () => true };
          }
          return { isDirectory: () => false, isFile: () => true, size: 12 };
        },
        realpath: async (targetPath) => targetPath,
      },
      path: { resolve: (p) => path.posix.resolve(p) },
      normalizeDirectoryPath: (p) => p,
      readSettingsFromDiskMigrated: async () => ({ lastDirectory: '/repo-a', projects: [] }),
      getReadSettingsFromDiskMigrated: undefined,
      sanitizeProjects: (input) => input,
    });

    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises: {
        realpath: async (targetPath) => targetPath,
        stat: async () => ({ isFile: () => true, size: 12 }),
      },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: projectDirectoryRuntime.resolveProjectDirectory,
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      openchamberUserConfigRoot: '/home/user/.config',
    });
    return getRoute('GET', '/api/fs/stat');
  };

  const callStat = async (handler, { headers = {}, query }) => {
    const res = createMockResponse();
    const req = {
      query,
      get: (name) => headers[name.toLowerCase()] ?? undefined,
    };
    await handler(req, res);
    return res;
  };

  it('rejects a stat for a file under the session directory when only lastDirectory resolves the workspace', async () => {
    const handler = registerStatWithProjectDirectoryRuntime();

    const res = await callStat(handler, { query: { path: '/repo-b/src/index.ts', optional: 'true' } });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
  });

  it('accepts the same stat when the session directory rides the x-opencode-directory header', async () => {
    const handler = registerStatWithProjectDirectoryRuntime();

    const res = await callStat(handler, {
      headers: { 'x-opencode-directory': '/repo-b' },
      query: { path: '/repo-b/src/index.ts', optional: 'true' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.isFile).toBe(true);
  });
});
