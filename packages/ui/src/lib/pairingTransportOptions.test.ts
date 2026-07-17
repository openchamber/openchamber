import { describe, test, expect } from 'bun:test';
import { resolvePairingTransportRequest, setAddDeviceIntent, consumeAddDeviceIntent, selectPairingTransport } from './pairingTransportOptions';

describe('Pairing Transport Options', () => {
  test('resolves managed-e2ee exclusively even when LAN and relay are available', () => {
    const result = resolvePairingTransportRequest('managed-e2ee', { lanUrl: 'http://192.168.1.10:4096', addDeviceFallback: true, relayAvailable: true });

    expect(result.serverUrl).toBe(undefined);
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(true);
  });

  test('resolves managed-e2ee with LAN and relay unchecked', () => {
    const result = resolvePairingTransportRequest('managed-e2ee', { lanUrl: 'http://192.168.1.10:4096', addDeviceFallback: false, relayAvailable: true });

    expect(result.serverUrl).toBe(undefined);
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(true);
  });

  test('resolves managed-e2ee without relay when no LAN and fallback is checked', () => {
    const result = resolvePairingTransportRequest('managed-e2ee', { addDeviceFallback: true, relayAvailable: true });

    expect(result.serverUrl).toBe(undefined);
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(true);
  });

  test('resolves managed-e2ee with no LAN and relay unchecked', () => {
    const result = resolvePairingTransportRequest('managed-e2ee', { addDeviceFallback: false, relayAvailable: true });

    expect(result.serverUrl).toBe(undefined);
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(true);
  });

  test('resolves managed-e2ee with relay unavailable ignores checked', () => {
    const result = resolvePairingTransportRequest('managed-e2ee', { addDeviceFallback: true, relayAvailable: false });

    expect(result.serverUrl).toBe(undefined);
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(true);
  });

  test('preserves existing relay-only behavior', () => {
    const result = resolvePairingTransportRequest('relay', {});

    expect(result.includeRelay).toBe(true);
    expect(result.includeDirect).toBe(false);
    expect(result.includeDirectE2ee).toBe(false);
  });

  test('resolves local transport correctly', () => {
    const result = resolvePairingTransportRequest('local', { localUrl: 'http://127.0.0.1:4096' });

    expect(result.serverUrl).toBe('http://127.0.0.1:4096');
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(true);
    expect(result.includeDirectE2ee).toBe(false);
  });

  test('resolves lan transport correctly with fallback', () => {
    const result = resolvePairingTransportRequest('lan', { lanUrl: 'http://192.168.1.10:4096', addDeviceFallback: true });

    expect(result.serverUrl).toBe('http://192.168.1.10:4096');
    expect(result.includeRelay).toBe(true);
    expect(result.includeDirect).toBe(true);
    expect(result.includeDirectE2ee).toBe(false);
  });

  test('resolves lan transport correctly without fallback', () => {
    const result = resolvePairingTransportRequest('lan', { lanUrl: 'http://192.168.1.10:4096', addDeviceFallback: false });

    expect(result.serverUrl).toBe('http://192.168.1.10:4096');
    expect(result.includeRelay).toBe(false);
    expect(result.includeDirect).toBe(true);
    expect(result.includeDirectE2ee).toBe(false);
  });

  test('resolves relay transport with lan fallback correctly', () => {
    const result = resolvePairingTransportRequest('relay', { lanUrl: 'http://192.168.1.10:4096', addDeviceFallback: true });

    expect(result.serverUrl).toBe('http://192.168.1.10:4096');
    expect(result.includeRelay).toBe(true);
    expect(result.includeDirect).toBe(true);
    expect(result.includeDirectE2ee).toBe(false);
  });

  test('consumes an immediate intent exactly once', () => {
    setAddDeviceIntent(null);
    setAddDeviceIntent('managed-e2ee', () => 1_000);
    expect(consumeAddDeviceIntent(() => 1_001)).toBe('managed-e2ee');
    expect(consumeAddDeviceIntent(() => 1_002)).toBe(null);
  });

  test('expires stale intent and clears it when explicitly requested', () => {
    setAddDeviceIntent('managed-e2ee', () => 1_000);
    expect(consumeAddDeviceIntent(() => 31_000)).toBe(null);
    setAddDeviceIntent('managed-e2ee', () => 40_000);
    setAddDeviceIntent(null);
    expect(consumeAddDeviceIntent(() => 40_001)).toBe(null);
  });

  describe('selectPairingTransport', () => {
    test('returns managed-e2ee when preferred and available', () => {
      expect(selectPairingTransport('managed-e2ee', { directE2eeAvailable: true, relayAvailable: true })).toBe('managed-e2ee');
    });

    test('falls back to lan when managed-e2ee preferred but unavailable', () => {
      expect(selectPairingTransport('managed-e2ee', { directE2eeAvailable: false, relayAvailable: true, lanUrl: 'http://lan' })).toBe('lan');
    });

    test('falls back to local when managed-e2ee preferred but unavailable and no lan', () => {
      expect(selectPairingTransport('managed-e2ee', { directE2eeAvailable: false, relayAvailable: true, localUrl: 'http://local' })).toBe('local');
    });

    test('returns relay when no preference', () => {
      expect(selectPairingTransport(null, { directE2eeAvailable: true, relayAvailable: true })).toBe('relay');
    });
  });
});
