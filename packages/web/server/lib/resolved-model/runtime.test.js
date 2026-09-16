import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResolvedModelRuntime } from './runtime.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-resolved-model-'));
  temporaryDirectories.push(dataDir);
  const onModelResolved = vi.fn();
  const runtime = createResolvedModelRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    env: {},
    onModelResolved,
    ...overrides,
  });
  return { runtime, dataDir, onModelResolved };
};

const mountCallbacks = (runtime) => {
  const app = express();
  runtime.registerCallbackRoutes(app, express);
  return app;
};

const prepareEnv = (runtime) => runtime.prepareManagedOpenCodeEnv('{"plugin":["existing.js"],"model":"test/model"}');

describe('managed resolved-model env', () => {
  it('materializes the plugin and returns callback env without dropping existing config', async () => {
    const { runtime, dataDir } = await createRuntime();
    const env = await prepareEnv(runtime);

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('test/model');
    expect(config.plugin).toHaveLength(2);
    expect(config.plugin[0]).toBe('existing.js');
    expect(config.plugin[1]).toContain('openchamber-resolved-model-plugin.js');

    expect(env.OPENCHAMBER_RESOLVED_MODEL_URL).toBe('http://127.0.0.1:3901/api/openchamber/resolved-model/report');
    expect(env.OPENCHAMBER_RESOLVED_MODEL_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);

    const source = await fs.readFile(
      path.join(dataDir, 'resolved-model', 'openchamber-resolved-model-plugin.js'),
      'utf8',
    );
    expect(source).toContain('x-litellm-model-name');
    expect(source).toContain('x-litellm-model-group');
    expect(source).toContain('x-litellm-call-id');
    expect(source).toContain('"chat.headers"');
    expect(source).toContain('OPENCHAMBER_RESOLVED_MODEL_URL');
    expect(source).not.toContain(env.OPENCHAMBER_RESOLVED_MODEL_TOKEN);
  });

  it('refuses to prepare env without a listener port', async () => {
    const { runtime } = await createRuntime({ getActivePort: () => null });
    await expect(prepareEnv(runtime)).rejects.toThrow(/listener port/);
  });

  it('mints a new token for every prepared child environment', async () => {
    const { runtime } = await createRuntime();
    const first = await prepareEnv(runtime);
    const second = await prepareEnv(runtime);
    expect(second.OPENCHAMBER_RESOLVED_MODEL_TOKEN).not.toBe(first.OPENCHAMBER_RESOLVED_MODEL_TOKEN);
  });
});

describe('resolved model reports', () => {
  it('rejects reports without the current per-child token', async () => {
    const { runtime } = await createRuntime();
    await prepareEnv(runtime);
    const app = mountCallbacks(runtime);

    const unauthorized = await request(app)
      .post('/api/openchamber/resolved-model/report')
      .send({ sessionID: 'ses_1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' });
    expect(unauthorized.status).toBe(401);

    const wrongToken = await request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', 'Bearer wrong-token')
      .send({ sessionID: 'ses_1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' });
    expect(wrongToken.status).toBe(401);
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('stores an authorized report and emits it', async () => {
    const { runtime, onModelResolved } = await createRuntime();
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);

    const response = await request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send({
        sessionID: 'ses_1',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash',
        modelGroup: 'bsp-agent-beta',
        callId: 'call-1',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(runtime.getSnapshot()).toEqual([{
      sessionId: 'ses_1',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      modelGroup: 'bsp-agent-beta',
      callId: 'call-1',
      updatedAt: expect.any(Number),
    }]);
    expect(onModelResolved).toHaveBeenCalledTimes(1);
  });

  it('omits optional headers instead of storing placeholders', async () => {
    const { runtime } = await createRuntime();
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);

    await request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send({ sessionID: 'ses_1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' });

    expect(runtime.getSnapshot()).toEqual([{
      sessionId: 'ses_1',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      updatedAt: expect.any(Number),
    }]);
  });

  it('rejects reports missing the session or the model', async () => {
    const { runtime, onModelResolved } = await createRuntime();
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);
    const send = (body) => request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send(body);

    expect((await send({ model: 'model' })).status).toBe(400);
    expect((await send({ sessionID: 'ses_1' })).status).toBe(400);
    expect((await send({ sessionID: 'ses_1', model: '   ' })).status).toBe(400);
    expect(runtime.getSnapshot()).toEqual([]);
    expect(onModelResolved).not.toHaveBeenCalled();
  });
});

describe('resolved model snapshot lifecycle', () => {
  it('keeps the most recently updated sessions within the bound', async () => {
    const { runtime } = await createRuntime({ maxTrackedSessions: 2 });
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);
    const send = (body) => request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send(body);

    await send({ sessionID: 'ses_1', model: 'model-a' });
    await send({ sessionID: 'ses_2', model: 'model-b' });
    await send({ sessionID: 'ses_1', model: 'model-a2' });
    await send({ sessionID: 'ses_3', model: 'model-c' });

    expect(runtime.getSnapshot().map((entry) => entry.sessionId)).toEqual(['ses_1', 'ses_3']);
    const updated = runtime.getSnapshot().find((entry) => entry.sessionId === 'ses_1');
    expect(updated.model).toBe('model-a2');
  });

  it('prunes a deleted session from either event shape', async () => {
    const { runtime, onModelResolved } = await createRuntime();
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);
    const send = (body) => request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send(body);

    await send({ sessionID: 'ses_1', model: 'model-a' });
    await send({ sessionID: 'ses_2', model: 'model-b' });
    runtime.processPayload({ type: 'session.deleted', properties: { info: { id: 'ses_1' } } });
    runtime.processPayload({ type: 'session.deleted', properties: { sessionID: 'ses_2' } });
    runtime.processPayload({ type: 'session.updated', properties: { sessionID: 'ses_1' } });
    runtime.processPayload(null);

    expect(runtime.getSnapshot()).toEqual([]);
    expect(onModelResolved).toHaveBeenCalledTimes(2);
  });

  it('drops every entry on reset because a restart invalidates them', async () => {
    const { runtime } = await createRuntime();
    const env = await prepareEnv(runtime);
    const app = mountCallbacks(runtime);

    await request(app)
      .post('/api/openchamber/resolved-model/report')
      .set('authorization', `Bearer ${env.OPENCHAMBER_RESOLVED_MODEL_TOKEN}`)
      .send({ sessionID: 'ses_1', model: 'model-a' });

    runtime.reset();
    expect(runtime.getSnapshot()).toEqual([]);
  });
});
