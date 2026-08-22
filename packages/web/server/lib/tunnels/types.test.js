import { describe, expect, it } from 'bun:test';

import {
  isPathWithinDirectory,
  normalizeTailscaleHttpsPort,
  normalizeTunnelStartRequest,
  resolveTunnelConfigPath,
  validateTunnelStartRequest,
} from './types.js';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TAILSCALE_DEFAULT_HTTPS_PORT,
  TUNNEL_PROVIDER_TAILSCALE,
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


describe('tunnel provider defaults', () => {
  it('defaults Tailscale to private-network intent', () => {
    const request = normalizeTunnelStartRequest({ provider: TUNNEL_PROVIDER_TAILSCALE });

    expect(request.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(request.intent).toBe(TUNNEL_INTENT_PRIVATE_NETWORK);
    expect(request.tailscaleHttpsPort).toBe(443);
    expect(normalizeTunnelStartRequest({ provider: TUNNEL_PROVIDER_TAILSCALE, tailscaleHttpsPort: '8443' }).tailscaleHttpsPort).toBe(8443);
  });


  it('normalizes Tailscale Serve frontend ports across the full TCP range', () => {
    expect(normalizeTailscaleHttpsPort()).toBe(TAILSCALE_DEFAULT_HTTPS_PORT);
    expect(normalizeTailscaleHttpsPort('9443')).toBe(9443);
    expect(normalizeTailscaleHttpsPort(65535)).toBe(65535);
    expect(normalizeTailscaleHttpsPort(0)).toBeNull();
    expect(normalizeTailscaleHttpsPort(65536)).toBeNull();
    expect(normalizeTailscaleHttpsPort('9443.5')).toBeNull();
    expect(normalizeTailscaleHttpsPort(9443.5)).toBeNull();
  });

  it('restricts Tailscale Funnel frontend ports independently of Serve', () => {
    const capabilities = {
      provider: TUNNEL_PROVIDER_TAILSCALE,
      modes: [
        { key: TUNNEL_MODE_PRIVATE_NETWORK, intent: TUNNEL_INTENT_PRIVATE_NETWORK },
        { key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC },
      ],
    };

    expect(() => validateTunnelStartRequest(normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      tailscaleHttpsPort: 9443,
    }), capabilities)).not.toThrow();
    expect(() => validateTunnelStartRequest(normalizeTunnelStartRequest({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_QUICK,
      tailscaleHttpsPort: 9443,
    }), capabilities)).toThrow(/Tailscale Funnel HTTPS frontend port must be 443, 8443, or 10000/);
  });
});
});
