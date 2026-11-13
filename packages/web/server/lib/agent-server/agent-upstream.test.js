import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentUpstream, boundedEventStream, readBoundedBody } from './agent-upstream.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(handler, options = {}) {
  let logins = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/auth/session') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (JSON.parse(Buffer.concat(chunks)).password !== 'disposable') { res.writeHead(401).end(); return; }
      logins += 1;
      res.setHeader('set-cookie', `oc_ui_session_1234=login-${logins}; Path=/; Max-Age=10`);
      res.end('{}');
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const upstream = createAgentUpstream({ url: `http://127.0.0.1:${server.address().port}`, token: 'disposable', ...options });
  cleanups.push(() => upstream.close());
  return { upstream, logins: () => logins };
}

describe('agent transport', () => {
  it('preserves an SDK Request method, body, headers and path through its fetch adapter', async () => {
    const { upstream } = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(JSON.stringify({ method: req.method, path: req.url, custom: req.headers['x-sdk-test'], body: Buffer.concat(chunks).toString() }));
    });
    const response = await upstream.fetch(new Request(upstream.buildUrl('/api/session'), {
      method: 'POST', headers: { 'x-sdk-test': 'preserved' }, body: '{"title":"sdk"}',
    }));
    expect(await response.json()).toEqual({ method: 'POST', path: '/api/session', custom: 'preserved', body: '{"title":"sdk"}' });
  });
  it('logs in once and maps /api paths without adding a prefix', async () => {
    // Given a server using password sessions.
    const { upstream, logins } = await fixture((req, res) => res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie })));
    // When concurrent reads enter the same transport.
    const results = await Promise.all([upstream.json('/api/session'), upstream.json('/api/info')]);
    // Then one login authenticates both exact routes.
    expect(logins()).toBe(1);
    expect(results).toEqual([{ path: '/api/session', cookie: 'oc_ui_session_1234=login-1' }, { path: '/api/info', cookie: 'oc_ui_session_1234=login-1' }]);
  });
  it('renews at 90 percent of the issued Max-Age', async () => {
    // Given an injected clock and a ten-second session.
    let clock = 0;
    const { upstream, logins } = await fixture((_req, res) => res.end('{}'), { now: () => clock });
    await upstream.json('/api/info');
    clock = 8_999;
    await upstream.json('/api/info');
    // When the renewal boundary is reached.
    clock = 9_000;
    await upstream.json('/api/info');
    // Then a second password exchange replaces the cookie.
    expect(logins()).toBe(2);
  });
  it('relogs in once and retries a bodiless 401', async () => {
    // Given an upstream that rejects its first cookie.
    let attempts = 0;
    const { upstream, logins } = await fixture((req, res) => { attempts += 1; res.writeHead(req.headers.cookie.endsWith('login-1') ? 401 : 200).end('{}'); });
    // When a read is refused.
    await upstream.json('/api/session');
    // Then exactly one new login and one retry occur.
    expect({ attempts, logins: logins() }).toEqual({ attempts: 2, logins: 2 });
  });
  it('renews a refused body request without replaying its mutation', async () => {
    // Given a mutation with a potentially consumed body.
    let attempts = 0;
    const { upstream, logins } = await fixture((_req, res) => { attempts += 1; res.writeHead(401).end(); });
    // When authentication expires during that mutation.
    const result = upstream.json('/api/session', { method: 'POST', body: '{}' });
    // Then the caller retries explicitly on a renewed session.
    await expect(result).rejects.toMatchObject({ code: 'agent_session_expired' });
    expect({ attempts, logins: logins() }).toEqual({ attempts: 1, logins: 2 });
  });
  it('refuses a redirect without visiting its target', async () => {
    // Given a malicious redirect to an owner route.
    const paths = [];
    const { upstream } = await fixture((req, res) => { paths.push(req.url); res.writeHead(307, { location: '/api/protected-mcp' }).end(); });
    // When the upstream answers.
    await expect(upstream.json('/api/session')).rejects.toMatchObject({ code: 'agent_redirected' });
    // Then only the requested path was visited.
    expect(paths).toEqual(['/api/session']);
  });
  it('bounds a JSON response', async () => {
    // Given an oversized untrusted body.
    const { upstream } = await fixture((_req, res) => res.end('x'.repeat(100)), { maxBytes: 16 });
    // When read, then the body is refused before parsing.
    await expect(upstream.json('/api/session')).rejects.toMatchObject({ code: 'agent_response_too_large' });
  });
  it('bounds the whole read when an answer never ends', async () => {
    // Given headers and a partial answer with no end.
    const { upstream } = await fixture((_req, res) => { res.writeHead(200); res.write('{'); }, { timeoutMs: 100 });
    // When read, then its deadline closes the unfinished response.
    await expect(upstream.json('/api/session')).rejects.toBeInstanceOf(Error);
  });
  it.each(['data: ' + 'x'.repeat(100), 'data: small\ndata: ' + 'x'.repeat(100)])('caps unfinished SSE events', async (text) => {
    // Given an SSE source that never ends the oversized event.
    const source = boundedEventStream(Readable.from([Buffer.from(text)]), 32);
    // When consumed, then a line or cumulative event cap refuses it.
    await expect(readBoundedBody(source, 1000)).rejects.toMatchObject({ code: 'agent_stream_too_large' });
  });
  it('keeps ordinary CRLF events across arbitrary chunk boundaries', async () => {
    // Given several valid events, larger in total than the per-event cap.
    const text = 'data: 1\r\n\r\ndata: 2\r\n\r\n';
    const source = boundedEventStream(Readable.from([...text].map((c) => Buffer.from(c))), 16);
    // When consumed, then all original bytes survive.
    expect(await readBoundedBody(source, 1000)).toBe(text);
  });
});
