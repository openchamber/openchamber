import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { configureOpenCodeCredentials } from './auth.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createApp = (getProviderSources) => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    resolveProjectDirectory: vi.fn(async () => ({ directory: '/projects/app' })),
    getProviderSources,
  });
  return app;
};

describe('provider writes in enterprise mode', () => {
  const writes = (agent) => [
    agent.post('/api/integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration/anthropic/connect/oauth').send({ methodID: 'claude-pro' }),
    agent.post('/api/integration/anthropic/connect/oauth/att_1/complete').send({ code: 'x' }),
    agent.post('/api/integration/github-copilot/connect/command').send({ methodID: 'cli' }),
    agent.post('/api/experimental/integration/wellknown').send({ url: 'https://example.test' }),
    agent.put('/api/provider').send({ providerID: 'company-ai', config: {}, scope: 'user' }),
    // OpenCode routes these to the key handler too.
    agent.post('/API/integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api//integration/openai/connect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration/openai/%63onnect/key').send({ key: 'sk-test' }),
    agent.post('/api/integration\\openai\\connect\\key').send({ key: 'sk-test' }),
    agent.post('/api/experimental/integration/wellknown;x').send({ url: 'https://example.test' }),
    agent.post('/api/credential').send({ integrationID: 'openai', value: { type: 'key', key: 'sk-test' } }),
    agent.post('/API//credential').send({ integrationID: 'openai', value: { type: 'key', key: 'sk-test' } }),
  ];

  it('refuses connecting a provider, adding a key, or creating a custom provider', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const agent = request(createApp(vi.fn()));
      for (const response of await Promise.all(writes(agent))) {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('enterprise_mode');
      }
      const discovery = await agent.post('/api/provider/discover-models').send({ baseURL: 'https://example.test/v1' });
      expect(discovery.status).toBe(403);
      expect(discovery.body.code).toBe('enterprise_mode');
      // Removing an account only narrows access and still reaches OpenCode.
      expect((await agent.delete('/api/credential/cred_1')).status).toBe(404);
      expect((await agent.post('/api/credential/cred_1/activate')).status).toBe(404);
      // Signing in to a remote MCP server reaches a tool server, not a model provider.
      const mcpSignIn = [
        agent.post('/api/integration/mcp_0123456789abcdef/connect/oauth').send({ methodID: 'mcp_0123456789abcdef' }),
        agent.post('/api/integration/mcp_0123456789abcdef/connect/oauth/att_1/complete').send({ code: 'x' }),
      ];
      for (const response of await Promise.all(mcpSignIn)) {
        expect(response.status).toBe(404);
      }
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('passes the OpenCode writes on to the proxy otherwise', async () => {
    const connect = await request(createApp(vi.fn())).post('/api/integration/openai/connect/key').send({ key: 'sk-test' });
    // No proxy in this app: falling through reads as Express's 404.
    expect(connect.status).toBe(404);
  });
});

describe('the stored credential list', () => {
  const reads = (agent) => [
    agent.get('/api/credential'),
    agent.get('/API//credential/'),
    agent.get('/api/%63redential'),
    agent.head('/api/credential'),
  ];

  it('never reaches a client, with or without enterprise mode', async () => {
    const agent = request(createApp(vi.fn()));
    for (const response of await Promise.all(reads(agent))) {
      expect(response.status).toBe(403);
    }
    expect((await agent.get('/api/credential')).body.code).toBe('credential_list_refused');

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      for (const response of await Promise.all(reads(agent))) {
        expect(response.status).toBe(403);
      }
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('does not refuse renaming an account', async () => {
    // No proxy in this app: falling through reads as Express's 404.
    expect((await request(createApp(vi.fn())).patch('/api/credential/cred_1').send({ label: 'work' })).status).toBe(404);
  });
});

describe('GET /api/provider/:providerId/source', () => {
  // The auth source reads OpenCode's stored credentials; this one has none.
  beforeEach(() => configureOpenCodeCredentials({ list: async () => [] }));
  afterEach(() => configureOpenCodeCredentials(null));

  it('returns the stored config entry next to the layer sources', async () => {
    const stored = {
      name: 'Stored',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['STORED_KEY'],
      settings: { baseURL: 'https://stored.example.com/v1' },
      models: { m: { modelID: 'm', name: 'M' } },
    };
    const getProviderSources = vi.fn(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: false, path: '/user.json' },
        project: { exists: true, path: '/projects/app/opencode.json' },
        custom: { exists: false, path: null },
      },
      config: stored,
    }));

    const response = await request(createApp(getProviderSources))
      .get('/api/provider/stored-llm/source?directory=/projects/app')
      .expect(200);

    expect(getProviderSources).toHaveBeenCalledWith('stored-llm', '/projects/app');
    expect(response.body.config).toEqual(stored);
    expect(response.body.sources.project.exists).toBe(true);
  });

  it('returns null config when no layer defines the provider', async () => {
    const response = await request(createApp(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: false, path: '/user.json' },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
      },
      config: null,
    })))
      .get('/api/provider/other/source')
      .expect(200);

    expect(response.body.config).toBeNull();
  });
});

