import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
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

const preparePage = (app, directory, callId, sources) => request(app)
  .post('/api/openchamber/sessions/ses_1/markdown-image-grants')
  .send({ directory, messageId: 'msg_1', callId, sources })
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
      expect(response.body.results[index]).toEqual({
        source,
        status: 'ready',
        path: canonicalOutsidePath,
      });
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

  it.skipIf(process.platform === 'win32')('refuses a FIFO referenced as an image promptly and still prepares later sources (#1785)', async () => {
    const fixture = await createFixture({ sources: ['fifo.png', 'present.png'] });
    execFileSync('mkfifo', [path.join(fixture.directory, 'fifo.png')]);
    await fs.writeFile(path.join(fixture.directory, 'present.png'), PNG);

    // Without O_NONBLOCK the open of the FIFO never settles, so this
    // request would hang instead of answering.
    const response = await prepare(fixture.app, fixture.directory, fixture.sources);

    expect(response.body.results).toEqual([
      { source: 'fifo.png', status: 'error' },
      expect.objectContaining({ source: 'present.png', status: 'ready' }),
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

  it('reads the page of a call a harness spilled into the action text, as the plugin revives it', async () => {
    const fixture = await createFixture({ sources: [] });
    const [onPage, sibling, unreferenced] = ['on-page.png', 'sibling.png', 'unreferenced.png']
      .map((name) => path.join(fixture.directory, name));
    await Promise.all([onPage, sibling, unreferenced].map((file) => fs.writeFile(file, PNG)));
    const spilled = (fields) => ({ action: JSON.stringify({ awaitAnswer: true, ...fields }) });
    const message = {
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'running', input: spilled({ html: `<img src="${onPage}">`, parameters: null }) } },
        // The spilled object's own parameters win over its siblings.
        { type: 'tool', name: 'openchamber_render', id: 'call_2', state: { status: 'running', input: spilled({ html: `<img src="${sibling}">`, parameters: { html: `<img src="${onPage}">` } }) } },
      ],
    };
    fixture.fetchMock.mockImplementation(async () => new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await preparePage(fixture.app, fixture.directory, 'call_1', [onPage, unreferenced]);
    expect(first.body.results).toEqual([
      { source: onPage, status: 'ready', path: onPage },
      { source: unreferenced, status: 'error' },
    ]);
    const second = await preparePage(fixture.app, fixture.directory, 'call_2', [onPage, sibling]);
    expect(second.body.results).toEqual([
      { source: onPage, status: 'ready', path: onPage },
      { source: sibling, status: 'error' },
    ]);
  });

  it('authorizes the files a finished openchamber_image call saved, and no others', async () => {
    const fixture = await createFixture({ sources: [] });
    const madePath = path.join(fixture.directory, 'made.png');
    const failedPath = path.join(fixture.directory, 'failed.png');
    await Promise.all([madePath, failedPath].map((file) => fs.writeFile(file, PNG)));
    const envelope = (ok, file) => JSON.stringify({ schemaVersion: 1, ok, action: 'image.generate', data: { images: [{ path: file }] } });
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'tool', name: 'openchamber_image', id: 'call_1', state: { status: 'completed', input: {}, content: [{ type: 'text', text: envelope(true, madePath) }] } },
        { type: 'tool', name: 'openchamber_image', id: 'call_2', state: { status: 'completed', input: {}, content: [{ type: 'text', text: envelope(false, failedPath) }] } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [madePath, failedPath]);
    expect(response.body.results).toEqual([
      { source: madePath, status: 'ready', path: madePath },
      { source: failedPath, status: 'error' },
    ]);
  });

  it('authorizes the screenshot a browser.capture call saved, behind Code Mode too, and no others', async () => {
    const fixture = await createFixture({ sources: [] });
    const shots = ['direct', 'script', 'quoted', 'failed', 'other'].map((name) => `.openchamber/screenshots/${name}.png`);
    await fs.mkdir(path.join(fixture.directory, '.openchamber', 'screenshots'), { recursive: true });
    await Promise.all(shots.map((file) => fs.writeFile(path.join(fixture.directory, file), PNG)));
    const envelope = (ok, file, action = 'browser.capture') => JSON.stringify({ schemaVersion: 1, ok, action, data: { path: file } });
    const tool = (name, id, text) => ({ type: 'tool', name, id, state: { status: 'completed', input: {}, content: [{ type: 'text', text }] } });
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [
        tool('openchamber_web', 'call_1', envelope(true, shots[0])),
        tool('execute', 'call_2', envelope(true, shots[1])),
        tool('execute', 'call_3', JSON.stringify(envelope(true, shots[2]))),
        tool('execute', 'call_4', envelope(false, shots[3])),
        tool('execute', 'call_5', envelope(true, shots[4], 'browser.snapshot')),
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, shots);
    expect(response.body.results.map((result) => result.status)).toEqual(['ready', 'ready', 'ready', 'error', 'error']);
  });

  it('matches a generated file with spaces or other letters however Markdown encoded it', async () => {
    const fixture = await createFixture({ sources: [] });
    const folder = path.join(fixture.directory, 'my images');
    await fs.mkdir(folder, { recursive: true });
    const madePath = path.join(folder, 'маяк.png');
    await fs.writeFile(madePath, PNG);
    const text = JSON.stringify({ schemaVersion: 1, ok: true, action: 'image.generate', data: { images: [{ path: madePath }] } });
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'tool', name: 'openchamber_image', id: 'call_1', state: { status: 'completed', input: {}, content: [{ type: 'text', text }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const encoded = encodeURI(madePath);
    const response = await prepare(fixture.app, fixture.directory, [encoded]);
    expect(response.body.results).toEqual([expect.objectContaining({ source: encoded, status: 'ready' })]);
  });

  it('prepares every image a page or a text names in one request, past twelve', async () => {
    const fixture = await createFixture({ sources: [] });
    const files = Array.from({ length: 19 }, (_, index) => path.join(fixture.directory, `poster-${index + 1}.png`));
    await Promise.all(files.map((file) => fs.writeFile(file, PNG)));
    const html = files.map((file) => `<img src="${file}">`).join('');
    const message = {
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'text', text: files.map((file) => `![poster](${file})`).join('\n') },
        { type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'completed', input: { html, title: 'Posters' } } },
      ],
    };
    fixture.fetchMock.mockImplementation(async () => new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } }));

    const page = await preparePage(fixture.app, fixture.directory, 'call_1', files);
    const text = await prepare(fixture.app, fixture.directory, files);

    for (const response of [page, text]) {
      expect(response.body.results).toEqual(files.map((file) => ({ source: file, status: 'ready', path: file })));
    }
  });

  it('takes the source list of a page that names hundreds of images', async () => {
    const fixture = await createFixture({ sources: [] });
    const files = Array.from({ length: 400 }, (_, index) => path.join(fixture.directory, `a-long-gallery-file-name-for-poster-number-${index + 1}.png`));
    await Promise.all(files.map((file) => fs.writeFile(file, PNG)));
    const html = files.map((file) => `<img src="${file}">`).join('');
    fixture.fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'completed', input: { html, title: 'Gallery' } } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    // Well past the old 32 KB body limit.
    expect(JSON.stringify(files).length).toBeGreaterThan(32 * 1024);
    const response = await preparePage(fixture.app, fixture.directory, 'call_1', files);
    expect(response.body.results.filter((result) => result.status === 'ready')).toHaveLength(400);
  });

  it('shows a page\'s images in page order while their files fit the page\'s weight budget', async () => {
    const fixture = await createFixture({ sources: [] });
    const [first, missing, second, third, small] = ['first.png', 'missing.png', 'second.png', 'third.png', 'small.png']
      .map((name) => path.join(fixture.directory, name));
    // 9 MiB each: two fit the 25 MiB budget, the third does not, and nothing after it does.
    for (const file of [first, second, third]) {
      await fs.writeFile(file, PNG);
      await fs.truncate(file, 9 * 1024 * 1024);
    }
    await fs.writeFile(small, PNG);
    const html = [first, missing, second, third, small].map((file) => `<img src="${file}">`).join('');
    const message = {
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'completed', input: { html, title: 'Photos' } } }],
    };
    fixture.fetchMock.mockImplementation(async () => new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } }));

    const whole = await preparePage(fixture.app, fixture.directory, 'call_1', [first, missing, second, third, small]);
    expect(whole.body.results).toEqual([
      { source: first, status: 'ready', path: first },
      { source: missing, status: 'missing' },
      { source: second, status: 'ready', path: second },
      { source: third, status: 'too-heavy' },
      { source: small, status: 'too-heavy' },
    ]);

    // The page decides, not the request: asking for the small image alone does not get it past the budget.
    const part = await preparePage(fixture.app, fixture.directory, 'call_1', [small, second]);
    expect(part.body.results).toEqual([
      { source: small, status: 'too-heavy' },
      { source: second, status: 'ready', path: second },
    ]);
  });

  it('refuses a page the message does not hold, and a source its page does not name', async () => {
    const fixture = await createFixture({ sources: [] });
    const onPage = path.join(fixture.directory, 'on-page.png');
    const inText = path.join(fixture.directory, 'in-text.png');
    await Promise.all([onPage, inText].map((file) => fs.writeFile(file, PNG)));
    const message = {
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'text', text: `![in text](${inText})` },
        { type: 'tool', name: 'openchamber_render', id: 'call_1', state: { status: 'completed', input: { html: `<img src="${onPage}">`, title: 'One' } } },
      ],
    };
    fixture.fetchMock.mockImplementation(async () => new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } }));

    const page = await preparePage(fixture.app, fixture.directory, 'call_1', [onPage, inText]);
    expect(page.body.results).toEqual([
      { source: onPage, status: 'ready', path: onPage },
      { source: inText, status: 'error' },
    ]);
    await request(fixture.app)
      .post('/api/openchamber/sessions/ses_1/markdown-image-grants')
      .send({ directory: fixture.directory, messageId: 'msg_1', callId: 'call_9', sources: [onPage] })
      .expect(404);
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

  it('does not authorize image syntax inside a multiline inline code span', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `\`example\n![hidden](${source})\nend\`` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'error' }]);
  });

  it('authorizes an image referenced after a multiline inline code span closes', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `\`example\n![hidden](ignored)\nend\` then ![real](${source})` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'ready', path: expect.any(String) }]);
  });

  it('does not authorize image syntax inside HTML comments', async () => {
    const fixture = await createFixture();
    const single = fixture.sources[0];
    const multiPath = path.join(fixture.outsideRoot, 'multi.png');
    await fs.writeFile(multiPath, PNG);
    const multi = new URL(`file://${multiPath}`).toString();
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `<!-- ![hidden](${single}) -->\n<!--\n![multi](${multi})\n-->` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [single, multi]);

    expect(response.body.results).toEqual([
      { source: single, status: 'error' },
      { source: multi, status: 'error' },
    ]);
  });

  it('authorizes image references outside HTML comments on the same line', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `<!-- hidden --> ![visible](${source})` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([
      { source, status: 'ready', path: decodeURIComponent(new URL(source).pathname) },
    ]);
  });

  it('does not authorize image syntax inside indented code blocks', async () => {
    const fixture = await createFixture();
    const shown = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: 'Example:\n\n    ![hidden](INDENTED)\n\nSome text.\n\n\t![tabbed](TABBED)\n\n![shown](' + shown + ')' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, ['INDENTED', 'TABBED', shown]);

    expect(response.body.results).toEqual([
      { source: 'INDENTED', status: 'error' },
      { source: 'TABBED', status: 'error' },
      { source: shown, status: 'ready', path: decodeURIComponent(new URL(shown).pathname) },
    ]);
  });

  it('does not authorize image syntax inside raw HTML blocks', async () => {
    const fixture = await createFixture();
    const pre = fixture.sources[0];
    const divPath = path.join(fixture.outsideRoot, 'div.png');
    await fs.writeFile(divPath, PNG);
    const div = new URL(`file://${divPath}`).toString();
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `<pre>\n![hidden](${pre})\n</pre>\n<div>\n![also-hidden](${div})\n</div>` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [pre, div]);

    expect(response.body.results).toEqual([
      { source: pre, status: 'error' },
      { source: div, status: 'error' },
    ]);
  });

  it('authorizes image references after a raw HTML block ends', async () => {
    const fixture = await createFixture();
    const afterPre = fixture.sources[0];
    const afterDivPath = path.join(fixture.outsideRoot, 'after-div.png');
    await fs.writeFile(afterDivPath, PNG);
    const afterDiv = new URL(`file://${afterDivPath}`).toString();
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: `<pre>\nno images here\n</pre>\n![visible](${afterPre})\n\n<div>\nno images here either\n</div>\n\n![also-visible](${afterDiv})` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [afterPre, afterDiv]);

    expect(response.body.results).toEqual([
      { source: afterPre, status: 'ready', path: decodeURIComponent(new URL(afterPre).pathname) },
      { source: afterDiv, status: 'ready', path: decodeURIComponent(new URL(afterDiv).pathname) },
    ]);
  });

  it('does not close a backtick fence on a longer run followed by text (#2150)', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: '```md\n```` not-a-closer\n![hidden](' + source + ')\n```' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'error' }]);
  });

  it('does not close a tilde fence on a longer run followed by text (#2150)', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: '~~~md\n~~~~ not-a-closer\n![hidden](' + source + ')\n~~~' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'error' }]);
  });

  it('recognizes an image after a longer closing run followed only by spaces/tabs (#2150)', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [{ type: 'text', text: '```md\n![fenced](ignored)\n````  \t\n![outside](' + source + ')' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'ready', path: decodeURIComponent(new URL(source).pathname) }]);
  });

  it('keeps fenced-code state across assistant text parts', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'text', text: '```md' },
        { type: 'tool', name: 'ignored', state: { input: { text: `![tool](${source})` } } },
        { type: 'text', text: `![fenced](${source})` },
        { type: 'text', text: '```' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'error' }]);
  });

  it('recognizes images after a fence closes in a later text part', async () => {
    const fixture = await createFixture();
    const source = fixture.sources[0];
    fixture.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'assistant',
      content: [
        { type: 'text', text: '```md\n![fenced](ignored)' },
        { type: 'text', text: `\n\`\`\`\n![outside](${source})` },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await prepare(fixture.app, fixture.directory, [source]);

    expect(response.body.results).toEqual([{ source, status: 'ready', path: decodeURIComponent(new URL(source).pathname) }]);
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
