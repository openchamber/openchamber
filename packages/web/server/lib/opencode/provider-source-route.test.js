import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { configureOpenCodeCredentials } from './auth.js';

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
      // Removing or switching an account only narrows access and still reaches OpenCode.
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
