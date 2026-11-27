import http from 'node:http';
import https from 'node:https';

import { createProxyMiddleware } from 'http-proxy-middleware';
import { describe, expect, it } from 'vitest';

import {
  createOpenCodeProxyAgent,
  normalizeForwardedDirectoryHeaders,
  sanitizeSessionListItem,
} from './proxy.js';
import {
  canonicalizeCreateBodyDirectory,
  canonicalizeMoveBodyDirectory,
  createDirectoryQueryCanonicalizer,
  createSessionDirectoryCanonicalizer,
  relocateSessionsFromDriveTargets,
} from './directory-canonicalization.js';

describe('createDirectoryQueryCanonicalizer', () => {
  it('canonicalizes directory query params and preserves other params', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async (value) => value === '/link/project' ? '/real/project' : value,
    });

    await expect(canonicalize('/session?foo=1&directory=/link/project&bar=2'))
      .resolves.toBe('/session?foo=1&directory=%2Freal%2Fproject&bar=2');
  });

  it('caches directory realpath lookups', async () => {
    let calls = 0;
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return '/real/project';
      },
    });

    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent directory realpath lookups', async () => {
    let calls = 0;
    let release = () => undefined;
    const pending = new Promise((resolve) => {
      release = () => resolve('/real/project');
    });
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return pending;
      },
    });

    const first = canonicalize('/session?directory=/link/project');
    const second = canonicalize('/session?directory=/link/project');
    await expect.poll(() => calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      '/session?directory=%2Freal%2Fproject',
      '/session?directory=%2Freal%2Fproject',
    ]);
  });

  it('falls back to the original URL when realpath fails', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        throw new Error('missing');
      },
    });

    await expect(canonicalize('/session?foo=1&directory=/missing/project'))
      .resolves.toBe('/session?foo=1&directory=/missing/project');
  });

  it('leaves URLs without directory params unchanged', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => '/real/project',
    });

    await expect(canonicalize('/session?foo=1')).resolves.toBe('/session?foo=1');
  });
});

describe('normalizeForwardedDirectoryHeaders', () => {
  it.each(['/Users/example/project', '/repo/café', '/repo/\u00FF'])('decodes HTTP-safe marked directory headers for %s', (directory) => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': encodeURIComponent(directory),
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      'x-opencode-directory': directory,
    });
  });

  it.each(['C:/测试项目', '/repo/😀', '/repo/\u0100', '/repo/\r\nvalue', '/repo/\u007F'])('preserves encoded headers that Node cannot forward decoded for %j', (directory) => {
    const encoded = encodeURIComponent(directory);
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': encoded,
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      'x-opencode-directory': encoded,
      'x-opencode-directory-encoding': 'uri',
    });
    expect(() => http.validateHeaderValue('x-opencode-directory', headers['x-opencode-directory'])).not.toThrow();
  });

  it('preserves malformed directory values and removes their marker for the raw fallback', () => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': '/repo/%E6%ZZ',
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      'x-opencode-directory': '/repo/%E6%ZZ',
    });
  });

  it('preserves unmarked percent sequences from direct clients', () => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': '/Users/example/project%20literal',
    });

    expect(headers).toEqual({
      'x-opencode-directory': '/Users/example/project%20literal',
    });
  });
});

const aliasRealpath = async (value) => {
  if (value === '/home/me/work') return '/data/home/me/work';
  if (value === '/missing/work') throw new Error('missing');
  return value;
};
const localCanonicalizer = () => createSessionDirectoryCanonicalizer({ sharesFilesystem: () => true, realpath: aliasRealpath })();

describe('createSessionDirectoryCanonicalizer', () => {
  it('resolves absolute directories while OpenCode shares this filesystem', async () => {
    await expect(localCanonicalizer()('/home/me/work')).resolves.toBe('/data/home/me/work');
  });

  it('gives no canonicalizer while OpenCode runs on another filesystem', () => {
    let shared = false;
    const current = createSessionDirectoryCanonicalizer({ sharesFilesystem: () => shared, realpath: aliasRealpath });
    expect(current()).toBeNull();
    shared = true;
    expect(current()).toBeTypeOf('function');
  });

  it('keeps relative, home-relative and unresolvable directories as they were sent', async () => {
    const canonicalize = localCanonicalizer();
    await expect(canonicalize('~/work')).resolves.toBe('~/work');
    await expect(canonicalize('work')).resolves.toBe('work');
    await expect(canonicalize('/missing/work')).resolves.toBe('/missing/work');
  });

  it('resolves the exact name, trailing whitespace included', async () => {
    const seen = [];
    const canonicalize = createSessionDirectoryCanonicalizer({
      sharesFilesystem: () => true,
      realpath: async (value) => { seen.push(value); return value; },
    })();
    await expect(canonicalize('/home/me/work ')).resolves.toBe('/home/me/work ');
    expect(seen).toEqual(['/home/me/work ']);
  });
});

