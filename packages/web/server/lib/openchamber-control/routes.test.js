import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createAgentToolRuntime } from '../agent-tool/runtime.js';
import { BrowserControlError } from '../browser-control/broker.js';
import { OpenChamberControlError } from './error.js';
import { registerOpenChamberControlRoutes } from './routes.js';
import { createTerminalReadAction } from './terminal-read.js';

const createApp = (execute, answerPage = vi.fn()) => {
  const app = express();
  registerOpenChamberControlRoutes(app, { controlService: { execute, answerPage } });
  return app;
};

describe('OpenChamber control route', () => {
  it('is a thin adapter over the control service', async () => {
    const execute = vi.fn(async () => ({ projects: [] }));
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'projects.list', input: {}, contextDirectory: '/repo' })
      .expect(200);
    expect(response.body).toEqual({ projects: [] });
    expect(execute).toHaveBeenCalledWith('projects.list', {}, '/repo', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves service status and partial-result details', async () => {
    const execute = vi.fn(async () => {
      throw new OpenChamberControlError('dispatch failed', 500, {
        partial: true,
        partialAction: 'fork-created',
        sessionId: 'ses_fork',
        directory: '/repo',
      });
    });
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'session.fork', input: {} })
      .expect(500);
    expect(response.body).toEqual({
      error: 'dispatch failed',
      partial: true,
      partialAction: 'fork-created',
      sessionId: 'ses_fork',
      directory: '/repo',
    });
  });

  it('keeps the status of a browser refusal instead of reporting 500', async () => {
    const execute = vi.fn(async () => {
      throw new BrowserControlError('The user is interacting with this page in the panel right now.', 409);
    });
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'browser.click', input: {} })
      .expect(409);
    expect(response.body).toEqual({ error: 'The user is interacting with this page in the panel right now.' });
  });
});

describe('terminal output', () => {
  const terminalRuntime = {
    listTerminals: () => [{ sessionId: 'term-1', cwd: '/repo', status: 'running', createdAt: 1, mode: 'interactive', purpose: 'shell' }],
    readTerminal: () => ({ sessionId: 'term-1', cwd: '/repo', status: 'running', text: 'marker-7f3a\n', truncated: false, retainedBytes: 12 }),
  };
  // The control service's terminal path with the setting turned on.
  const readTerminal = createTerminalReadAction({
    readSettings: async () => ({ agentTerminalToolEnabled: true }),
    getTerminalRuntime: () => terminalRuntime,
  });
  const execute = vi.fn(async (action, input, directory) => readTerminal(action, input, directory));

  it('is refused on the control route even with the setting on', async () => {
    const app = createApp(execute);
    for (const action of ['terminal.list', 'terminal.read']) {
      const response = await request(app)
        .post('/api/openchamber/control')
        .send({ action, input: { sessionId: 'term-1' }, contextDirectory: '/repo' })
        .expect(403);
      expect(JSON.stringify(response.body)).not.toContain('marker-7f3a');
      expect(JSON.stringify(response.body)).not.toContain('term-1');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('still reaches an agent through the authenticated managed-tool callback', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-control-routes-'));
    try {
      const agentTool = createAgentToolRuntime({ crypto, fsPromises: fs, path, instanceDir: dataDir, getActivePort: () => 3901, executeAction: execute });
      await agentTool.materializePlugin({ includeTerminal: true });
      const token = agentTool.createChildEnv().OPENCHAMBER_AGENT_TOOL_TOKEN;
      const app = createApp(execute);
      agentTool.registerRoutes(app, express);

      const call = (authorization) => request(app)
        .post('/api/openchamber/agent-tool')
        .set('authorization', authorization)
        .send({ tool: 'openchamber_terminal', input: { action: 'terminal.read', sessionId: 'term-1' }, contextDirectory: '/repo' });

      await call('Bearer wrong').expect(401);
      const response = await call(`Bearer ${token}`).expect(200);
      expect(response.body).toMatchObject({ ok: true, action: 'terminal.read' });
      expect(JSON.stringify(response.body)).toContain('marker-7f3a');
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('page answer route', () => {
  it('hands the answer to the waiting call', async () => {
    const answerPage = vi.fn(() => ({ answered: true }));
    const body = { sessionId: 'ses_1', callId: 'call_1', summary: 'Layout B', data: { layout: 'b' } };
    const response = await request(createApp(vi.fn(), answerPage))
      .post('/api/openchamber/render/answer')
      .send(body)
      .expect(200);
    expect(response.body).toEqual({ answered: true });
    expect(answerPage).toHaveBeenCalledWith(body);
  });

  it('reports a page that no longer waits as an error, never as success', async () => {
    const answerPage = vi.fn(() => {
      throw new OpenChamberControlError('This page is no longer waiting for an answer', 404);
    });
    const response = await request(createApp(vi.fn(), answerPage))
      .post('/api/openchamber/render/answer')
      .send({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' })
      .expect(404);
    expect(response.body).toEqual({ error: 'This page is no longer waiting for an answer' });
  });
});