describe('POST /api/provider/discover-models', () => {
  it('uses the stored provider key without returning it to the browser', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer replacement-secret');
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 });
    });
    const app = express();
    app.use(express.json());
    registerOpenCodeRoutes(app, {
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/projects/app' })),
      getProviderSources: vi.fn(),
    });

    // With no credential source configured the route's credential-store read
    // fails and discovery falls back to the key in the form; the stored-config
    // fallback has its own describe below, and env resolution in stored keys
    // is covered in model-discovery.test.js. This keeps the route contract:
    // provider id enters, no credential leaves in the response.
    const response = await request(app)
      .post('/api/provider/discover-models')
      .send({ providerID: 'stored-llm', baseURL: 'https://provider.test', apiKey: 'replacement-secret', enrich: false })
      .expect(200);
    expect(response.body).toEqual({
      models: [{ id: 'model-a', name: 'model-a' }],
      enrichment: { requested: false, available: false },
    });
    expect(JSON.stringify(response.body)).not.toContain('replacement-secret');
  });
});

describe('POST /api/provider/discover-models stored-config fallback', () => {
  // The route reads the stored entry from the merged config layers. Point
  // OPENCODE_CONFIG (resolved on every read) at a temp fixture so the entry
  // is exactly what a provider form save writes: the v2 `providers` shape.
  let root;
  let previousOpenCodeConfig;

  const serveModels = () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 });
    });
    return requests;
  };

  const writeStoredProvider = (providerID, entry) => {
    const configPath = path.join(root, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { [providerID]: entry } }), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
  };

  const discover = (body) => {
    const app = express();
    app.use(express.json());
    registerOpenCodeRoutes(app, {
      resolveProjectDirectory: vi.fn(async () => ({ directory: '/projects/app' })),
      getProviderSources: vi.fn(),
    });
    return request(app).post('/api/provider/discover-models').send(body);
  };

  beforeEach(() => {
    // The credential store is reachable but empty: the fallback must come
    // from the stored config entry.
    configureOpenCodeCredentials({ list: async () => [] });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-discovery-'));
    previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
  });

  afterEach(() => {
    configureOpenCodeCredentials(null);
    if (previousOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends the first env variable that is set, not just the first name', async () => {
    const providerID = `env-order-${Date.now()}`;
    process.env.OPENCHAMBER_DISCOVERY_SECOND = 'second-secret';
    delete process.env.OPENCHAMBER_DISCOVERY_FIRST;
    writeStoredProvider(providerID, {
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['OPENCHAMBER_DISCOVERY_FIRST', 'OPENCHAMBER_DISCOVERY_SECOND'],
      settings: { baseURL: 'https://stored.test/v1' },
    });
    const requests = serveModels();
    try {
      const response = await discover({ providerID, baseURL: 'https://stored.test/v1', enrich: false }).expect(200);
      expect(requests).toEqual(['Bearer second-secret']);
      expect(JSON.stringify(response.body)).not.toContain('second-secret');
    } finally {
      delete process.env.OPENCHAMBER_DISCOVERY_SECOND;
    }
  });

  it('falls back to settings.apiKey when the credential store has none', async () => {
    const providerID = `settings-key-${Date.now()}`;
    writeStoredProvider(providerID, { settings: { baseURL: 'https://stored.test/v1', apiKey: 'config-secret' } });
    const requests = serveModels();
    const response = await discover({ providerID, baseURL: 'https://stored.test/v1', enrich: false }).expect(200);
    expect(requests).toEqual(['Bearer config-secret']);
    expect(JSON.stringify(response.body)).not.toContain('config-secret');
  });

  it('prefers the credential store key and keeps the stored base URL guard', async () => {
    const providerID = `store-wins-${Date.now()}`;
    configureOpenCodeCredentials({
      list: async () => [{ integrationID: providerID, active: true, value: { type: 'key', key: 'store-secret' } }],
    });
    writeStoredProvider(providerID, { settings: { baseURL: 'https://stored.test/v1', apiKey: 'config-secret' } });
    const requests = serveModels();
    // Before the v2 config read, storedBaseURL was always undefined and the
    // endpoint guard discarded even the credential-store key.
    await discover({ providerID, baseURL: 'https://stored.test/v1', enrich: false }).expect(200);
    expect(requests).toEqual(['Bearer store-secret']);

    // A form base URL that moved away from the stored one receives no key.
    requests.length = 0;
    await discover({ providerID, baseURL: 'https://moved.test/v1', enrich: false }).expect(200);
    expect(requests).toEqual([undefined]);
  });
});

describe('Git initialization through the proxy', () => {
  it('refuses home, a disk root, and a request without a directory', async () => {
    const agent = request(createApp(vi.fn()));
    const os = await import('node:os');
    const refused = [
      agent.post('/api/vcs/init').set('x-opencode-directory', encodeURIComponent(os.homedir())),
      agent.post('/api/vcs/init').set('x-opencode-directory', encodeURIComponent('/')),
      agent.post('/API//vcs/init;x').set('x-opencode-directory', encodeURIComponent(os.homedir())),
      agent.post(`/api/vcs/init?location%5Bdirectory%5D=${encodeURIComponent(os.homedir())}`),
      agent.post('/api/vcs/init'),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(400);
      expect(response.body._tag).toBe('InvalidRequestError');
    }
  });

  it('passes a project directory on to the proxy', async () => {
    const response = await request(createApp(vi.fn()))
      .post('/api/vcs/init')
      .set('x-opencode-directory', encodeURIComponent('/tmp/some-project'));
    // No proxy in this app: falling through reads as Express's 404.
    expect(response.status).toBe(404);
  });
});
