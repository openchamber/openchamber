import express from 'express';
import os from 'node:os';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';

import { directoryGate } from './gate.js';
import { directoryReachability } from './index.js';

afterEach(() => vi.restoreAllMocks());

it('creates a folder elsewhere while the workspace is offline, and refuses one on the offline disk', async () => {
  vi.spyOn(directoryReachability, 'check').mockImplementation(async (directory) => (directory.startsWith('/offline') ? 'unreachable' : 'available'));
  const app = express();
  app.use('/api', express.json(), directoryGate);
  app.post('/api/fs/mkdir', (_req, res) => res.json({ success: true }));
  app.get('/api/fs/read', (_req, res) => res.json({ success: true }));
  const mkdir = (path) => request(app).post('/api/fs/mkdir').set('x-opencode-directory', '/offline/project').send({ path });

  await mkdir(os.tmpdir()).expect(200);
  await mkdir('/offline/project/new').expect(503);
  await mkdir('new').expect(503);
  await request(app).get('/api/fs/read').set('x-opencode-directory', '/offline/project').query({ path: 'a.txt' }).expect(503);
});
