import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { createDevServerScanner, MAX_SCAN_OUTPUT_BYTES } from './routes.js';

const makeChild = (drive) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.drive = () => drive(child);
  return child;
};

const spawnReturning = (child) => () => {
  queueMicrotask(() => child.drive());
  return child;
};

const emitChunks = (child, chunks, code = 0) => {
  for (const chunk of chunks) child.stdout.emit('data', chunk);
  child.emit('close', code);
};

const noProcTables = async () => null;

describe('dev-server scanner output cap (#1081)', () => {
  test('kills an over-cap netstat stream and reports failure instead of parsing it', async () => {
    const chunk = 'x'.repeat(3 * 1024 * 1024);
    const child = makeChild((c) => emitChunks(c, [chunk, chunk]));
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'win32', readFile: noProcTables });

    const result = await scanner.discover();

    expect(result).toEqual({ ok: false, reason: 'netstat-unavailable' });
    expect(child.killed).toBe(true);
  });

  test('falls back to /proc when the lsof stream overflows', async () => {
    const chunk = 'x'.repeat(3 * 1024 * 1024);
    const child = makeChild((c) => emitChunks(c, [chunk, chunk]));
    const procTable = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000 100 0',
    ].join('\n');
    const readFile = async (path) => (path.endsWith('tcp6') ? null : procTable);
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'linux', readFile });

    const result = await scanner.discover();

    expect(child.killed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.servers).toEqual([{ port: 3000, pid: null, command: '', url: 'http://localhost:3000/' }]);
  });

  test('parses output at exactly the cap', async () => {
    const head = 'p1234\nc';
    const tail = '\nn*:5173\n';
    const filler = 'x'.repeat(MAX_SCAN_OUTPUT_BYTES - head.length - tail.length);
    const output = head + filler + tail;
    expect(output.length).toBe(MAX_SCAN_OUTPUT_BYTES);
    const half = Math.floor(output.length / 2);
    const child = makeChild((c) => emitChunks(c, [output.slice(0, half), output.slice(half)]));
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'linux', readFile: noProcTables });

    const result = await scanner.discover();

    expect(result.ok).toBe(true);
    expect(result.servers.map((entry) => entry.port)).toEqual([5173]);
  });

  test('keeps a multi-byte character split across chunks intact (#1691)', async () => {
    const output = Buffer.from('p1234\ncdev€server\nn*:5173\n', 'utf8');
    const split = output.indexOf(Buffer.from('€', 'utf8')) + 1;
    const child = makeChild((c) => emitChunks(c, [output.subarray(0, split), output.subarray(split)]));
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'linux', readFile: noProcTables });

    const result = await scanner.discover();

    expect(result.ok).toBe(true);
    expect(result.servers.map((entry) => entry.command)).toEqual(['dev€server']);
  });

  test('judges the cap in bytes, not characters (#1691)', async () => {
    const command = '€'.repeat(1_500_000);
    const output = Buffer.from(`p1234\nc${command}\nn*:5173\n`, 'utf8');
    expect(output.toString('utf8').length).toBeLessThan(MAX_SCAN_OUTPUT_BYTES);
    expect(output.length).toBeGreaterThan(MAX_SCAN_OUTPUT_BYTES);
    const child = makeChild((c) => emitChunks(c, [output]));
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'win32', readFile: noProcTables });

    const result = await scanner.discover();

    expect(result).toEqual({ ok: false, reason: 'netstat-unavailable' });
    expect(child.killed).toBe(true);
  });

  test('resolves a hung scan as failure after the timeout', async () => {
    const child = makeChild(() => {});
    const scanner = createDevServerScanner({ spawn: spawnReturning(child), platform: 'linux', readFile: noProcTables });

    const result = await scanner.discover();

    expect(result).toEqual({ ok: false, reason: 'no-listener-source' });
    expect(child.killed).toBe(true);
  }, 10_000);
});
