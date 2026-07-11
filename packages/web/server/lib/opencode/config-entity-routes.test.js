import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerConfigEntityRoutes } from './config-entity-routes.js';

const createDependencies = (getCommandSources) => ({
  resolveProjectDirectory: async () => ({ directory: '/repo' }),
  resolveOptionalProjectDirectory: async () => ({ directory: '/repo' }),
  refreshOpenCodeAfterConfigChange: vi.fn(async () => ({})),
  clientReloadDelayMs: 0,
  getAgentSources: vi.fn(),
  getAgentConfig: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getCommandSources,
  createCommand: vi.fn(),
  updateCommand: vi.fn(),
  deleteCommand: vi.fn(),
  listMcpConfigs: vi.fn(),
  getMcpConfig: vi.fn(),
  createMcpConfig: vi.fn(),
  updateMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
  listSnippets: vi.fn(),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  expandSnippets: vi.fn(),
});

describe('config entity command metadata route', () => {
  it('returns metadata for many commands through one request', async () => {
    const app = express();
    app.use(express.json());
    const getCommandSources = vi.fn((name) => ({
      md: { exists: name === 'project-command', scope: name === 'project-command' ? 'project' : null },
      json: { exists: name === 'user-command', scope: name === 'user-command' ? 'user' : null },
    }));
    registerConfigEntityRoutes(app, createDependencies(getCommandSources));

    const response = await request(app)
      .post('/api/config/commands/metadata?directory=%2Frepo')
      .send({ names: ['project-command', 'user-command', 'built-in', 'project-command'] })
      .expect(200);

    expect(getCommandSources).toHaveBeenCalledTimes(3);
    expect(response.body).toEqual({
      commands: {
        'project-command': { scope: 'project', isBuiltIn: false },
        'user-command': { scope: 'user', isBuiltIn: false },
        'built-in': { scope: null, isBuiltIn: true },
      },
    });
  });
});
