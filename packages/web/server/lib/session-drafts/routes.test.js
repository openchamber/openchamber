import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionDraftRoutes } from './routes.js';

const createApp = () => {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers.at(-1));
  return {
    app: { get: register('GET'), put: register('PUT'), delete: register('DELETE') },
    call: async (method, routePath, { params = {}, body } = {}) => {
      let statusCode = 200;
      let payload = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
        send(value) { payload = value; return this; },
        setHeader() {},
      };
      await routes.get(`${method} ${routePath}`)({ params, body }, res);
      return { statusCode, body: payload };
    },
  };
};

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const setup = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-drafts-'));
  directories.push(dataDir);
  const onChanged = vi.fn();
  const { app, call } = createApp();
  registerSessionDraftRoutes(app, { fsPromises, path, openchamberDataDir: dataDir, onChanged, now: () => 1000 });
  return { dataDir, onChanged, call };
};

const png = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;

describe('session drafts', () => {
  it('round trips a folder target and the lead kind, and accepts older drafts without them', async () => {
    const { call } = setup();
    const saved = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'folder-draft' }, body: { directory: '/repo', text: 'hello', targetFolderId: 'folder-1', lead: true },
    });
    expect(saved.body.draft).toMatchObject({ targetFolderId: 'folder-1', lead: true });
    expect((await call('GET', '/api/session-drafts')).body.drafts[0]).toMatchObject({ targetFolderId: 'folder-1', lead: true });
    const old = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'old-draft' }, body: { directory: '/repo', text: 'old' },
    });
    expect(old.statusCode).toBe(200);
  });
  it('stores a draft with its attachment bytes and serves them back', async () => {
    const { call, onChanged, dataDir } = setup();
    const saved = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' },
      body: { directory: '/repo', projectId: 'p', text: 'Fix login', attachments: [{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 9, dataUrl: png }] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.draft).toMatchObject({ id: 'd1', text: 'Fix login', attachments: [{ id: 'a1', kind: 'data', size: 9 }] });
    expect(onChanged).toHaveBeenCalledTimes(1);

    const list = await call('GET', '/api/session-drafts');
    expect(list.body.drafts.map((draft) => draft.id)).toEqual(['d1']);

    const bytes = await call('GET', '/api/session-drafts/:id/attachments/:attachmentId', { params: { id: 'd1', attachmentId: 'a1' } });
    expect(Buffer.from(bytes.body).toString()).toBe('png-bytes');

    // A later save that no longer lists the attachment removes its file.
    await call('PUT', '/api/session-drafts/:id', { params: { id: 'd1' }, body: { directory: '/repo', text: 'Fix login' } });
    expect(fs.existsSync(path.join(dataDir, 'session-drafts', 'd1', 'a1'))).toBe(false);
  });

  it('keeps an attachment the draft already holds when it travels by id only', async () => {
    const { call } = setup();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 9 };
    await call('PUT', '/api/session-drafts/:id', { params: { id: 'd1' }, body: { directory: '/repo', text: 'x', attachments: [{ ...attachment, dataUrl: png }] } });
    const saved = await call('PUT', '/api/session-drafts/:id', { params: { id: 'd1' }, body: { directory: '/repo', text: 'xy', attachments: [attachment] } });
    expect(saved.body.draft.attachments).toEqual([{ ...attachment, kind: 'data' }]);
  });

  it('leaves no attachment bytes behind when the draft is too large', async () => {
    const { call, dataDir } = setup();
    const huge = `data:application/octet-stream;base64,${Buffer.alloc(26 * 1024 * 1024).toString('base64')}`;
    const rejected = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' },
      body: {
        directory: '/repo',
        text: 'x',
        attachments: [
          { id: 'a1', filename: 'small.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;base64,c21h' },
          { id: 'a2', filename: 'huge.bin', mimeType: 'application/octet-stream', size: 26 * 1024 * 1024, dataUrl: huge },
        ],
      },
    });

    expect(rejected.statusCode).toBe(413);
    const folder = path.join(dataDir, 'session-drafts', 'd1');
    expect(fs.existsSync(folder) ? fs.readdirSync(folder) : []).toEqual([]);
  }, 60_000);

  it('counts a kept attachment listed after a new one before writing anything', async () => {
    const { call, dataDir } = setup();
    const dataUrl = (size) => `data:application/octet-stream;base64,${Buffer.alloc(size).toString('base64')}`;
    const kept = { id: 'a1', filename: 'kept.bin', mimeType: 'application/octet-stream', size: 24 * 1024 * 1024 };
    const added = { id: 'a2', filename: 'added.bin', mimeType: 'application/octet-stream', size: 2 * 1024 * 1024 };
    await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' }, body: { directory: '/repo', text: 'before', attachments: [{ ...kept, dataUrl: dataUrl(kept.size) }] },
    });
    const before = await call('GET', '/api/session-drafts');
    const rejected = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' }, body: { directory: '/repo', text: 'after', attachments: [{ ...added, dataUrl: dataUrl(added.size) }, kept] },
    });

    expect(rejected.statusCode).toBe(413);
    expect((await call('GET', '/api/session-drafts')).body).toEqual(before.body);
    const folder = path.join(dataDir, 'session-drafts', 'd1');
    expect(fs.readdirSync(folder)).toEqual(['a1']);
    expect(fs.statSync(path.join(folder, 'a1')).size).toBe(kept.size);
  }, 60_000);

  it('still saves the text of a draft stored over the limit', async () => {
    const { call, dataDir } = setup();
    const kept = { id: 'a1', filename: 'kept.bin', mimeType: 'application/octet-stream', size: 26 * 1024 * 1024 };
    fs.writeFileSync(path.join(dataDir, 'session-drafts.json'), JSON.stringify({
      version: 1,
      drafts: [{ id: 'd1', directory: '/repo', projectId: null, text: 'before', mentions: [], attachments: [{ ...kept, kind: 'data' }], createdAt: 1, updatedAt: 1 }],
    }));
    const saved = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' }, body: { directory: '/repo', text: 'after', attachments: [kept] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.draft.text).toBe('after');
  });

  it('leaves no attachment bytes behind when a later attachment is invalid', async () => {
    const { call, dataDir } = setup();
    const rejected = await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' },
      body: {
        directory: '/repo',
        text: 'x',
        attachments: [
          { id: 'a1', filename: 'small.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;base64,c21h' },
          { id: 'a2', filename: 'broken.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain,c21h' },
        ],
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toEqual({ error: 'Attachment broken.txt is not a base64 data URL' });
    const folder = path.join(dataDir, 'session-drafts', 'd1');
    expect(fs.existsSync(folder) ? fs.readdirSync(folder) : []).toEqual([]);
  });

  it('discards a draft with its files', async () => {
    const { call, dataDir } = setup();
    await call('PUT', '/api/session-drafts/:id', { params: { id: 'd1' }, body: { directory: '/repo', text: 'x', attachments: [{ id: 'a1', filename: 'f', mimeType: 'image/png', size: 9, dataUrl: png }] } });
    expect((await call('DELETE', '/api/session-drafts/:id', { params: { id: 'd1' } })).body).toEqual({ deleted: true });
    expect((await call('GET', '/api/session-drafts')).body.drafts).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'session-drafts', 'd1'))).toBe(false);
  });

  it('refuses ids that could leave the drafts folder and never reads a broken store as empty', async () => {
    const { call, dataDir } = setup();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
    for (const badId of ['../x', '..', '.', '-x']) {
      expect((await call('PUT', '/api/session-drafts/:id', { params: { id: badId }, body: { directory: '/repo', text: 'x' } })).statusCode).toBe(400);
      expect((await call('DELETE', '/api/session-drafts/:id', { params: { id: badId } })).statusCode).toBe(400);
    }
    expect((await call('PUT', '/api/session-drafts/:id', {
      params: { id: 'd1' },
      body: { directory: '/repo', text: 'x', attachments: [{ id: '..', filename: 'f', mimeType: 'text/plain', size: 1, dataUrl: png }] },
    })).statusCode).toBe(400);
    // The data folder itself is untouched.
    expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(true);
    fs.writeFileSync(path.join(dataDir, 'session-drafts.json'), '{"broken"');
    expect((await call('GET', '/api/session-drafts')).statusCode).toBe(500);
  });
});
