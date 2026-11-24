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

  it('counts the bundled server, which runs as the app executable under this server', () => {
    const table = parseProcessTable([
      '  400     1 307200 /Applications/OpenChamber.app/Contents/MacOS/OpenChamber',
      '  700   400 409600 /Applications/OpenChamber.app/Contents/MacOS/OpenChamber',
      '  710   700   2048 /Applications/OpenChamber.app/Contents/Resources/opencode-server/assets/@opencode/pty-darwin-arm64/bin/opencode-pty',
    ].join('\n'));
    expect(summarizeOpenCodeTree(table, 700, 400)).toEqual({ openCodeMb: 400, childProcesses: 1, childMb: 2 });
    expect(summarizeOpenCodeTree(table, 400, 400)).toBeNull();
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

  it('keeps valid empty locations distinct from malformed external responses', async () => {
    for (const info of [null, {}, { pid: '500' }, { pid: 500.5 }]) {
      const listProcesses = vi.fn(async () => PS);
      const result = await readOpenCodeLoad(deps(answer({
        '/api/debug/location': [], '/api/info': info,
      }), { listProcesses }));
      expect(result).toEqual({ locations: 0, processes: null });
      expect(listProcesses).not.toHaveBeenCalled();
    }
    for (const locations of [null, {}, 'private location']) {
      expect(await readOpenCodeLoad(deps(answer({
        '/api/debug/location': locations, '/api/info': null,
      })))).toEqual({ locations: null, processes: null });
    }
  });

  it('retains the integer-pid acceptance rule without adding a safe-integer limit', async () => {
    const pid = Number.MAX_SAFE_INTEGER + 1;
    const listProcesses = vi.fn(async () => `${pid} 1 2048 opencode`);
    const result = await readOpenCodeLoad(deps(answer({
      '/api/debug/location': [], '/api/info': { pid },
    }), { listProcesses }));
    expect(listProcesses).toHaveBeenCalledTimes(1);
    expect(result.processes).toEqual({ openCodeMb: 2, childProcesses: 0, childMb: 0 });
  });
});
