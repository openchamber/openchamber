import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';

import { createDevServerScanner } from './routes.js';

/** An `lsof` that prints `output` and exits 0, or is not installed when `output` is null. */
const lsof = (output) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (output === null) {
      child.emit('error', new Error('spawn lsof ENOENT'));
      return;
    }
    child.stdout.emit('data', output);
    child.emit('close', 0);
  });
  return child;
};

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

const discover = ({ lsofOutput, procTables, ownPorts }) => createDevServerScanner({
  spawn: lsof(lsofOutput),
  platform: 'linux',
  readFile: proc(procTables),
}).discover({ ownPorts });

describe('dev-server discovery on Linux', () => {
  test('adds listeners that lsof could not see and keeps lsof metadata for the rest', async () => {
    const result = await discover({
      lsofOutput: ['p10', 'cnode', 'n*:5173'].join('\n'),
      procTables: {
        // 5173 from the IPv4 table, and the root-owned docker-proxy on 127.0.0.1:8080.
        '/proc/net/tcp': procTable('00000000:1435', '0100007F:1F90'),
        '/proc/net/tcp6': procTable('00000000000000000000000000000000:1435'),
      },
    });

    expect(result).toEqual({
      ok: true,
      servers: [
        { port: 5173, pid: 10, command: 'node', url: 'http://localhost:5173/' },
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
