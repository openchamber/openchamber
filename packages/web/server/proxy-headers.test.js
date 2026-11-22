import { describe, expect, it } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';

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

  it('drops content-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Content-Encoding')).toBe(false);
  });

  it('drops transfer-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('transfer-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Transfer-Encoding')).toBe(false);
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

  it('preserves repeated set-cookie headers on a Node response', () => {
    const responseHeaders = new Headers();
    responseHeaders.append('set-cookie', 'a=1; Path=/');
    responseHeaders.append('set-cookie', 'b=2; Path=/');
    responseHeaders.set('content-type', 'application/json');
    responseHeaders.set('etag', 'W/"abc"');
    responseHeaders.set('content-encoding', 'gzip');
    responseHeaders.set('transfer-encoding', 'chunked');
    responseHeaders.set('www-authenticate', 'Basic realm="test"');

    const response = new ServerResponse(new IncomingMessage(null));
    applyForwardProxyResponseHeaders(responseHeaders, response);

    expect(response.getHeader('set-cookie')).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(response.getHeader('content-type')).toBe('application/json');
    expect(response.getHeader('etag')).toBe('W/"abc"');
    expect(response.getHeader('content-encoding')).toBeUndefined();
    expect(response.getHeader('transfer-encoding')).toBeUndefined();
    expect(response.getHeader('www-authenticate')).toBeUndefined();
  });
});
