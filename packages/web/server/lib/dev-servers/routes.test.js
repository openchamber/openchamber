import { describe, expect, it } from 'vitest';
import { createDevServerScanner } from './routes.js';

const listeners = [
  '0: 0100007F:1435 00000000:0000 0A',
  '1: 0100007F:2406 00000000:0000 0A',
].join('\n');

describe('dev-server discovery exclusions', () => {
  it('reapplies current exclusions to cached listeners without another scan', async () => {
    let privatePorts = [];
    let scans = 0;
    const scanner = createDevServerScanner({
      platform: 'linux',
      spawn: () => { scans += 1; throw new Error('use proc'); },
      readFile: async (path) => path.endsWith('tcp6') ? '' : listeners,
      getPrivatePorts: async () => privatePorts,
    });
    expect((await scanner.discover()).servers.map(({ port }) => port)).toEqual([5173, 9222]);
    privatePorts = [9222];
    expect((await scanner.discover()).servers.map(({ port }) => port)).toEqual([5173]);
    expect((await scanner.discover({ ownPorts: [5173] })).servers).toEqual([]);
    expect(scans).toBe(1);
  });

  it('reads private ports after a pending scan and fails closed if that read fails', async () => {
    let privatePorts = [];
    let fail = false;
    const scanner = createDevServerScanner({
      platform: 'linux',
      spawn: () => { throw new Error('use proc'); },
      readFile: async () => { privatePorts = [9222]; return listeners; },
      getPrivatePorts: async () => {
        if (fail) throw new Error('private listener state unavailable');
        return privatePorts;
      },
    });
    expect((await scanner.discover()).servers.map(({ port }) => port)).toEqual([5173]);
    fail = true;
    await expect(scanner.discover()).rejects.toThrow('private listener state unavailable');
  });
});
