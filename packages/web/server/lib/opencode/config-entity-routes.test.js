import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerConfigEntityRoutes } from './config-entity-routes.js';

const createApp = () => {
  const calls = [];
  const record = (action) => (name) => {
    calls.push({ action, name });
    return {};
  };
  const app = express();
  app.use(express.json());
  registerConfigEntityRoutes(app, {
    resolveProjectDirectory: async () => ({ directory: '/work/project' }),
    resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
    getAgentSources: () => ({ md: { exists: false }, json: { exists: false } }),
    createAgent: record('createAgent'),
    deleteAgent: record('deleteAgent'),
    createCommand: record('createCommand'),
    deleteCommand: record('deleteCommand'),
  });
  return { app, calls };
};

describe('MCP saves from a remote origin', () => {
  const createMcpApp = () => {
    const saved = [];
    const app = express();
    app.use(express.json());
    const record = (name, config) => {
      saved.push({ name, config });
      return {};
    };
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: '/work/project' }),
      resolveOptionalProjectDirectory: async () => ({ directory: '/work/project' }),
      createMcpConfig: record,
      updateMcpConfig: record,
    });
    return { app, saved };
  };

  it.each([
    ['nothing', undefined],
    ['oauth off', false],
    ['an empty block', {}],
    ['a custom redirect with an explicit port', { redirect_uri: 'https://proxy.example.com:8443/cb' }],
    ['a custom origin on the callback path', {
      redirect_uri: 'https://proxy.example.com/api/mcp/oauth/docs/callback',
      callback_port: 19876,
    }],
  ])('stores %s as sent; sign-in prepares the redirect', async (_label, oauth) => {
    const { app, saved } = createMcpApp();
    const body = { type: 'remote', url: 'https://mcp.example.com', oauth };

    await request(app)
      .post('/api/config/mcp/docs')
      .set('Host', 'chamber.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send(body)
      .expect(200);
    await request(app)
      .patch('/api/config/mcp/docs')
      .set('Host', 'chamber.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send(body)
      .expect(200);

    expect(saved.map((entry) => entry.config.oauth)).toEqual([oauth, oauth]);
  });
});

describe('config entity names', () => {
  it.each([
    ['post', '/api/config/agents/..%2F..%2Fescape'],
    ['delete', '/api/config/agents/%2Ftmp%2Fescape'],
    ['post', '/api/config/commands/group%2F..%2F..%2Fescape'],
    ['delete', '/api/config/commands/..%5Cescape'],
  ])('refuses %s %s before it reaches the filesystem', async (method, url) => {
    const { app, calls } = createApp();
    const response = await request(app)[method](url).send({});
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts plain and nested names', async () => {
    const { app, calls } = createApp();
    expect((await request(app).post('/api/config/agents/reviewer').send({})).status).toBe(200);
    expect((await request(app).post('/api/config/commands/git%2Fcommit').send({})).status).toBe(200);
    expect(calls).toEqual([
      { action: 'createAgent', name: 'reviewer' },
      { action: 'createCommand', name: 'git/commit' },
    ]);
  });
});
