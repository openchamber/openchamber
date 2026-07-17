import { describe, expect, test } from 'bun:test';

import { buildStoredHostEntry } from './host-storage-sanitizer.mjs';

const dependencies = {
  localHostId: 'local',
  sanitizeHostUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  },
  sanitizeClientToken(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  },
  sanitizeRequestHeaders() {
    return {};
  },
};

const descriptor = {
  wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y', d: 'PRIVATE', unknown: true },
};
const relay = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'server-1',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'relay-x', y: 'relay-y', d: 'PRIVATE', unknown: true },
};

describe('Electron host storage sanitization', () => {
  test('retains only the direct public descriptor and bearer token', () => {
    const stored = buildStoredHostEntry({
      id: 'host-1',
      label: 'Host',
      clientToken: ' oc_client_token ',
      pairingSecret: 'one-time-secret',
      secret: 'also-secret',
      directE2ee: descriptor,
    }, dependencies);
    expect(stored).toEqual({
      id: 'host-1',
      label: 'Host',
      url: 'direct-e2ee://host.example',
      clientToken: 'oc_client_token',
      directE2ee: {
        wssUrl: descriptor.wssUrl,
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      },
    });
    expect(JSON.stringify(stored)).not.toContain('one-time-secret');
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
  });

  test('rejects credentials, query, fragment, wrong path, non-WSS, and malformed keys', () => {
    const unsafe = [
      'wss://user:pass@host.example/api/openchamber/direct-e2ee/ws',
      'wss://host.example/api/openchamber/direct-e2ee/ws?token=x',
      'wss://host.example/api/openchamber/direct-e2ee/ws#fragment',
      'wss://host.example/wrong',
      'ws://host.example/api/openchamber/direct-e2ee/ws',
    ];
    for (const wssUrl of unsafe) {
      expect(buildStoredHostEntry({ id: 'host', label: 'Host', directE2ee: { ...descriptor, wssUrl } }, dependencies)).toBeNull();
    }
    expect(buildStoredHostEntry({
      id: 'host',
      label: 'Host',
      directE2ee: { ...descriptor, hostEncPubJwk: { kty: 'EC', crv: 'P-384', x: 'x', y: 'y' } },
    }, dependencies)).toBeNull();
  });

  test('preserves relay and direct E2EE together without fabricating HTTP', () => {
    expect(buildStoredHostEntry({ id: 'host', directE2ee: descriptor, relay }, dependencies)).toEqual({
      id: 'host',
      label: 'direct-e2ee://host.example',
      url: 'direct-e2ee://host.example',
      directE2ee: {
        wssUrl: descriptor.wssUrl,
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      },
      relay: {
        relayUrl: relay.relayUrl,
        serverId: relay.serverId,
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'relay-x', y: 'relay-y' },
      },
    });
  });

  test('preserves all three independent transport legs', () => {
    const stored = buildStoredHostEntry({
      id: 'host',
      url: 'https://lan.example',
      apiUrl: 'https://api.example',
      directE2ee: descriptor,
      relay,
    }, dependencies);
    expect(stored?.url).toBe('https://lan.example');
    expect(stored?.apiUrl).toBe('https://api.example');
    expect(stored?.directE2ee).toBeDefined();
    expect(stored?.relay).toBeDefined();
  });

  test('uses only the direct URL origin for fallback labels without changing stored transport URLs', () => {
    const urls = [
      'https://user:password@host.example:8443/custom/path-token?token=query-secret#fragment-secret',
      'https://host.example/path-secret',
      'https://host.example?query-secret=yes',
      'https://host.example/#fragment-secret',
    ];
    for (const url of urls) {
      const stored = buildStoredHostEntry({ id: `host-${urls.indexOf(url)}`, url, apiUrl: `${url}/api` }, dependencies);
      expect(stored?.label).toBe(new URL(url).origin);
      expect(stored?.url).toBe(url);
      expect(stored?.apiUrl).toBe(`${url}/api`);
      expect(stored?.label).not.toMatch(/user|password|token|secret|query|fragment|\/custom|\/path/i);
    }
    expect(buildStoredHostEntry({ id: 'friendly', label: 'Friendly workstation', url: urls[0] }, dependencies)?.label).toBe('Friendly workstation');
  });

  test('drops only a malformed leg and keeps the other valid descriptors', () => {
    const stored = buildStoredHostEntry({
      id: 'host',
      url: 'not-http',
      directE2ee: { ...descriptor, wssUrl: 'ws://unsafe.example/wrong' },
      relay,
    }, dependencies);
    expect(stored).toEqual({
      id: 'host',
      label: 'relay://server-1',
      url: 'relay://server-1',
      relay: {
        relayUrl: relay.relayUrl,
        serverId: relay.serverId,
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'relay-x', y: 'relay-y' },
      },
    });
  });
});
