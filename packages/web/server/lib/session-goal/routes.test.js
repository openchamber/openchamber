import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSessionGoalRoutes } from './routes.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-routes-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OPENCHAMBER_DATA_DIR;
});

const writeGoalSpecMock = vi.fn();

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerSessionGoalRoutes(app, { writeSpec: writeGoalSpecMock });
  return app;
};

describe('POST /api/goals/spec', () => {  beforeEach(() => {
    writeGoalSpecMock.mockReset();
  });

  it('writes a spec from the request and passes only string fields on', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' });

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it', conversation: 'context', openItems: 42, directory: '/repo', providerID: 'openai', modelID: 'gpt-5.5' })
      .expect(200);

    expect(response.body).toEqual({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' });
    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      request: 'Ship it',
      conversation: 'context',
      openItems: undefined,
      directory: '/repo',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes a model, effort and limit choice made for this spec', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: 'spec', providerID: 'google', modelID: 'gemini', variant: 'low' });
    await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it', writerProviderID: 'google', writerModelID: 'gemini', writerVariant: 'low', ignoreLimit: true })
      .expect(200);
    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      writerProviderID: 'google', writerModelID: 'gemini', writerVariant: 'low', ignoreLimit: true,
    }));
  });

  it('passes a per-section rewrite target and the current spec on (#1829)', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: 'spliced', providerID: 'openai', modelID: 'gpt-5.5' });
    await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it', section: 'Requirements', currentSpec: '## Requirements\n1. One', sectionSpec: 9 })
      .expect(200);
    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      section: 'Requirements', currentSpec: '## Requirements\n1. One',
    }));
  });

  it('answers with the writer error status and code', async () => {
    writeGoalSpecMock.mockRejectedValue(Object.assign(new Error('a request is required to write a goal spec'), {
      statusCode: 400,
      code: 'goal-spec-request-required',
    }));

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 7 })
      .expect(400);

    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({ request: undefined }));
    expect(response.body).toEqual({ error: 'a request is required to write a goal spec', code: 'goal-spec-request-required' });
  });

  it('reports an unexpected failure as 500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeGoalSpecMock.mockRejectedValue(new Error('boom'));

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it' })
      .expect(500);

    expect(response.body).toEqual({ error: 'boom' });
    consoleError.mockRestore();
  });
});

describe('goal objective versions (#1830)', () => {
  it('records a version on each changing save, lists them, and reads one back', async () => {
    const app = createApp();
    const sessionId = 'ses_route1';
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'first spec' }).expect(200);
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'second spec' }).expect(200);

    const list = await request(app).get(`/api/goals/objective/${sessionId}/versions`).expect(200);
    expect(list.body.versions).toHaveLength(2);
    // The list carries no text, only id and timestamp.
    expect(Object.keys(list.body.versions[0]).sort()).toEqual(['id', 'savedAt']);

    const newest = list.body.versions[0];
    const one = await request(app).get(`/api/goals/objective/${sessionId}/versions/${newest.id}`).expect(200);
    expect(one.body).toMatchObject({ id: newest.id, content: 'second spec' });
  });

  it('answers the recorded version id, and null when the text is unchanged', async () => {
    const app = createApp();
    const sessionId = 'ses_route6';
    const first = await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'stable spec' }).expect(200);
    expect(first.body.versionId).toMatch(/^v/);
    const second = await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'stable spec' }).expect(200);
    expect(second.body.versionId).toBeNull();
  });

  it('restores the file without recording when record is false', async () => {
    const app = createApp();
    const sessionId = 'ses_route7';
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'adopted spec' }).expect(200);
    const restore = await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'rolled back spec', record: false }).expect(200);
    expect(restore.body.versionId).toBeNull();
    // The restored text is in the file but not in the history.
    const objective = await request(app).get(`/api/goals/objective/${sessionId}`).expect(200);
    expect(objective.body).toEqual({ content: 'rolled back spec' });
    const list = await request(app).get(`/api/goals/objective/${sessionId}/versions`).expect(200);
    expect(list.body.versions.map((version) => version.id)).toHaveLength(1);
  });

  it('drops one recorded version by id', async () => {
    const app = createApp();
    const sessionId = 'ses_route8';
    const written = await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'undo me' }).expect(200);
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'keep me' }).expect(200);
    await request(app).delete(`/api/goals/objective/${sessionId}/versions/${written.body.versionId}`).expect(200);
    const list = await request(app).get(`/api/goals/objective/${sessionId}/versions`).expect(200);
    expect(list.body.versions).toHaveLength(1);
  });

  it('answers 404 for an unknown version', async () => {
    await request(createApp()).get('/api/goals/objective/ses_route2/versions/vmissing').expect(404);
  });

  it('records nothing when a save leaves the text unchanged', async () => {
    const app = createApp();
    const sessionId = 'ses_route3';
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'steady spec' }).expect(200);
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'steady spec' }).expect(200);
    const list = await request(app).get(`/api/goals/objective/${sessionId}/versions`).expect(200);
    expect(list.body.versions).toHaveLength(1);
  });

  it('deletes the history with the objective', async () => {
    const app = createApp();
    const sessionId = 'ses_route4';
    await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'going away' }).expect(200);
    await request(app).delete(`/api/goals/objective/${sessionId}`).expect(200);
    const list = await request(app).get(`/api/goals/objective/${sessionId}/versions`).expect(200);
    expect(list.body.versions).toEqual([]);
  });

  it('still saves the objective when the history write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp();
    const sessionId = 'ses_route5';
    // A directory where the history file goes makes its write fail.
    fs.mkdirSync(path.join(dataDir, 'goals', `${sessionId}.versions.json`), { recursive: true });
    const response = await request(app).put(`/api/goals/objective/${sessionId}`).send({ content: 'saved anyway' }).expect(200);
    expect(response.body).toMatchObject({ ok: true, length: 'saved anyway'.length, versionId: null });
    const objective = await request(app).get(`/api/goals/objective/${sessionId}`).expect(200);
    expect(objective.body).toEqual({ content: 'saved anyway' });
    consoleError.mockRestore();
  });
});
