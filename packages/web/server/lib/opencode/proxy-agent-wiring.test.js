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

const createStubDeps = () => ({
  fs: { promises: { realpath: async (value) => value } },
  os: {},
  path: {},
  OPEN_CODE_READY_GRACE_MS: 0,
  LONG_REQUEST_TIMEOUT_MS: 1_000,
  getRuntime: () => ({ openCodePort: 49303 }),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:49303${pathname}`,
  ensureOpenCodeApiPrefix: (pathname) => pathname,
});

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

    const agents = createProxyMiddlewareMock.mock.calls.map(([options]) => options.agent);

    expect(agents.length).toBeGreaterThan(1);
    expect(agents.every(Boolean)).toBe(true);
    expect(new Set(agents).size).toBe(1);
  });
});
