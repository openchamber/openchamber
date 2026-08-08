/**
 * Regression for issue #2132: GET /api/small-model now surfaces
 * `availableProviders` (the union of authenticated + no-auth providers) and
 * `noAuthProviders` (the no-auth subset) so the settings override picker can
 * offer OpenCode zen/free models alongside the authenticated ones.
 */
import { describe, it, expect, mock } from 'bun:test';

const serviceStub = {
  describeSmallModel: async () => ({ providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' }),
  listAuthenticatedProviders: () => ['google'],
  listNoAuthProviders: () => ['opencode'],
  listSelectableProviders: () => ['opencode', 'google'],
};

mock.module('./index.js', () => serviceStub);

const { registerSmallModelRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('registerSmallModelRoutes', () => {
  it('GET /api/small-model includes availableProviders and noAuthProviders in the payload', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerSmallModelRoutes(app, { getSmallModelService: async () => serviceStub });

    const handler = getRoute('GET', '/api/small-model');
    expect(handler).toBeDefined();

    const req = { query: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.availableProviders)).toBe(true);
    expect(res.body.availableProviders).toContain('opencode');
    expect(res.body.availableProviders).toContain('google');
    expect(res.body.noAuthProviders).toEqual(['opencode']);
  });

  it('GET /api/small-model keeps authenticatedProviders for backwards compatibility', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerSmallModelRoutes(app, { getSmallModelService: async () => serviceStub });

    const handler = getRoute('GET', '/api/small-model');
    const req = { query: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.body.authenticatedProviders).toEqual(['google']);
  });
});
