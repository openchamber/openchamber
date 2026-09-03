import { describe, expect, it } from 'vitest';

import {
  buildManagedOpenCodeOrigin,
  resolveManagedOpenCodeConnectHostname,
} from './host.js';

describe('managed OpenCode host resolution', () => {
  it.each([
    [undefined, '127.0.0.1'],
    ['0.0.0.0', '127.0.0.1'],
    ['::', '::1'],
    ['[::]', '::1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['example.test', 'example.test'],
  ])('resolves %s to %s', (hostname, expected) => {
    expect(resolveManagedOpenCodeConnectHostname(hostname)).toBe(expected);
  });

  it('builds a managed child origin from its launch host', () => {
    expect(buildManagedOpenCodeOrigin({ hostname: 'example.test', port: 4096 }))
      .toBe('http://example.test:4096');
    expect(buildManagedOpenCodeOrigin({ hostname: '0.0.0.0', port: 4096 }))
      .toBe('http://127.0.0.1:4096');
    expect(buildManagedOpenCodeOrigin({ hostname: '::', port: 4096 }))
      .toBe('http://[::1]:4096');
    expect(buildManagedOpenCodeOrigin({ hostname: '[::]', port: 4096 }))
      .toBe('http://[::1]:4096');
    expect(buildManagedOpenCodeOrigin({ hostname: '::1', port: 4096 }))
      .toBe('http://[::1]:4096');
    expect(buildManagedOpenCodeOrigin({ hostname: '[2001:db8::1]', port: 4096 }))
      .toBe('http://[2001:db8::1]:4096');
  });
});
