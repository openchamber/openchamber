import http from 'node:http';
import https from 'node:https';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createProxyMiddlewareMock } = vi.hoisted(() => ({
  createProxyMiddlewareMock: vi.fn(),
}));

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: createProxyMiddlewareMock,
}));

const { registerOpenCodeProxy } = await import('./proxy.js');

const createStubApp = () => {
  const settings = new Map();
  const noop = () => {};

  return {
    get: (...args) => (args.length === 1 ? settings.get(args[0]) : undefined),
    set: (key, value) => {
      settings.set(key, value);
    },
    use: noop,
    post: noop,
    put: noop,
    patch: noop,
    delete: noop,
    all: noop,
  };
};

const createStubDeps = ({ baseUrl = 'http://127.0.0.1:49303' } = {}) => ({
  fs: { promises: { realpath: async (value) => value } },
  os: {},
  path: {},
  OPEN_CODE_READY_GRACE_MS: 0,
  LONG_REQUEST_TIMEOUT_MS: 1_000,
  getRuntime: () => ({ openCodePort: 49303, openCodeBaseUrl: baseUrl }),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (pathname) => `${baseUrl}${pathname}`,
  ensureOpenCodeApiPrefix: (pathname) => pathname,
});

const agentsFromCalls = () => createProxyMiddlewareMock.mock.calls.map(([options]) => options.agent);

describe('OpenCode API proxy agent wiring', () => {
  beforeEach(() => {
    createProxyMiddlewareMock.mockReset();
    createProxyMiddlewareMock.mockImplementation(() => (_req, _res, next) => next?.());
  });

  it('constructs every proxy with a keep-alive agent', () => {
    registerOpenCodeProxy(createStubApp(), createStubDeps());

    expect(createProxyMiddlewareMock).toHaveBeenCalled();

    for (const [options] of createProxyMiddlewareMock.mock.calls) {
      // Without an explicit agent, http-proxy falls back to `agent: false`,
      // which forces `Connection: close` and burns one ephemeral port per
      // request. See createOpenCodeProxyAgent in ./proxy.js.
      expect(options.agent).toBeTruthy();
      expect(options.agent.options?.keepAlive).toBe(true);
    }
  });

  it('shares one agent instance across the API and OAuth proxies', () => {
    registerOpenCodeProxy(createStubApp(), createStubDeps());

    const agents = agentsFromCalls();

    expect(agents.length).toBeGreaterThan(1);
    expect(agents.every(Boolean)).toBe(true);
    expect(new Set(agents).size).toBe(1);
  });

  // http-proxy dispatches through `https.request` for https targets, so a plain
  // http.Agent would open plaintext sockets to a TLS port and break every
  // proxied request against an external server configured via OPENCODE_HOST.
  it('derives an https agent when the resolved target is https', () => {
    registerOpenCodeProxy(
      createStubApp(),
      createStubDeps({ baseUrl: 'https://opencode.example.com:443' }),
    );

    const agents = agentsFromCalls();

    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent).toBeInstanceOf(https.Agent);
    }
  });

  it('derives a plain http agent when the resolved target is http', () => {
    registerOpenCodeProxy(createStubApp(), createStubDeps());

    const agents = agentsFromCalls();

    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      // https.Agent extends http.Agent, so the negative assertion is load-bearing.
      expect(agent).toBeInstanceOf(http.Agent);
      expect(agent).not.toBeInstanceOf(https.Agent);
    }
  });
});
