import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { OpenChamberControlError } from '../openchamber-control/error.js';
import { registerWorkflowRoutes } from './routes.js';

const setup = (runtime) => {
  const app = express();
  registerWorkflowRoutes(app, runtime);
  return request(app);
};

describe('workflow routes', () => {
  it.each(['approve', 'decline', 'stop', 'resume'])('dispatches %s to the runtime', async (action) => {
    const run = { runId: 'wf_test' };
    const perform = vi.fn().mockResolvedValue(run);
    const response = await setup({ [action]: perform }).post(`/api/openchamber/workflows/wf_test/${action}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(run);
    expect(perform).toHaveBeenCalledExactlyOnceWith(run);
  });

  it.each(['constructor', 'toString', '__proto__', 'unknown'])('rejects the action %s', async (action) => {
    const response = await setup({}).post(`/api/openchamber/workflows/wf_test/${action}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: `Unknown workflow action: ${action}` });
  });

  it('keeps session queries ahead of directory queries and supports repeated directories', async () => {
    const runtime = { list: vi.fn().mockResolvedValue([]), listByDirectory: vi.fn().mockResolvedValue([]) };
    const api = setup(runtime);
    expect((await api.get('/api/openchamber/workflows?sessionId=parent&directory=repo')).body).toEqual({ runs: [] });
    expect(runtime.list).toHaveBeenCalledExactlyOnceWith({ sessionId: 'parent' });
    expect(runtime.listByDirectory).not.toHaveBeenCalled();
    expect((await api.get('/api/openchamber/workflows?directory=repo&directory=worktree')).status).toBe(200);
    expect(runtime.listByDirectory).toHaveBeenCalledExactlyOnceWith({ directories: ['repo', 'worktree'] });
    expect((await api.get('/api/openchamber/workflows')).status).toBe(400);
  });

  it('passes the parsed saved-workflow body through unchanged', async () => {
    const startSaved = vi.fn().mockResolvedValue({ runId: 'wf_test' });
    const api = setup({ startSaved });
    const body = { directory: ' repo ', name: ' task ', sessionId: null, args: [1, null] };
    expect((await api.post('/api/openchamber/workflows/start').send(body)).status).toBe(200);
    expect(startSaved).toHaveBeenCalledExactlyOnceWith({ directory: 'repo', name: 'task', sessionId: null, args: [1, null] });
    expect((await api.post('/api/openchamber/workflows/start').send({ directory: 'repo' })).status).toBe(400);
    expect(startSaved).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['get', '/api/openchamber/workflows/saved?directory=repo', 'listSaved', { directory: 'repo' }],
    ['get', '/api/openchamber/workflows/wf_test', 'detail', { runId: 'wf_test' }],
    ['get', '/api/openchamber/workflows/wf_test/agents/agent', 'agentDetail', { runId: 'wf_test', key: 'agent' }],
    ['delete', '/api/openchamber/workflows/wf_test', 'remove', { runId: 'wf_test' }],
  ])('dispatches %s %s', async (method, route, name, input) => {
    const perform = vi.fn().mockResolvedValue({ result: 'ok' });
    const response = await setup({ [name]: perform })[method](route);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'ok' });
    expect(perform).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('preserves runtime error statuses and messages', async () => {
    const approve = vi.fn().mockRejectedValue(new OpenChamberControlError('No such run', 404));
    const response = await setup({ approve }).post('/api/openchamber/workflows/wf_test/approve');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'No such run' });
  });
});
