import { describe, expect, test } from 'bun:test';

import { buildDesktopAdditionalArguments, resolveRuntimeBootstrap } from './runtime-bootstrap.mjs';

describe('runtime bootstrap', () => {
  test('never places runtime credentials in renderer arguments', () => {
    const args = buildDesktopAdditionalArguments({
      localOrigin: 'http://127.0.0.1:3901',
      apiBaseUrl: 'https://remote.example',
      clientToken: 'bearer-secret',
      requestHeaders: { Authorization: 'Bearer header-secret', 'X-Secret': 'value' },
      relayHostId: 'relay-secret-id',
      homeDirectory: '/Users/test',
      macosMajor: 15,
    });
    const serialized = args.join(' ');
    expect(serialized).not.toContain('bearer-secret');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('openchamber-client-token');
    expect(serialized).not.toContain('openchamber-runtime-headers');
    expect(serialized).not.toContain('openchamber-relay-host-id');
  });

  test('allows only exact packaged/local/sidecar origins and isolates window config', () => {
    const allowed = {
      localOrigin: 'http://127.0.0.1:3901',
      sidecarUrl: 'http://127.0.0.1:57123',
    };
    const first = { apiBaseUrl: 'https://one.example', clientToken: 'one', requestHeaders: { 'CF-Access-Client-Secret': 'header-one' }, relayHostId: 'host-one', privateJwk: { d: 'secret' }, unknown: 'strip' };
    const second = { apiBaseUrl: 'https://two.example', clientToken: 'two', requestHeaders: {}, relayHostId: 'host-two' };

    expect(resolveRuntimeBootstrap('openchamber-ui://app/index.html', first, allowed)).toEqual({
      apiBaseUrl: 'https://one.example', clientToken: 'one', requestHeaders: { 'CF-Access-Client-Secret': 'header-one' }, relayHostId: 'host-one',
    });
    expect(resolveRuntimeBootstrap('http://127.0.0.1:3901/mini-chat.html', second, allowed)?.clientToken).toBe('two');
    expect(resolveRuntimeBootstrap('http://127.0.0.1:57123/', first, allowed)?.clientToken).toBe('one');
    for (const denied of [
      'openchamber-ui://app.evil/index.html',
      'http://127.0.0.1:3902/',
      'http://127.0.0.1:3901.evil.example/',
      'https://remote.example/',
    ]) expect(resolveRuntimeBootstrap(denied, first, allowed)).toBeNull();
  });
});
