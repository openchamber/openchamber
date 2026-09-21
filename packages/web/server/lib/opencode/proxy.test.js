import http from 'node:http';
import https from 'node:https';

import { createProxyMiddleware } from 'http-proxy-middleware';
import { describe, expect, it } from 'vitest';

import {
  createDirectoryQueryCanonicalizer,
  createOpenCodeProxyAgent,
  normalizeForwardedDirectoryHeaders,
} from './proxy.js';

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
    await Promise.resolve();

    expect(calls).toBe(1);
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
  it('decodes marked directory headers before forwarding to OpenCode', () => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': encodeURIComponent('/Users/example/project'),
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      'x-opencode-directory': '/Users/example/project',
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
  });

  it('returns a plain http agent for http targets', () => {
    const agent = createOpenCodeProxyAgent('http://127.0.0.1:4096');

    // https.Agent extends http.Agent, so the negative assertion is the load-bearing one.
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent).not.toBeInstanceOf(https.Agent);
    expect(agent.options.keepAlive).toBe(true);
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
