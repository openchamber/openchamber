import { describe, expect, mock, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createPiHarnessState } from './state.js';
import { registerPiHarnessRoutes } from './routes.js';

function createApp({ client, state = createPiHarnessState({ providerID: 'p', modelID: 'm' }) }) {
  const app = express();
  app.use(express.json());
  registerPiHarnessRoutes(app, {
    client,
    state,
    config: { providerID: 'p', modelID: 'm', workspaceRoot: '/workspace' },
    readSettings: async () => ({
      projects: [{ id: 'proj', path: '/repo', name: 'Repo' }],
      lastDirectory: '/repo',
    }),
  });
  return { app, state };
}

describe('Pi-Harness bootstrap routes', () => {
  test('returns directory from path', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app).get('/path').expect(200);
    expect(response.body.directory).toBe('/repo');
  });

  test('returns empty global config', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app).get('/global/config').expect(200);
    expect(response.body).toEqual({});
  });

  test('returns provider list with Pi defaults', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app).get('/provider').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0].id).toBe('p');
  });

  test('returns config/providers', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app).get('/config/providers').expect(200);
    expect(response.body.default).toEqual({ p: 'm' });
  });

  test('returns projects from settings', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app).get('/project').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0].id).toBe('proj');
  });

  test('returns empty bootstrap endpoints', async () => {
    const { app } = createApp({ client: {} });
    await request(app).get('/agent').expect(200, []);
    await request(app).get('/skill').expect(200, []);
    await request(app).get('/command').expect(200, []);
    await request(app).get('/question').expect(200, []);
    await request(app).get('/permission').expect(200, []);
    await request(app).get('/mcp').expect(200, {});
    await request(app).get('/lsp').expect(200, {});
    await request(app).get('/vcs').expect(200);
  });
});

describe('Pi-Harness session routes', () => {
  test('lists synthesized sessions', async () => {
    const client = {
      listSessions: mock(async () => ({ sessions: ['s1'] })),
      getSession: mock(async () => ({
        sessionId: 's1',
        createdAt: '2026-06-14T00:00:00.000Z',
        workspaceDir: '/repo',
      })),
    };
    const { app } = createApp({ client });

    const response = await request(app).get('/session').expect(200);
    expect(response.body[0].id).toBe('s1');
    expect(response.body[0].directory).toBe('/repo');
  });

  test('creates a Pi session with requested directory', async () => {
    const client = { createSession: mock(async () => ({ sessionId: 's2' })) };
    const { app } = createApp({ client });

    const response = await request(app)
      .post('/session')
      .send({ title: 'New', directory: '/repo', model: { providerID: 'p', modelID: 'm' } })
      .expect(201);

    expect(response.body.id).toBe('s2');
    expect(client.createSession.mock.calls[0][0].workspaceDir).toBe('/repo');
  });

  test('returns status and messages from projection state', async () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    state.addUserMessage({ sessionID: 's1', messageID: 'u1', text: 'hello' });
    const { app } = createApp({ client: {}, state });

    const status = await request(app).get('/session/status').expect(200);
    expect(status.body).toEqual({ s1: { type: 'idle' } });

    const messages = await request(app).get('/session/s1/message').expect(200);
    expect(messages.body[0].info.id).toBe('u1');
  });

  test('deletes sessions', async () => {
    const client = { deleteSession: mock(async () => true) };
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const { app } = createApp({ client, state });

    await request(app).delete('/session/s1').expect(200);
    expect(state.listSessions()).toHaveLength(0);
  });
});

describe('Pi-Harness prompt and cancel', () => {
  test('starts Pi message stream and broadcasts translated events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: turn_start\ndata: {\"type\":\"turn_start\",\"id\":\"t1\"}\n\n"));
        controller.enqueue(encoder.encode("event: message_start\ndata: {\"type\":\"message_start\",\"id\":\"t1\"}\n\n"));
        controller.enqueue(encoder.encode("event: message_update\ndata: {\"type\":\"message_update\",\"id\":\"t1\",\"text\":\"hi\"}\n\n"));
        controller.enqueue(encoder.encode("event: turn_end\ndata: {\"type\":\"turn_end\",\"id\":\"t1\"}\n\n"));
        controller.close();
      },
    });
    const client = {
      sendMessageStream: mock(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
    };
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const { app } = createApp({ client, state });

    await request(app)
      .post('/session/s1/message')
      .send({ directory: '/repo', parts: [{ type: 'text', text: 'hello' }], messageID: 'u1' })
      .expect(200);

    // Wait for async stream consumption
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.sendMessageStream.mock.calls[0][1]).toEqual({ content: 'hello' });
    const msgs = state.getMessages('s1');
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const assistant = msgs.find((m) => m.info.role === 'assistant');
    expect(assistant.parts[0].text).toBe('hi');
  });

  test('rejects file attachments explicitly in Pi POC mode', async () => {
    const { app } = createApp({ client: {} });
    const response = await request(app)
      .post('/session/s1/message')
      .send({ text: 'some text', parts: [{ type: 'file', url: 'file:///tmp/a.txt', filename: 'a.txt', mime: 'text/plain' }] })
      .expect(400);
    expect(response.body.error).toContain('does not support file attachments');
  });

  test('aborts active stream and calls Pi cancel', async () => {
    const client = { cancelSession: mock(async () => ({ ok: true })) };
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const controller = new AbortController();
    state.setActiveStream('s1', controller);
    const { app } = createApp({ client, state });

    await request(app).post('/session/s1/abort').send({}).expect(200);
    expect(controller.signal.aborted).toBe(true);
    expect(client.cancelSession).toHaveBeenCalledWith('s1');
  });
});
