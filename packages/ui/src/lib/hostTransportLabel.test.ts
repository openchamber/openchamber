import { describe, expect, test } from 'bun:test';
import { hostTransportLabelKey, type HostTransportLabelKey } from './hostTransportLabel';
import type { DesktopHost } from './desktopHosts';

describe('hostTransportLabelKey', () => {
  describe('direct-E2EE-only hosts', () => {
    test('resolves to managed direct-E2EE label', () => {
      const host: DesktopHost = {
        id: 'e2ee-1',
        label: 'Remote E2EE',
        url: 'wss://example.com/e2ee',
        directE2ee: {
          wssUrl: 'wss://example.com/e2ee',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
        },
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBe('settings.remoteInstances.clientAuth.state.viaManagedDirectE2ee');
    });
  });

  describe('relay-only hosts', () => {
    test('resolves to relay label', () => {
      const host: DesktopHost = {
        id: 'relay-1',
        label: 'Relay Host',
        url: 'relay://server-id-123',
        relay: {
          relayUrl: 'wss://relay.openchamber.dev/ws',
          serverId: 'server-id-123',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
        },
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBe('settings.remoteInstances.clientAuth.state.viaRelay');
    });
  });

  describe('malformed hosts (defensive: both transports present)', () => {
    test('prefers direct-E2EE label, never displays Relay', () => {
      const host: DesktopHost = {
        id: 'malformed-1',
        label: 'Malformed',
        url: 'wss://example.com/e2ee',
        directE2ee: {
          wssUrl: 'wss://example.com/e2ee',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
        },
        relay: {
          relayUrl: 'wss://relay.openchamber.dev/ws',
          serverId: 'server-id-456',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
        },
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBe('settings.remoteInstances.clientAuth.state.viaManagedDirectE2ee');
    });
  });

  describe('direct-only hosts', () => {
    test('returns null (no special label needed)', () => {
      const host: DesktopHost = {
        id: 'direct-1',
        label: 'Local Server',
        url: 'http://localhost:3000',
        apiUrl: 'http://localhost:3000',
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBeNull();
    });

    test('returns null for remote direct host without relay/E2EE', () => {
      const host: DesktopHost = {
        id: 'direct-2',
        label: 'Remote Direct',
        url: 'http://192.168.1.100:3000',
        apiUrl: 'http://192.168.1.100:3000',
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBeNull();
    });
  });

  describe('type contract', () => {
    test('returns valid HostTransportLabelKey type', () => {
      const directE2eeHost: DesktopHost = {
        id: '1',
        label: 'E2EE',
        url: 'wss://test',
        directE2ee: {
          wssUrl: 'wss://test',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        },
      };

      const result: HostTransportLabelKey = hostTransportLabelKey(directE2eeHost);
      expect(result).toBeDefined();
    });

    test('returns null for direct-only host (type-safe)', () => {
      const directHost: DesktopHost = {
        id: '1',
        label: 'Direct',
        url: 'http://localhost:3000',
        apiUrl: 'http://localhost:3000',
      };

      const result: HostTransportLabelKey = hostTransportLabelKey(directHost);
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    test('handles host with only apiUrl (direct-only)', () => {
      const host: DesktopHost = {
        id: 'edge-1',
        label: 'API Only',
        url: 'http://example.com',
        apiUrl: 'http://example.com:3000',
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBeNull();
    });

    test('handles host with clientToken but no special transport', () => {
      const host: DesktopHost = {
        id: 'edge-2',
        label: 'With Token',
        url: 'http://example.com',
        apiUrl: 'http://example.com:3000',
        clientToken: 'token-abc123',
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBeNull();
    });

    test('handles host with requestHeaders but no special transport', () => {
      const host: DesktopHost = {
        id: 'edge-3',
        label: 'With Headers',
        url: 'http://example.com',
        apiUrl: 'http://example.com:3000',
        requestHeaders: { 'X-Custom': 'value' },
      };

      const result = hostTransportLabelKey(host);
      expect(result).toBeNull();
    });
  });
});
