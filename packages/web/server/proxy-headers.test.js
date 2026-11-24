import { describe, expect, it } from 'vitest';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from './proxy-headers.js';

describe('OpenCode proxy header handling', () => {
  it('drops accept-encoding from forwarded request headers', () => {
    const headers = collectForwardProxyHeaders({
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      connection: 'keep-alive',
    });

    expect(headers.accept).toBe('application/json');
    expect(headers['accept-encoding']).toBeUndefined();
  });

  it('replaces client authorization with managed OpenCode auth', () => {
    const headers = collectForwardProxyHeaders(
      { authorization: 'Bearer oc_client_stale-ui-token' },
      { Authorization: 'Bearer managed-opencode-token' },
    );

    expect(headers.Authorization).toBe('Bearer managed-opencode-token');
    expect(headers['authorization']).toBeUndefined();
  });

  it('drops client authorization when upstream has no managed auth', () => {
    const headers = collectForwardProxyHeaders({
      accept: 'application/json',
      authorization: 'Bearer oc_client_stale-ui-token',
    });

    expect(headers['authorization']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.accept).toBe('application/json');
  });

  it('drops the UI session cookie from forwarded request headers', () => {
    const headers = collectForwardProxyHeaders({
      accept: 'application/json',
      cookie: 'oc_ui_session_3001=ui-session-secret',
      Cookie: 'oc_ui_session_3001=ui-session-secret',
    });

    expect(headers.cookie).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(headers.accept).toBe('application/json');
  });

  it('keeps a packaged client cross-site fetch metadata away from OpenCode', () => {
    const headers = collectForwardProxyHeaders({
      origin: 'capacitor://localhost',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });

    expect(headers).toEqual({ origin: 'capacitor://localhost' });
  });

  it('drops content-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Content-Encoding')).toBe(false);
  });

  it('drops transfer-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('transfer-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Transfer-Encoding')).toBe(false);
  });

  it('drops an upstream clear-site-data so it cannot wipe the browser origin', () => {
    expect(shouldForwardProxyResponseHeader('clear-site-data')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Clear-Site-Data')).toBe(false);
    expect(shouldForwardProxyResponseHeader('content-type')).toBe(true);
  });

  it('drops an upstream set-cookie before it reaches the browser origin', () => {
    expect(shouldForwardProxyResponseHeader('set-cookie')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Set-Cookie')).toBe(false);
  });

  it('still keeps ordinary response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-type')).toBe(true);
    expect(shouldForwardProxyResponseHeader('etag')).toBe(true);
  });

  it('applies upstream response headers to express response without content-encoding', () => {
    const applied = [];
    const response = {
      setHeader(key, value) {
        applied.push([key, value]);
      },
    };

    applyForwardProxyResponseHeaders(
      new Headers({
        'content-type': 'application/json',
        etag: 'W/"abc"',
        'content-encoding': 'gzip',
      }),
      response,
    );

    expect(applied).toEqual([
      ['content-type', 'application/json'],
      ['etag', 'W/"abc"'],
    ]);
  });
});