describe('relocateSessionsFromDriveTargets', () => {
  const sessionClient = (pages, active = {}) => {
    const moves = [];
    const client = {
      session: {
        list: async ({ cursor }) => pages[cursor ?? 0],
        active: async () => active,
        move: async (input) => { moves.push(input); },
      },
    };
    return { client, moves };
  };
  const relocate = (projects, client, platform = 'win32') => relocateSessionsFromDriveTargets({
    projects,
    client,
    platform,
    resolve: async (value) => value,
    resolveTarget: async (value) => value.replace(/^\/r\//, '/net/share/'),
    checkDirectory: async () => 'available',
  });
  const page = (directories, next = null) => ({
    data: directories.map((directory, index) => ({ id: `${directory}#${index}`, location: { directory } })),
    cursor: { next },
  });

  it('moves sessions stored under a mapped drive network path back under the project, on every page', async () => {
    const { client, moves } = sessionClient([
      page(['/net/share/work/demo', '/elsewhere'], 1),
      page(['/net/share/work/demo/sub']),
    ]);
    await expect(relocate(['/r/work/demo'], client)).resolves.toBe(2);
    expect(moves).toEqual([
      { sessionID: '/net/share/work/demo#0', directory: '/r/work/demo' },
      { sessionID: '/net/share/work/demo/sub#0', directory: '/r/work/demo/sub' },
    ]);
  });

  it('leaves a running session, and one in a project added under its network path, where they are', async () => {
    const running = sessionClient([page(['/net/share/work/demo'])], { '/net/share/work/demo#0': {} });
    await expect(relocate(['/r/work/demo'], running.client)).resolves.toBe(0);
    const unc = sessionClient([page(['/net/share/work/demo/other'])]);
    await expect(relocate(['/r/work/demo', '/net/share/work/demo/other'], unc.client)).resolves.toBe(0);
    expect([...running.moves, ...unc.moves]).toEqual([]);
  });

  it('moves a session under the drive whose network path is the deepest match', async () => {
    const { client, moves } = sessionClient([page(['/net/share/work/demo/x'])]);
    const nested = relocateSessionsFromDriveTargets({
      projects: ['/s', '/r/work/demo'],
      client,
      platform: 'win32',
      resolve: async (value) => value,
      resolveTarget: async (value) => (value === '/s' ? '/net/share' : value.replace(/^\/r\//, '/net/share/')),
      checkDirectory: async () => 'available',
    });
    await expect(nested).resolves.toBe(1);
    expect(moves).toEqual([{ sessionID: '/net/share/work/demo/x#0', directory: '/r/work/demo/x' }]);
  });

  it('does nothing outside Windows', async () => {
    const { client, moves } = sessionClient([page(['/net/share/work/demo'])]);
    await expect(relocate(['/r/work/demo'], client, 'linux')).resolves.toBe(0);
    expect(moves).toEqual([]);
  });
});

describe('canonicalizeMoveBodyDirectory', () => {
  it('rewrites an absolute alias to the path OpenCode should store', async () => {
    await expect(canonicalizeMoveBodyDirectory({ directory: '/home/me/work' }, localCanonicalizer()))
      .resolves.toEqual({ directory: '/data/home/me/work' });
  });

  it('leaves a body without a directory alone', async () => {
    const body = { branch: 'main' };
    await expect(canonicalizeMoveBodyDirectory(body, localCanonicalizer())).resolves.toBe(body);
  });

  it('keeps the original body when the directory does not resolve', async () => {
    const body = { directory: '/missing/work' };
    await expect(canonicalizeMoveBodyDirectory(body, localCanonicalizer())).resolves.toBe(body);
  });
});

describe('canonicalizeCreateBodyDirectory', () => {
  it('rewrites an absolute alias in location.directory', async () => {
    await expect(canonicalizeCreateBodyDirectory({ location: { directory: '/home/me/work' } }, localCanonicalizer(), null))
      .resolves.toEqual({ location: { directory: '/data/home/me/work' } });
  });

  it('keeps a directory inside the chats tree as it was addressed', async () => {
    const body = { location: { directory: '/home/me/chats/2026-11-19/session-a' } };
    await expect(canonicalizeCreateBodyDirectory(body, localCanonicalizer(), '/home/me/chats')).resolves.toBe(body);
  });

  it('keeps relative and home-relative directories as OpenCode reads them', async () => {
    const relative = { location: { directory: 'work' } };
    const home = { location: { directory: '~/work' } };
    await expect(canonicalizeCreateBodyDirectory(home, localCanonicalizer(), null)).resolves.toBe(home);
    await expect(canonicalizeCreateBodyDirectory(relative, localCanonicalizer(), null)).resolves.toBe(relative);
  });

  it('leaves a body without a location alone', async () => {
    const body = { title: 'Untitled' };
    await expect(canonicalizeCreateBodyDirectory(body, localCanonicalizer(), null)).resolves.toBe(body);
  });
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address().port);
  });
});

const closeServer = (server) => new Promise((resolve) => {
  server.close(resolve);
});

const request = (port, agent) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', agent }, (res) => {
    res.resume();
    res.on('end', resolve);
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end();
});

/**
 * Proxies two sequential requests through `createProxyMiddleware` and reports
 * what the upstream server observed for each one.
 */
