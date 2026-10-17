import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerMarkdownImageGrantRoutes } from './routes.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const roots = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createFixture = async ({ sources, markdown } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-session-assets-'));
  roots.push(root);
  const outsideRoot = path.join(root, 'generated-images');
  const directory = path.join(root, 'workspace');
  await Promise.all([
    fs.mkdir(outsideRoot, { recursive: true }),
    fs.mkdir(directory, { recursive: true }),
  ]);
  const defaultPath = path.join(outsideRoot, 'image.png');
  await fs.writeFile(defaultPath, PNG);
  const requestedSources = sources ?? [new URL(`file://${defaultPath}`).toString()];
  const text = markdown ?? requestedSources.map((source) => `![image](${source})`).join('\n');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    id: 'msg_1',
    type: 'assistant',
    content: [{ type: 'text', text }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);

  let fullReadCount = 0;
  const app = express();
  registerMarkdownImageGrantRoutes(app, {
    fsPromises: {
      ...fs,
      readFile: async (...args) => {
        fullReadCount += 1;
        return fs.readFile(...args);
      },
    },
    path,
    os,
    crypto,
    validateDirectoryPath: async (candidate) => candidate === directory
      ? { ok: true, directory }
      : { ok: false, error: 'Invalid directory' },
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
  });
  return {
    app,
    outsideRoot,
    directory,
    fetchMock,
    fullReadCount: () => fullReadCount,
    root,
    sources: requestedSources,
  };
};

const prepare = (app, directory, sources) => request(app)
  .post('/api/openchamber/sessions/ses_1/markdown-image-grants')
  .send({ directory, messageId: 'msg_1', sources })
  .expect(200);

