import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFeatureRoutesRuntime } from './feature-routes-runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { registerCommonRequestMiddleware } from './core-routes.js';
import { createTrackerRegistry } from '../trackers/registry.js';

const roots = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

it('reads media through existing file routes independently of OpenUI waits', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openui-feature-routes-'));
  roots.push(root);
  const directory = path.join(root, 'workspace');
  const builtInExtensionsDir = path.join(root, 'extensions');
  await fsPromises.mkdir(directory);
  await fsPromises.mkdir(builtInExtensionsDir);
  await fsPromises.writeFile(path.join(builtInExtensionsDir, 'registry.json'), JSON.stringify({ version: 1, extensions: [] }));
  const source = path.join(root, 'preview.png');
  await fsPromises.writeFile(source, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const ui = `root = Stack([Image("Preview", ${JSON.stringify(source)})])`;
  const fetch = vi.fn(async (url) => {
    if (String(url) !== 'http://opencode.test/api/session/ses_1/inbox') throw new Error(`Unexpected OpenCode request: ${url}`);
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const onPageWaitChange = vi.fn();
  const buildOpenCodeUrl = (route) => `http://opencode.test${route}`;
  const getOpenCodeAuthHeaders = () => ({});
  const service = createOpenChamberControlService({
    buildOpenCodeUrl, getOpenCodeAuthHeaders, onPageWaitChange,
  });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  await createFeatureRoutesRuntime({ trackers: createTrackerRegistry([]) }).registerRoutes(app, {
    crypto, fs, fsPromises, os, path, createFsSearchRuntime,
    openchamberDataDir: root, openchamberUserConfigRoot: root, builtInExtensionsDir,
    openChamberControlService: service,
    scheduledTaskService: {}, openChamberSessionService: {},
    resolveGitBinaryForSpawn: () => 'git',
    validateDirectoryPath: async () => ({ ok: true, directory }),
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory }),
    buildOpenCodeUrl, getOpenCodeAuthHeaders,
  });
  const stat = () => request(app).get('/api/fs/stat')
    .query({ directory, path: source, allowOutsideWorkspace: 'true' }).expect(200);
  expect((await stat()).body).toMatchObject({ isFile: true, path: source, size: 16 });
  const read = await request(app).get('/api/fs/raw')
    .query({ directory, path: source, allowOutsideWorkspace: 'true' }).set('Range', 'bytes=0-11').expect(206);
  expect(read.headers['content-range']).toBe('bytes 0-11/16');
  expect(read.body).toEqual(Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
  const controller = new AbortController();
  const pending = service.execute('openui.prompt', { ui }, directory, {
    contextSessionId: 'ses_1', contextCallId: 'call_1', signal: controller.signal,
  });
  try {
    await vi.waitFor(() => expect(onPageWaitChange).toHaveBeenCalled());
    expect((await stat()).body.isFile).toBe(true);
    await request(app).post('/api/openchamber/openui/answer')
      .send({ sessionId: 'ses_1', callId: 'call_1', summary: 'Done' }).expect(200);
    await expect(pending).resolves.toMatchObject({ answer: { summary: 'Done' } });
    expect((await stat()).body.isFile).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('http://opencode.test/api/session/ses_1/inbox');
    await request(app).post('/api/openchamber/openui/answer')
      .send({ sessionId: 'ses_1', callId: 'call_1', summary: 'Again' }).expect(404);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});
