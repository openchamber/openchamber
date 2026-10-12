import { describe, expect, it } from 'bun:test';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_TAILSCALE,
  isPathWithinDirectory,
  normalizeTailscaleHttpsPort,
  normalizeTunnelStartRequest,
  resolveTunnelConfigPath,
  validateTunnelStartRequest,
} from './types.js';

describe('tunnel config path normalization', () => {
  it('allows Windows home paths with different drive casing', () => {
    expect(isPathWithinDirectory(
      'c:\\Users\\Bohdan\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(true);
  });

  it('does not allow Windows sibling home directories', () => {
    expect(isPathWithinDirectory(
      'C:\\Users\\Bohdan2\\.cloudflared\\config.yml',
      'C:\\Users\\Bohdan',
      'win32'
    )).toBe(false);
  });

  it('resolves Windows tilde paths inside the provided home directory', () => {
    expect(resolveTunnelConfigPath('~\\.cloudflared\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toBe('C:\\Users\\Bohdan\\.cloudflared\\config.yml');
  });

  it('rejects Windows paths outside the provided home directory', () => {
    expect(() => resolveTunnelConfigPath('C:\\Temp\\config.yml', 'C:\\Users\\Bohdan', 'win32'))
      .toThrow(/Config path must be within the home directory/);
  });
});

describe('Tailscale tunnel types and port normalization', () => {
  it('normalizes valid Tailscale HTTPS ports and rejects out-of-range or malformed values', () => {
    expect(normalizeTailscaleHttpsPort()).toBe(443);
    expect(normalizeTailscaleHttpsPort(undefined)).toBe(443);
    expect(normalizeTailscaleHttpsPort(443)).toBe(443);
    expect(normalizeTailscaleHttpsPort(8443)).toBe(8443);
    expect(normalizeTailscaleHttpsPort('9443')).toBe(9443);
    expect(normalizeTailscaleHttpsPort(65535)).toBe(65535);
    expect(normalizeTailscaleHttpsPort(1)).toBe(1);

    expect(normalizeTailscaleHttpsPort(0)).toBeNull();
    expect(normalizeTailscaleHttpsPort(65536)).toBeNull();
    expect(normalizeTailscaleHttpsPort(-1)).toBeNull();
    expect(normalizeTailscaleHttpsPort('invalid')).toBeNull();
    expect(normalizeTailscaleHttpsPort(443.5)).toBeNull();
  });

  it('normalizes Tailscale start requests defaulting mode to private-network', () => {
    const request = normalizeTunnelStartRequest({ provider: TUNNEL_PROVIDER_TAILSCALE });
    expect(request.provider).toBe(TUNNEL_PROVIDER_TAILSCALE);
    expect(request.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(request.intent).toBe(TUNNEL_INTENT_PRIVATE_NETWORK);
    expect(request.tailscaleHttpsPort).toBe(443);
  });

  it('validates Tailscale Serve and Funnel port rules against capabilities', () => {
    const capabilities = {
      provider: TUNNEL_PROVIDER_TAILSCALE,
      modes: [
        { key: TUNNEL_MODE_PRIVATE_NETWORK, intent: TUNNEL_INTENT_PRIVATE_NETWORK },
        { key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC },
      ],
    };

    // Serve accepts arbitrary valid ports 1-65535
    expect(() => validateTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      intent: TUNNEL_INTENT_PRIVATE_NETWORK,
      tailscaleHttpsPort: 9443,
    }, capabilities)).not.toThrow();

    // Serve rejects invalid port
    expect(() => validateTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      intent: TUNNEL_INTENT_PRIVATE_NETWORK,
      tailscaleHttpsPort: 0,
    }, capabilities)).toThrow(/integer from 1 to 65535/);

    // Funnel accepts only 443, 8443, 10000
    expect(() => validateTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_QUICK,
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      tailscaleHttpsPort: 8443,
    }, capabilities)).not.toThrow();

    // Funnel rejects non-allowlisted port
    expect(() => validateTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_QUICK,
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      tailscaleHttpsPort: 9443,
    }, capabilities)).toThrow(/must be 443, 8443, or 10000/);
  });
});