describe('session image assets', () => {
  it('percent-encodes the directory header on the message fetch', async () => {
    const fixture = await createFixture();
    await prepare(fixture.app, fixture.directory, ['image.png']);

    expect(fixture.fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-opencode-directory': encodeURIComponent(fixture.directory),
        }),
      }),
    );
  });

  it('prepares workspace images and images anywhere outside it with one message fetch', async () => {
    const fixture = await createFixture({ sources: ['workspace.png'] });
    await fs.writeFile(path.join(fixture.directory, 'workspace.png'), PNG);
    const outsidePath = path.join(fixture.outsideRoot, 'generated.png');
    await fs.writeFile(outsidePath, PNG);
    const outsideSource = new URL(`file://${outsidePath}`).toString();
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `![workspace](workspace.png)\n![generated](${outsideSource})\n![plain](${outsidePath})` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, ['workspace.png', outsideSource, outsidePath]);

    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.fullReadCount()).toBe(0);
    expect(response.body.results).toHaveLength(3);
    const canonicalOutsidePath = await fs.realpath(outsidePath);
    expect(response.body.results[0]).toEqual({
      source: 'workspace.png',
      status: 'ready',
      path: path.join(fixture.directory, 'workspace.png'),
    });
    for (const [index, source] of [[1, outsideSource], [2, outsidePath]]) {
      expect(response.body.results[index]).toEqual(expect.objectContaining({
        source,
        status: 'ready',
        path: canonicalOutsidePath,
        outsideFileGrant: expect.any(String),
        expiresAt: expect.any(Number),
      }));
    }
  });

  it('returns partial results without letting one missing image block valid images', async () => {
    const fixture = await createFixture({ sources: ['present.png', 'deleted.png'] });
    await fs.writeFile(path.join(fixture.directory, 'present.png'), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source: 'present.png', status: 'ready' }),
      { source: 'deleted.png', status: 'missing' },
    ]);
  });

  it('prepares MP4 and WebM clips past the image size limit, and refuses one with other bytes', async () => {
    const sources = ['clip.mp4', 'clip.webm', 'fake.mp4', 'shot.png'];
    const fixture = await createFixture({ sources });
    const mp4 = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]).copy(mp4);
    await Promise.all([
      fs.writeFile(path.join(fixture.directory, 'clip.mp4'), mp4),
      fs.writeFile(path.join(fixture.directory, 'clip.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])),
      fs.writeFile(path.join(fixture.directory, 'fake.mp4'), PNG),
    ]);
    // A "picture" that links to the clip would load it whole as an image.
    await fs.symlink(path.join(fixture.directory, 'clip.mp4'), path.join(fixture.directory, 'shot.png'));

    const response = await prepare(fixture.app, fixture.directory, sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source: 'clip.mp4', status: 'ready' }),
      expect.objectContaining({ source: 'clip.webm', status: 'ready' }),
      { source: 'fake.mp4', status: 'error' },
      { source: 'shot.png', status: 'error' },
    ]);
  });

  it('resolves encoded workspace paths without treating query or fragment text as a filename', async () => {
    const source = 'screen%20shot.png?version=1#preview';
    const fixture = await createFixture({ sources: [source] });
    await fs.writeFile(path.join(fixture.directory, 'screen shot.png'), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('authorizes reference-style image syntax using its resolved destination', async () => {
    const source = 'reference.png';
    const fixture = await createFixture({
      sources: [source],
      markdown: '![screenshot][result]\n\n[result]: reference.png',
    });
    await fs.writeFile(path.join(fixture.directory, source), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('authorizes inline image destinations containing balanced parentheses', async () => {
    const source = 'screen(1).png';
    const fixture = await createFixture({
      sources: [source],
      markdown: `![screenshot](${source})`,
    });
    await fs.writeFile(path.join(fixture.directory, source), PNG);

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source, status: 'ready' }),
    ]);
  });

  it('requires inline image destinations with titles to close', async () => {
    const sources = ['valid.png', 'malformed.png'];
    const fixture = await createFixture({
      sources,
      markdown: '![valid](valid.png "preview")\n![malformed](malformed.png "preview"',
    });
    await Promise.all(sources.map((source) => fs.writeFile(path.join(fixture.directory, source), PNG)));

    const response = await prepare(fixture.app, fixture.directory, sources);

    expect(response.body.results).toEqual([
      expect.objectContaining({ source: 'valid.png', status: 'ready' }),
      { source: 'malformed.png', status: 'error' },
    ]);
  });

  it('authorizes the local images an openchamber_render page names, and only that tool\'s pages', async () => {
    const fixture = await createFixture({ sources: [] });
    const shotPath = path.join(fixture.directory, 'Screen Shot.png');
    const backgroundPath = path.join(fixture.directory, 'bg.png');
    const otherPath = path.join(fixture.directory, 'other.png');
    await Promise.all([shotPath, backgroundPath, otherPath].map((file) => fs.writeFile(file, PNG)));
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'completed', input: { html: `<img src="${shotPath}">`, title: 'Now' } } },
        { type: 'tool', name: 'openchamber_render', id: 'call_2', state: { status: 'running', input: { parameters: { html: `<div style="background:url(${backgroundPath})"></div>`, title: 'Next' } } } },
        { type: 'tool', name: 'shell', id: 'call_3', state: { status: 'completed', input: { html: `<img src="${otherPath}">` } } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [shotPath, backgroundPath, otherPath]);
    expect(response.body.results).toEqual([
      { source: shotPath, status: 'ready', path: shotPath },
      { source: backgroundPath, status: 'ready', path: backgroundPath },
      { source: otherPath, status: 'error' },
    ]);
  });

  it('rejects a source that the message does not reference', async () => {
    const fixture = await createFixture({ markdown: 'No image here.' });
    const response = await prepare(fixture.app, fixture.directory, fixture.sources);
    expect(response.body.results).toEqual([{ source: fixture.sources[0], status: 'error' }]);
  });

  it('does not authorize image syntax inside fenced or inline code', async () => {
    const fixture = await createFixture({
      markdown: '```md\n![fenced](FENCED)\n```\n`![inline](INLINE)`',
    });
    const sources = ['FENCED', 'INLINE'];

    const response = await prepare(fixture.app, fixture.directory, sources);

    expect(response.body.results).toEqual(sources.map((source) => ({ source, status: 'error' })));
  });

  it('rejects non-image bytes outside the workspace', async () => {
    const fixture = await createFixture();
    const outsidePath = path.join(fixture.outsideRoot, 'notes.png');
    await fs.writeFile(outsidePath, 'not an image');
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `![outside](${outsidePath})` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [outsidePath]);
    expect(response.body.results).toEqual([{ source: outsidePath, status: 'error' }]);
  });

  it('rejects non-image bytes and symlink escapes per source', async () => {
    const fixture = await createFixture({ sources: ['invalid.png', 'linked.png'] });
    await fs.writeFile(path.join(fixture.directory, 'invalid.png'), 'not an image');
    await fs.writeFile(path.join(fixture.root, 'outside.png'), PNG);
    await fs.symlink(path.join(fixture.root, 'outside.png'), path.join(fixture.directory, 'linked.png'));

    const response = await prepare(fixture.app, fixture.directory, fixture.sources);
    expect(response.body.results).toEqual([
      { source: 'invalid.png', status: 'error' },
      { source: 'linked.png', status: 'error' },
    ]);
  });
});
