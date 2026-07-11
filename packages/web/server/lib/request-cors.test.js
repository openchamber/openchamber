import { describe, expect, it } from 'bun:test';

import { applyRuntimeCorsHeaders } from './request-cors.js';

describe('applyRuntimeCorsHeaders', () => {
  it('gives packaged clients a reusable preflight cache window', () => {
    const headers = new Map();
    applyRuntimeCorsHeaders({
      origin: 'openchamber-ui://app',
      setHeader: (name, value) => headers.set(name, value),
    });
    expect(headers.get('Access-Control-Max-Age')).toBe('600');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('openchamber-ui://app');
  });
});
