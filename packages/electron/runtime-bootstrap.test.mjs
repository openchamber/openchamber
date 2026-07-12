import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildDesktopAdditionalArguments,
  buildRuntimeBootMetadataScript,
  isRuntimeBootstrapSenderAllowed,
  resolveRuntimeBootstrap,
} from './runtime-bootstrap.mjs';

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
    expect(serialized).not.toContain('/Users/test');
    expect(serialized).not.toContain('openchamber-home');
  });

  test('allows only exact packaged/local/sidecar origins and isolates window config', () => {
    const allowed = {
      localOrigin: 'http://127.0.0.1:3901',
      sidecarUrl: 'http://127.0.0.1:57123',
    };
    const first = { apiBaseUrl: 'https://one.example', clientToken: 'one', requestHeaders: { 'CF-Access-Client-Secret': 'header-one' }, relayHostId: 'host-one', privateJwk: { d: 'secret' }, unknown: 'strip' };
    const second = { apiBaseUrl: 'https://two.example', clientToken: 'two', requestHeaders: {}, relayHostId: 'host-two' };

    expect(resolveRuntimeBootstrap('openchamber-ui://app/index.html', first, allowed)).toEqual({
      apiBaseUrl: 'https://one.example', clientToken: 'one', requestHeaders: { 'CF-Access-Client-Secret': 'header-one' }, relayHostId: 'host-one', homeDirectory: '',
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

  test('returns home path only through sender-validated bootstrap', () => {
    const allowed = { localOrigin: 'http://127.0.0.1:3901' };
    const config = { homeDirectory: '/Users/private', clientToken: 'secret' };
    expect(resolveRuntimeBootstrap('http://127.0.0.1:3901/', config, allowed)?.homeDirectory).toBe('/Users/private');
    expect(resolveRuntimeBootstrap('https://malicious.example/', config, allowed)).toBeNull();
  });

  test('builds credential-free boot metadata without renderer-side URL authorization', () => {
    const script = buildRuntimeBootMetadataScript({
      macosMajor: 15,
      bootOutcome: { target: 'local', status: 'ok' },
      apiBaseUrl: 'https://remote.example',
      clientToken: 'bearer-secret',
      requestHeaders: { Authorization: 'Bearer header-secret' },
      homeDirectory: '/Users/private',
      relayHostId: 'relay-secret-id',
    });
    expect(script).toContain('__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__');
    expect(script).not.toContain('bearer-secret');
    expect(script).not.toContain('header-secret');
    expect(script).not.toContain('/Users/private');
    expect(script).not.toContain('relay-secret-id');
    expect(script).not.toContain('window.URL');
    expect(script).not.toContain('new URL');
  });

  test('main authorizes the committed webContents URL before metadata execution', () => {
    const allowed = { localOrigin: 'http://127.0.0.1:3901', sidecarUrl: 'http://127.0.0.1:57123' };
    expect(isRuntimeBootstrapSenderAllowed('http://127.0.0.1:3901/', allowed)).toBe(true);
    expect(isRuntimeBootstrapSenderAllowed('https://malicious.example/', allowed)).toBe(false);

    const mainSource = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
    expect(mainSource).not.toContain('injectRuntimeConfigIntoHtml');
    expect(mainSource).not.toContain('__OPENCHAMBER_CLIENT_TOKEN__');
    expect(mainSource).not.toContain('__OPENCHAMBER_RUNTIME_HEADERS__');
    expect(mainSource).toContain('isRuntimeBootstrapSenderAllowed(browserWindow.webContents.getURL()');
  });
});
