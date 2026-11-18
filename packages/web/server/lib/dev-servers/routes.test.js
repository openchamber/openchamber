import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';

import { createDevServerScanner, registerDevServerRoutes } from './routes.js';

/** A spawn that answers each command from a table, as the real tools would. */
const fakeSpawn = (answers) => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    const answer = answers(command, args);
    queueMicrotask(() => {
      if (answer === null) {
        child.emit('close', 1);
        return;
      }
      child.stdout.emit('data', answer);
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
};

const LISTENERS = ['p10', 'cnode', 'n*:5173', 'p11', 'cControlCenter', 'n*:7000'].join('\n');

const procTable = (...localAddresses) => [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  ...localAddresses.map((address, index) => `   ${index}: ${address} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${index + 1} 1 0000 100 0`),
].join('\n');

/** Serves the given /proc tables; any other path fails as it does on macOS. */
const proc = (tables) => async (path) => {
  const table = tables[path];
  if (table === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
  return table;
};

const discover = ({ lsofOutput, procTables, ownPorts, cwdOutput = null }) => {
  const { spawn } = fakeSpawn((_command, args) => (args.includes('cwd') ? cwdOutput : lsofOutput));
  return createDevServerScanner({ spawn, platform: 'linux', readFile: proc(procTables) }).discover({ ownPorts });
};

describe('dev server scanner', () => {
  test('reports the folder each server runs in', async () => {
    const { spawn, calls } = fakeSpawn((_command, args) => (
      args.includes('cwd') ? ['p10', 'fcwd', 'n/Users/me/site', 'p11', 'fcwd', 'n/'].join('\n') : LISTENERS
    ));
    const scanner = createDevServerScanner({ spawn, platform: 'darwin', readFile: proc({}) });

    const result = await scanner.discover();

    expect(result.servers.map(({ port, directory }) => ({ port, directory }))).toEqual([
      { port: 5173, directory: '/Users/me/site' },
      { port: 7000, directory: '/' },
    ]);
    // One extra call for all processes together, never one per process.
    expect(calls.filter((call) => call.includes('cwd'))).toEqual(['lsof -a -d cwd -p 10,11 -F pn']);
  });

  test('still lists the servers when their folders cannot be read', async () => {
    const { spawn } = fakeSpawn((_command, args) => (args.includes('cwd') ? null : LISTENERS));
    const scanner = createDevServerScanner({ spawn, platform: 'darwin', readFile: proc({}) });

    const result = await scanner.discover();

    expect(result.servers.map((server) => server.port)).toEqual([5173, 7000]);
    expect(result.servers.every((server) => server.directory === undefined)).toBe(true);
  });
});

describe('dev-server discovery on Linux', () => {
  test('adds listeners that lsof could not see and keeps lsof metadata and folders for the rest', async () => {
    const result = await discover({
      lsofOutput: ['p10', 'cnode', 'n*:5173'].join('\n'),
      cwdOutput: ['p10', 'fcwd', 'n/project'].join('\n'),
      procTables: {
        // 5173 from the IPv4 table, and the root-owned docker-proxy on 127.0.0.1:8080.
        '/proc/net/tcp': procTable('00000000:1435', '0100007F:1F90'),
        '/proc/net/tcp6': procTable('00000000000000000000000000000000:1435'),
      },
    });

    expect(result).toEqual({
      ok: true,
      servers: [
        { port: 5173, pid: 10, command: 'node', directory: '/project', url: 'http://localhost:5173/' },
        { port: 8080, pid: null, command: '', url: 'http://localhost:8080/' },
      ],
    });
  });

  test('still drops OpenChamber listeners and ignored ports that /proc reports', async () => {
    const result = await discover({
      lsofOutput: [`p${process.pid}`, 'cnode', 'n127.0.0.1:4100'].join('\n'),
      procTables: {
        // 4100 is this process, 4096 an own port, 5432 postgres, 8080 a dev server.
        '/proc/net/tcp': procTable('0100007F:1004', '0100007F:1000', '00000000:1538', '0100007F:1F90'),
      },
      ownPorts: [4096],
    });

    expect(result.ok && result.servers.map((entry) => entry.port)).toEqual([8080]);
  });

  test('reports what one source found when the other is unavailable', async () => {
    const withoutLsof = await discover({
      lsofOutput: null,
      procTables: { '/proc/net/tcp': procTable('0100007F:1F90') },
    });
    const withoutProc = await discover({
      lsofOutput: ['p10', 'cnode', 'n*:5173'].join('\n'),
      procTables: {},
    });

    expect(withoutLsof.ok && withoutLsof.servers.map((entry) => entry.port)).toEqual([8080]);
    expect(withoutProc.ok && withoutProc.servers.map((entry) => entry.port)).toEqual([5173]);
  });

  test('reports failure, never an empty list, when neither source answers', async () => {
    expect(await discover({ lsofOutput: null, procTables: {} }))
      .toEqual({ ok: false, reason: 'no-listener-source' });
  });
});

describe('dev-server routes', () => {
  const request = async (scanner, ownPorts = []) => {
    let handler;
    let status = 200;
    let body;
    registerDevServerRoutes({ get: (_path, callback) => { handler = callback; } }, {
      scanner,
      getOwnPorts: () => ownPorts,
    });
    const response = {
      status(code) { status = code; return response; },
      json(value) { body = value; },
    };
    await handler({}, response);
    return { status, body };
  };

  test('passes own ports to the scanner and returns its servers', async () => {
    const servers = [{ port: 5173, pid: null, command: '', url: 'http://localhost:5173/' }];
    expect(await request({
      discover: async (options) => {
        expect(options).toEqual({ ownPorts: [4096] });
        return { ok: true, servers };
      },
    }, [4096])).toEqual({ status: 200, body: { servers } });
  });

  test('reports a failed scan as unavailable', async () => {
    expect(await request({ discover: async () => ({ ok: false, reason: 'no-listener-source' }) }))
      .toEqual({
        status: 503,
        body: { error: 'Port discovery is unavailable', reason: 'no-listener-source' },
      });
  });

  test.each([
    [new Error('scan failed'), 'scan failed'],
    [{ message: 'plain error' }, 'plain error'],
    [{ message: 42 }, 42],
    [Object.create({ message: 'inherited error' }), 'inherited error'],
    [new Proxy({}, { get: () => 'proxy error', has: () => false }), 'proxy error'],
    [{ message: '' }, 'Port discovery failed'],
    ['scan failed', 'Port discovery failed'],
    [null, 'Port discovery failed'],
    [undefined, 'Port discovery failed'],
  ])('preserves the response for thrown value %p', async (error, message) => {
    expect(await request({ discover: async () => { throw error; } }))
      .toEqual({ status: 500, body: { error: message } });
  });
});
