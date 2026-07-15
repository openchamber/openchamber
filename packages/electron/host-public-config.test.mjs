import { describe, expect, test } from 'bun:test';

import { resolveDesktopHostsForSender } from './host-public-config.mjs';

const fullConfig = {
  hosts: [{
    id: 'host-one', label: 'Remote', url: 'https://user:pass@remote.example/path?token=secret#fragment', apiUrl: 'https://remote.example/api?key=secret',
    clientToken: 'bearer-secret', requestHeaders: { Authorization: 'Bearer secret', 'CF-Access-Client-Secret': 'secret' }, pairingSecret: 'pairing-secret',
    relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-one', grant: 'grant-secret', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry', d: 'private', unknown: 'strip' } },
    directE2ee: { wssUrl: 'wss://direct.example/api/openchamber/direct-e2ee/ws', pairing: { secret: 'nested' }, hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'dx', y: 'dy', d: 'private' } },
    unknown: { clientToken: 'nested-secret' },
  }],
  defaultHostId: 'host-one', initialHostChoiceCompleted: true, localClientToken: 'local-secret', privateJwk: { d: 'private' }, localOrigin: 'http://127.0.0.1:3901',
};
const allowed = { localOrigin: 'http://127.0.0.1:3901', sidecarUrl: 'http://127.0.0.1:57123' };

describe('desktop host public config', () => {
  test('returns the exact full config only to exact local senders', () => {
    expect(resolveDesktopHostsForSender('http://127.0.0.1:3901/settings', fullConfig, allowed)).toBe(fullConfig);
    expect(resolveDesktopHostsForSender('openchamber-ui://app/index.html', fullConfig, allowed)).toBe(fullConfig);
  });

  test('redacts hostile remote callers and strips nested unknown credential fields', () => {
    for (const sender of ['https://evil.example/path', 'http://127.0.0.1:3901.evil.example/path']) {
      const result = resolveDesktopHostsForSender(sender, fullConfig, allowed);
      expect(result).toEqual({
        hosts: [{
          id: 'host-one', label: 'Remote', url: 'https://remote.example/path', apiUrl: 'https://remote.example/api',
          relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-one', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } },
          directE2ee: { wssUrl: 'wss://direct.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'dx', y: 'dy' } },
        }],
        defaultHostId: 'host-one', initialHostChoiceCompleted: true, localOrigin: 'http://127.0.0.1:3901',
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|clientToken|requestHeaders|grant|privateJwk|"d"/i);
    }
  });

  test('uses only the supplied window config without crossing per-window host state', () => {
    const other = { ...fullConfig, hosts: [{ id: 'host-two', label: 'Two', url: 'https://two.example', clientToken: 'two-secret' }] };
    expect(resolveDesktopHostsForSender('https://evil.example/path', other, allowed).hosts).toEqual([
      { id: 'host-two', label: 'Two', url: 'https://two.example' },
    ]);
  });

  test('reduces URL-shaped labels to origins while preserving safe labels and transport paths', () => {
    const result = resolveDesktopHostsForSender('https://evil.example/path', {
      hosts: [
        {
          id: 'url-label',
          label: 'https://user:password@remote.example:8443/custom/path-token?token=query-secret#fragment-secret',
          url: 'https://user:password@remote.example:8443/custom/base?token=query-secret#fragment-secret',
          apiUrl: 'https://api-user:api-password@remote.example:8443/custom/base/api?key=query-secret#fragment-secret',
        },
        { id: 'friendly', label: 'Friendly workstation', url: 'https://friendly.example/custom/base' },
        { id: 'relay', label: 'relay://server-one', relay: fullConfig.hosts[0].relay },
      ],
      defaultHostId: 'url-label',
    }, allowed);

    expect(result.hosts).toEqual([
      {
        id: 'url-label',
        label: 'https://remote.example:8443',
        url: 'https://remote.example:8443/custom/base',
        apiUrl: 'https://remote.example:8443/custom/base/api',
      },
      { id: 'friendly', label: 'Friendly workstation', url: 'https://friendly.example/custom/base' },
      {
        id: 'relay',
        label: 'relay://server-one',
        relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-one', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } },
      },
    ]);
    expect(result.defaultHostId).toBe('url-label');
    expect(JSON.stringify(result)).not.toMatch(/password|path-token|query-secret|fragment-secret/i);
  });

  test('preserves a normalized default only when its redacted host survives', () => {
    const result = resolveDesktopHostsForSender('https://evil.example/path', {
      ...fullConfig,
      defaultHostId: ' host-one ',
    }, allowed);
    expect(result.defaultHostId).toBe('host-one');
  });

  test('clears defaults for filtered or missing hosts and preserves null', () => {
    const cases = [
      {
        config: { hosts: [{ id: 'filtered', label: 'Filtered' }], defaultHostId: 'filtered' },
        expectedHosts: [],
      },
      {
        config: { hosts: fullConfig.hosts, defaultHostId: 'missing' },
        expectedHosts: [{
          id: 'host-one', label: 'Remote', url: 'https://remote.example/path', apiUrl: 'https://remote.example/api',
          relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-one', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } },
          directE2ee: { wssUrl: 'wss://direct.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'dx', y: 'dy' } },
        }],
      },
      {
        config: { hosts: fullConfig.hosts, defaultHostId: null },
        expectedHosts: [{
          id: 'host-one', label: 'Remote', url: 'https://remote.example/path', apiUrl: 'https://remote.example/api',
          relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-one', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } },
          directE2ee: { wssUrl: 'wss://direct.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'dx', y: 'dy' } },
        }],
      },
    ];

    for (const { config, expectedHosts } of cases) {
      const result = resolveDesktopHostsForSender('https://evil.example/path', config, allowed);
      expect(result.hosts).toEqual(expectedHosts);
      expect(result.defaultHostId).toBeNull();
    }
  });
});
