import { describe, expect, test } from 'bun:test';

import { parseTailscaleHttpsPort, tailscaleHttpsPortFor } from './tailscaleHttpsPort';

describe('Tailscale HTTPS ports', () => {
  test('accepts only integer ports from 1 to 65535', () => {
    expect(parseTailscaleHttpsPort('1')).toBe(1);
    expect(parseTailscaleHttpsPort(65535)).toBe(65535);
    expect(parseTailscaleHttpsPort('8443')).toBe(8443);
    expect(parseTailscaleHttpsPort('')).toBeNull();
    expect(parseTailscaleHttpsPort(0)).toBeNull();
    expect(parseTailscaleHttpsPort(65536)).toBeNull();
    expect(parseTailscaleHttpsPort(1.5)).toBeNull();
  });

  test('keeps Serve custom ports but normalizes unsupported Funnel ports', () => {
    expect(tailscaleHttpsPortFor('tailscale', 'private-network', 12345)).toBe(12345);
    expect(tailscaleHttpsPortFor('tailscale', 'quick', 8443)).toBe(8443);
    expect(tailscaleHttpsPortFor('tailscale', 'quick', 12345)).toBe(443);
    expect(tailscaleHttpsPortFor('tailscale', 'quick', undefined)).toBe(443);
  });

  test('omits the setting for other providers', () => {
    expect(tailscaleHttpsPortFor('cloudflare', 'quick', 443)).toBe(undefined);
  });
});
