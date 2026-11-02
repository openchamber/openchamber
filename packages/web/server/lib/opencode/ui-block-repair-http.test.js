import { expect, test } from 'bun:test';
import express from 'express';
import { createUiBlockRepair } from './ui-block-repair.js';
import { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import { registerCommonRequestMiddleware } from './core-routes.js';
import { vi } from 'vitest';

test.each(['none', 'cleanup', 'admission', 'failure'])('HTTP/SDK repair settles cleanup and admission: %s', async (stopAt) => {
  const upstream = express();
  upstream.use(express.json());
  const calls = [];
  let finishWait;
  let waiting;
  let finishAdmission;
  const reachedWait = new Promise((resolve) => { waiting = resolve; });
  upstream.post('/api/session/:id/interrupt', (_req, res) => {
    calls.push('interrupt');
    res.json({ interrupted: true });
  });
  upstream.post('/api/experimental/session/:id/wait', (_req, res) => {
    calls.push('wait');
    finishWait = () => res.status(204).end();
    waiting();
  });
  upstream.post('/api/session/:id/synthetic', (req, res) => {
    calls.push('synthetic');
    expect(req.body).toMatchObject({ resume: true, metadata: { openchamberUiBlockRepair: true },
      text: 'Fix this UI block, then continue the unfinished answer without repeating completed content or tools.\nUndefined names: missing' });
    finishAdmission = () => stopAt === 'failure' ? res.sendStatus(500) : res.json({ data: { id: 'msg_repair' } });
    if (stopAt !== 'admission') finishAdmission();
  });
  const upstreamServer = upstream.listen(0);
  const upstreamUrl = `http://localhost:${upstreamServer.address().port}`;
  const stopGoal = vi.fn();
  const repair = createUiBlockRepair({ clientFor: (directory) => createOpenCodeClient({ baseUrl: upstreamUrl, directory }), onStop: stopGoal });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  repair.registerRoutes(app);
  app.post('/api/session/:id/view', (_req, res) => res.sendStatus(204));
  app.post('/api/session/:id/interrupt', (_req, res) => {
    calls.push('user stop');
    res.json({ stopped: true });
  });
  const server = app.listen(0);
  const url = `http://localhost:${server.address().port}`;
  const source = 'root = Stack([missing])';
  const event = (type, data = {}) => repair.onEvent({ directory: '/project', payload: { type, data: { sessionID: 'ses_test', ...data } } });
  repair.onEvent({ directory: 'global', payload: { type: 'session.execution.started', data: { sessionID: 'ses_test' } } });
  event('session.text.started', { assistantMessageID: 'msg_test', ordinal: 0 });
  event('session.text.delta', { assistantMessageID: 'msg_test', ordinal: 0, delta: `\`\`\`openui-lang\n${source}\n\`\`\`\nStill streaming` });
  try {
    await reachedWait;
    expect(calls).toEqual(['interrupt', 'wait']);
    expect(event('session.execution.interrupted', { reason: 'user' })).toBe(true);
    // Recording that the visible chat was read is not a stop or a new task.
    await fetch(`${url}/api/session/ses_test/view`, { method: 'POST' });
    if (stopAt === 'cleanup') {
      const stop = await fetch(`${url}/api/session/ses_test/interrupt`, { method: 'POST' });
      expect(stop.ok).toBe(true);
      expect(stopGoal).toHaveBeenCalledWith('ses_test', '/project');
    }
    finishWait();
    await vi.waitFor(() => expect(calls).toEqual(['interrupt', 'wait', stopAt === 'cleanup' ? 'user stop' : 'synthetic']));
    if (stopAt === 'failure') await vi.waitFor(() => expect(stopGoal).toHaveBeenCalledWith('ses_test', '/project'));
    if (stopAt === 'admission') {
      const stop = fetch(`${url}/api/session/ses_test/interrupt`, { method: 'POST' });
      await vi.waitFor(() => expect(stopGoal).toHaveBeenCalledWith('ses_test', '/project'));
      expect(calls).not.toContain('user stop');
      finishAdmission();
      expect((await stop).ok).toBe(true);
      expect(calls.at(-1)).toBe('user stop');
    }
  } finally {
    repair.reset();
    server.closeAllConnections();
    upstreamServer.closeAllConnections();
    server.close();
    upstreamServer.close();
  }
});
