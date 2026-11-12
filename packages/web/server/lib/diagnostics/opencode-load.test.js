import { describe, expect, it, vi } from 'vitest';
import { parseProcessTable, readOpenCodeLoad, summarizeOpenCodeTree } from './opencode-load.js';

// A user with eleven directories open had eleven copies of every local MCP
// server under OpenCode, and the diagnostic export said nothing about it.

const PS = [
  '    1     0   1024 /sbin/launchd',
  '  500     1 204800 /Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode',
  '  510   500  10240 /bin/bash',
  '  511   510 102400 /usr/bin/python3',
  '  520   500  51200 node',
  '  600     1  99999 /usr/bin/unrelated',
  'garbage line',
].join('\n');

describe('summarizeOpenCodeTree', () => {
  it('counts every process under OpenCode, grandchildren included', () => {
    expect(summarizeOpenCodeTree(parseProcessTable(PS), 500)).toEqual({ openCodeMb: 200, childProcesses: 3, childMb: 160 });
  });

  it('says nothing when the pid is not an OpenCode process here', () => {
    const table = parseProcessTable(PS);
    expect(summarizeOpenCodeTree(table, 600)).toBeNull();
    expect(summarizeOpenCodeTree(table, 999)).toBeNull();
  });
});

describe('readOpenCodeLoad', () => {
  const answer = (routes) => vi.fn(async (url) => {
    const route = new URL(url).pathname;
    if (!(route in routes)) return { ok: false, status: 500, json: async () => null };
    return { ok: true, status: 200, json: async () => routes[route] };
  });
  const deps = (fetchImpl, extra = {}) => ({
    buildOpenCodeUrl: (route) => `http://127.0.0.1:4096${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic x' }),
    fetchImpl,
    listProcesses: async () => PS,
    platform: 'darwin',
    ...extra,
  });

  it('reports loaded directories and the process tree without paths', async () => {
    const fetchImpl = answer({ '/api/debug/location': [{ directory: '/a' }, { directory: '/b' }], '/api/info': { pid: 500 } });
    const load = await readOpenCodeLoad(deps(fetchImpl));
    expect(load).toEqual({ locations: 2, processes: { openCodeMb: 200, childProcesses: 3, childMb: 160 } });
    expect(JSON.stringify(load)).not.toContain('/a');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Basic x' });
  });

  it('keeps the directory count when processes cannot be counted', async () => {
    const fetchImpl = answer({ '/api/debug/location': [{ directory: '/a' }], '/api/info': { pid: 500 } });
    expect(await readOpenCodeLoad(deps(fetchImpl, { platform: 'win32' }))).toEqual({ locations: 1, processes: null });
    expect(await readOpenCodeLoad(deps(fetchImpl, { listProcesses: async () => { throw new Error('ps'); } }))).toEqual({ locations: 1, processes: null });
  });

  it('a failed OpenCode read is unknown, not zero', async () => {
    const load = await readOpenCodeLoad(deps(answer({ '/api/info': { pid: 500 } })));
    expect(load.locations).toBeNull();
    expect(load.processes).toEqual({ openCodeMb: 200, childProcesses: 3, childMb: 160 });
  });
});
