import http from 'node:http';
import { afterEach, describe, expect, test } from 'bun:test';

import { createDevServerPageProber, extractIconHref, extractPageTitle, probeDevServerPage } from './page-probe.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** An ICO file holding the given frames, as icon tools write it. */
const ico = (frames) => {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ width, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(width === 256 ? 0 : width, entry);
    header.writeUInt8(width === 256 ? 0 : width, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map(({ data }) => data)]);
};

const framePng = (marker, size = 0) => Buffer.concat([PNG, Buffer.from(marker), Buffer.alloc(size)]);

const servers = [];

/** A real listener on a free loopback port, answering each request with `handle`. */
const listen = async (handle) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  servers.push(server);
  return { port: server.address().port, requests };
};

/** A port that was just free: nothing listens there. */
const closedPort = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  }));
});

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

describe('probeDevServerPage', () => {
  test('reads the title and the linked favicon of a page', async () => {
    const { port } = await listen((req, res) => {
      if (req.url === '/icon.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
        return;
      }
      html(res, '<!doctype html><html><head><title>Shop &amp; Admin</title><link rel="shortcut icon" href="/icon.png"></head><body></body></html>');
    });

    expect(await probeDevServerPage(fetch, port, 2_000)).toEqual({
      title: 'Shop & Admin',
      icon: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  test('falls back to /favicon.ico, reads a PNG saved as .ico, and leaves the icon empty when there is none', async () => {
    const withIco = await listen((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon' });
        res.end(PNG);
        return;
      }
      html(res, '<title>Vite App</title>');
    });
    const withoutIcon = await listen((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      html(res, '<p>no head at all</p>');
    });

    expect(await probeDevServerPage(fetch, withIco.port, 2_000)).toEqual({
      title: 'Vite App',
      icon: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(await probeDevServerPage(fetch, withoutIcon.port, 2_000)).toEqual({ title: null, icon: null });
  });

  test('takes the 32px frame of a large multi-size ICO, as OpenCode and Next ship', async () => {
    const frame32 = framePng('frame-32');
    const { port } = await listen((req, res) => {
      if (req.url === '/icons/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/vnd.microsoft.icon' });
        res.end(ico([
          { width: 16, data: framePng('frame-16') },
          { width: 32, data: frame32 },
          { width: 256, data: framePng('frame-256', 200 * 1024) },
        ]));
        return;
      }
      html(res, '<title>OpenCode</title><link rel="icon" type="image/x-icon" href="/icons/favicon.ico">');
    });

    expect(await probeDevServerPage(fetch, port, 2_000)).toEqual({
      title: 'OpenCode',
      icon: `data:image/png;base64,${frame32.toString('base64')}`,
    });
  });

  test('skips a frame too large to send or pointing outside the file for one that fits', async () => {
    const frame16 = framePng('frame-16');
    const file = ico([{ width: 32, data: framePng('frame-32', 40 * 1024) }, { width: 16, data: frame16 }, { width: 48, data: framePng('frame-48') }]);
    file.writeUInt32LE(6, 6 + 2 * 16 + 12);
    const { port } = await listen((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon' });
        res.end(file);
        return;
      }
      html(res, '<title>App</title>');
    });

    expect((await probeDevServerPage(fetch, port, 2_000)).icon).toBe(`data:image/png;base64,${frame16.toString('base64')}`);
  });

  test('keeps a bitmap ICO frame as a one-frame ICO', async () => {
    const bitmap = Buffer.from('40000000bitmap-32', 'utf8');
    const { port } = await listen((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon' });
        res.end(ico([{ width: 48, data: Buffer.from('bitmap-48') }, { width: 32, data: bitmap }]));
        return;
      }
      html(res, '<title>Paseo</title>');
    });

    const page = await probeDevServerPage(fetch, port, 2_000);
    const single = Buffer.from(page.icon.replace('data:image/x-icon;base64,', ''), 'base64');
    expect(single.readUInt16LE(4)).toBe(1);
    expect(single.readUInt8(6)).toBe(32);
    expect(single.subarray(22)).toEqual(bitmap);
  });

  test('falls back to /favicon.ico when the linked icon is too large to send', async () => {
    const { port } = await listen((req, res) => {
      if (req.url === '/icon-512.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(framePng('big', 100 * 1024));
        return;
      }
      if (req.url === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon' });
        res.end(ico([{ width: 32, data: framePng('fallback') }]));
        return;
      }
      html(res, '<title>Next</title><link rel="icon" href="/icon-512.png">');
    });

    expect((await probeDevServerPage(fetch, port, 2_000)).icon)
      .toBe(`data:image/png;base64,${framePng('fallback').toString('base64')}`);
  });

  test('follows a redirect on the same port to the page', async () => {
    const { port } = await listen((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      if (req.url === '/login') html(res, '<title>Sign in</title>');
      else res.writeHead(404).end();
    });

    expect(await probeDevServerPage(fetch, port, 2_000)).toEqual({ title: 'Sign in', icon: null });
  });

  test('keeps a page whose body stalls after its head arrived', async () => {
    const { port } = await listen((req, res) => {
      if (req.url !== '/') return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><title>Streaming</title>');
    });
    expect(await probeDevServerPage(fetch, port, 300)).toEqual({ title: 'Streaming', icon: null });
  });

  test('counts a dev server error page as a page', async () => {
    const { port } = await listen((_req, res) => html(res, '<title>Build failed</title>', 500));
    expect(await probeDevServerPage(fetch, port, 2_000)).toEqual({ title: 'Build failed', icon: null });
  });

  test('is no page for an API, a "Cannot GET /" answer, a non-HTTP port or a closed one', async () => {
    const api = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const notFound = await listen((_req, res) => html(res, '<title>Error</title><pre>Cannot GET /</pre>', 404));
    const raw = http.createServer();
    raw.on('connection', (socket) => socket.end('-ERR unknown command\r\n'));
    await new Promise((resolve) => raw.listen(0, 'localhost', resolve));
    servers.push(raw);

    expect(await probeDevServerPage(fetch, api.port, 2_000)).toBeNull();
    expect(await probeDevServerPage(fetch, notFound.port, 2_000)).toBeNull();
    expect(await probeDevServerPage(fetch, raw.address().port, 2_000)).toBeNull();
    expect(await probeDevServerPage(fetch, await closedPort(), 2_000)).toBeNull();
  });
});

describe('page parsing', () => {
  test('collapses whitespace in the title and decodes character references', () => {
    expect(extractPageTitle('<head><title data-x="1">\n  Docs &#8212; &#x41;PI\n</title>')).toBe('Docs — API');
    expect(extractPageTitle('<title>   </title>')).toBeNull();
  });

  test('reads the title from the markup, never from a comment or a script', () => {
    expect(extractPageTitle('<!-- put <title> tags here --><script>const t = "<title>x</title>";</script><title data-sm>OpenCode</title>')).toBe('OpenCode');
  });

  test('takes an icon link in any attribute order, skipping other links', () => {
    expect(extractIconHref('<link rel="stylesheet" href="/a.css"><link href=\'/f.svg\' type="image/svg+xml" rel="icon">')).toBe('/f.svg');
    expect(extractIconHref('<link rel="apple-touch-icon" href="/t.png">')).toBeNull();
  });
});

const never = () => new Promise(() => {});
const now = async () => {};

/** A listener whose answers the test releases one by one. */
const heldListener = async (pageFor) => {
  const held = [];
  const server = await listen((req, res) => {
    if (req.url !== '/') return res.writeHead(404).end();
    held.push(() => html(res, pageFor()));
  });
  return {
    ...server,
    async release() {
      while (held.length === 0) await new Promise((resolve) => setImmediate(resolve));
      held.shift()();
    },
  };
};

describe('dev server page prober', () => {
  test('asks a port once while its answer is fresh, and again after a new process takes the port', async () => {
    const { port, requests } = await listen((_req, res) => html(res, '<title>App</title>'));
    let clock = 0;
    const prober = createDevServerPageProber({ now: () => clock, ttlMs: 1_000, firstAnswersDeadline: never });
    const pageRequests = () => requests.filter((url) => url === '/').length;

    expect((await prober.describe([{ port, pid: 1 }])).get(port)).toEqual({ title: 'App', icon: null });
    expect(pageRequests()).toBe(1);

    clock = 500;
    await prober.describe([{ port, pid: 1 }]);
    expect(pageRequests()).toBe(1);

    await prober.describe([{ port, pid: 2 }]);
    expect(pageRequests()).toBe(2);
  });

  test('returns the last answer while a slow refresh runs, and the new one once it lands', async () => {
    let title = 'Old';
    const server = await heldListener(() => `<title>${title}</title>`);
    let clock = 0;
    let deadline = never;
    const prober = createDevServerPageProber({ now: () => clock, ttlMs: 1_000, firstAnswersDeadline: () => deadline() });

    const first = prober.describe([{ port: server.port, pid: 1 }]);
    await server.release();
    expect((await first).get(server.port)).toEqual({ title: 'Old', icon: null });

    title = 'New';
    clock = 5_000;
    deadline = now;
    expect((await prober.describe([{ port: server.port, pid: 1 }])).get(server.port)).toEqual({ title: 'Old', icon: null });

    deadline = never;
    const refreshed = prober.describe([{ port: server.port, pid: 1 }]);
    await server.release();
    expect((await refreshed).get(server.port)).toEqual({ title: 'New', icon: null });
  });

  test('returns without a port that has not answered yet, and reports it once it does', async () => {
    const server = await heldListener(() => '<title>Next</title>');
    let deadline = now;
    const prober = createDevServerPageProber({ firstAnswersDeadline: () => deadline() });

    expect((await prober.describe([{ port: server.port, pid: 1 }])).has(server.port)).toBe(false);

    deadline = never;
    const answered = prober.describe([{ port: server.port, pid: 1 }]);
    await server.release();
    expect((await answered).get(server.port)).toEqual({ title: 'Next', icon: null });
  });

  test('asks at most `concurrency` ports at once', async () => {
    let active = 0;
    let peak = 0;
    const ports = await Promise.all([1, 2, 3, 4, 5].map(() => listen((_req, res) => {
      active += 1;
      peak = Math.max(peak, active);
      res.on('finish', () => { active -= 1; });
      queueMicrotask(() => html(res, '<title>x</title>'));
    })));
    const prober = createDevServerPageProber({ concurrency: 2, firstAnswersDeadline: never });

    const pages = await prober.describe(ports.map(({ port }, index) => ({ port, pid: index })));
    expect(pages.size).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