const proxyTwoRequests = async (proxyAgent) => {
  const seen = [];
  let middleware;
  const upstream = http.createServer((req, res) => {
    seen.push({ connection: req.headers.connection, remotePort: req.socket.remotePort });
    res.end('ok');
  });
  const front = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 502;
      res.end();
    });
  });
  const clientAgent = new http.Agent({ keepAlive: true });

  try {
    const upstreamPort = await listen(upstream);
    middleware = createProxyMiddleware({
      target: `http://127.0.0.1:${upstreamPort}`,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    });

    const frontPort = await listen(front);
    await request(frontPort, clientAgent);
    await request(frontPort, clientAgent);
  } finally {
    clientAgent.destroy();
    proxyAgent?.destroy();
    await closeServer(front);
    await closeServer(upstream);
  }

  return seen;
};

describe('createOpenCodeProxyAgent', () => {
  it('reuses a single upstream socket across sequential proxied requests', async () => {
    const seen = await proxyTwoRequests(createOpenCodeProxyAgent('http://127.0.0.1'));

    expect(seen).toHaveLength(2);
    expect(seen[0].connection).not.toBe('close');
    expect(seen[1].remotePort).toBe(seen[0].remotePort);
  });

  it('without an agent, http-proxy forces Connection: close and a new socket per request', async () => {
    const seen = await proxyTwoRequests(null);

    expect(seen).toHaveLength(2);
    expect(seen[0].connection).toBe('close');
    expect(seen[1].remotePort).not.toBe(seen[0].remotePort);
  });

  // http-proxy dispatches through `https.request` when the target protocol is
  // `https:`, so an http.Agent would open a plaintext socket to a TLS port.
  // External OpenCode servers can be configured over https via OPENCODE_HOST.
  it('returns an https agent for https targets', () => {
    const agent = createOpenCodeProxyAgent('https://opencode.example.com:4096');

    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent.options.keepAlive).toBe(true);
    expect(agent.options.timeout).toBe(4_000);
  });

  it('returns a plain http agent for http targets', () => {
    const agent = createOpenCodeProxyAgent('http://127.0.0.1:4096');

    // https.Agent extends http.Agent, so the negative assertion is the load-bearing one.
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent).not.toBeInstanceOf(https.Agent);
    expect(agent.options.keepAlive).toBe(true);
    expect(agent.options.timeout).toBe(4_000);
  });

  it('falls back to an http agent for missing or unparseable targets', () => {
    expect(createOpenCodeProxyAgent(undefined)).not.toBeInstanceOf(https.Agent);
    expect(createOpenCodeProxyAgent('not a url')).not.toBeInstanceOf(https.Agent);
  });

  // The cold-start fix relies on http-proxy-middleware rebuilding its per-request
  // options via `Object.assign({}, this.proxyOptions)` in prepareProxyRequest,
  // which invokes getters. If that ever changes to a cached or shallow-reference
  // copy, the agent would freeze at its registration-time value and https targets
  // would silently regress — so pin the behavior here against the real library.
  it('http-proxy-middleware re-reads the agent option on every proxied request', async () => {
    let reads = 0;
    let middleware;
    const agent = createOpenCodeProxyAgent('http://127.0.0.1');
    const upstream = http.createServer((_req, res) => res.end('ok'));
    const front = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 502;
        res.end();
      });
    });
    const clientAgent = new http.Agent({ keepAlive: true });

    try {
      const upstreamPort = await listen(upstream);
      middleware = createProxyMiddleware({
        target: `http://127.0.0.1:${upstreamPort}`,
        get agent() {
          reads += 1;
          return agent;
        },
      });

      // Construction itself must not read the getter — otherwise the assertion
      // below could be satisfied without any per-request resolution happening.
      expect(reads).toBe(0);

      const frontPort = await listen(front);
      await request(frontPort, clientAgent);
      expect(reads).toBe(1);

      await request(frontPort, clientAgent);
      expect(reads).toBe(2);
    } finally {
      clientAgent.destroy();
      agent.destroy();
      await closeServer(front);
      await closeServer(upstream);
    }
  });
});

describe('sanitizeSessionListItem', () => {
  it('drops the retired delivered-knowledge signature and keeps the rest of the metadata', () => {
    const session = {
      id: 'ses_1',
      title: 'Old session',
      permissions: [{ permission: 'edit' }],
      metadata: { other: { kept: true }, openchamber: { knowledge_context_delivered: 'mg:a:1|mg:b:2', work: { state: 'done' } } },
    };
    expect(sanitizeSessionListItem(session)).toEqual({
      id: 'ses_1',
      title: 'Old session',
      metadata: { other: { kept: true }, openchamber: { work: { state: 'done' } } },
    });
    expect(session.metadata.openchamber.knowledge_context_delivered).toBe('mg:a:1|mg:b:2');
  });

  it('passes metadata without retired keys through by reference', () => {
    const metadata = { openchamber: { work: { state: 'done' } } };
    expect(sanitizeSessionListItem({ id: 'ses_2', metadata }).metadata).toBe(metadata);
    expect(sanitizeSessionListItem({ id: 'ses_3', metadata: { openchamber: 'odd' } }).metadata).toEqual({ openchamber: 'odd' });
  });
});

