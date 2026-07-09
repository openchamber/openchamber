import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPreviewProxyRuntime } from './proxy-runtime.js';

describe('preview proxy redirect integration', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    const runtime = createPreviewProxyRuntime({
      crypto,
      URL,
      createProxyMiddleware,
      responseInterceptor,
    });
    runtime.attach(app, {
      express,
      server,
      uiAuthController: { enabled: false },
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: () => {},
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('keeps google.com → www.google.com redirects inside the proxy and frameable', async () => {
    const create = await fetch(`${base}/api/preview/targets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://google.com/', allowExternal: true }),
    });
    expect(create.status).toBe(200);
    const target = await create.json();

    const proxied = await fetch(
      `${base}${target.proxyBasePath}/?oc_preview_token=${encodeURIComponent(target.previewToken)}`,
      { redirect: 'manual' },
    );
    expect(proxied.status).toBe(301);
    const location = proxied.headers.get('location');
    expect(location).toMatch(/^\/api\/preview\/proxy\/[a-f0-9]+\//i);
    expect(location).toContain('oc_preview_target_origin=https%3A%2F%2Fwww.google.com');
    expect(location).not.toBe('https://www.google.com/');

    const cookies = proxied.headers.getSetCookie?.() || [];
    const cookieHeader = cookies.map((entry) => entry.split(';')[0]).join('; ');
    const follow = await fetch(`${base}${location}`, {
      redirect: 'manual',
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    });
    expect(follow.status).toBe(200);
    expect(follow.headers.get('x-frame-options')).toBeNull();
    const body = await follow.text();
    expect(body).toContain('openchamber-preview-bridge');
    // Frame-bust hardening: bridge keeps a real parent for postMessage, then
    // masks top/parent/frameElement so same-origin proxied pages cannot escape.
    expect(body).toContain('const realParent = window.parent');
    expect(body).toContain("Object.defineProperty(window, 'frameElement'");
    expect(body).toContain("Object.defineProperty(window, 'parent'");
    expect(body).toContain("Object.defineProperty(window, 'top'");
    expect(body).toContain('realParent.postMessage');
  }, 20_000);
});
