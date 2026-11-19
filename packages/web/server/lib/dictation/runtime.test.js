import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDictationRuntime } from './runtime.js';

let modelsDir;
const runtimes = [];

beforeEach(async () => {
  modelsDir = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-'));
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  await rm(modelsDir, { recursive: true, force: true });
});

function setup() {
  const routes = new Map();
  const app = {
    post: (path, ...handlers) => routes.set(path, handlers.at(-1)),
    get: (path, handler) => routes.set(path, handler),
    delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
  };
  const server = new EventEmitter();
  const rejectWebSocketUpgrade = vi.fn();
  const runtime = createDictationRuntime({
    app,
    server,
    express: { json: () => () => {} },
    isRequestOriginAllowed: () => false,
    rejectWebSocketUpgrade,
    modelsDir,
  });
  runtimes.push(runtime);
  return { routes, server, rejectWebSocketUpgrade };
}

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    send: vi.fn(),
  };
}

describe('dictation runtime boundaries', () => {
  it('keeps rejection of missing, non-string and blank speech text', async () => {
    const { routes } = setup();
    const speak = routes.get('/api/dictation/tts/speak');
    for (const body of [null, undefined, false, 2, 'text', [], { text: '  ' }, { text: 42 }]) {
      const res = response();
      await speak({ body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Text is required' });
    }
  });

  it('keeps inherited speech fields and arbitrary rejection messages', async () => {
    const { routes } = setup();
    const speak = routes.get('/api/dictation/tts/speak');
    for (const rejection of [{ message: 42 }, null, { message: '' }]) {
      const body = Object.create({
        text: 'inherited',
        get model() { throw rejection; },
      });
      const res = response();
      await speak({ body }, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: rejection?.message || 'Failed to synthesize speech',
      });
    }
  });

  it('reads status with unchecked query values without downloading models', async () => {
    const { routes } = setup();
    const res = response();
    await routes.get('/api/dictation/status')({
      query: { provider: 'openai-compatible', localModel: ['not-a-model'] },
    }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compatible',
      available: true,
      models: expect.arrayContaining([expect.objectContaining({ installed: false })]),
    }));
  });

  it('keeps opaque-origin and refused-origin upgrade rejection', async () => {
    const { server, rejectWebSocketUpgrade } = setup();
    const socket = {};
    server.emit('upgrade', {
      url: '/api/dictation/ws', headers: { origin: 'null' },
    }, socket, Buffer.alloc(0));
    expect(rejectWebSocketUpgrade).toHaveBeenCalledWith(socket, 403, 'Invalid origin');
    rejectWebSocketUpgrade.mockClear();
    server.emit('upgrade', {
      url: '/api/dictation/ws', headers: { origin: 'https://refused.example' },
    }, socket, Buffer.alloc(0));
    await vi.waitFor(() => {
      expect(rejectWebSocketUpgrade).toHaveBeenCalledWith(socket, 403, 'Invalid origin');
    });
  });
});
