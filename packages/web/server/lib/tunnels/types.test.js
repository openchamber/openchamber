import { describe, expect, it } from 'bun:test';

import {
  isPathWithinDirectory,
  normalizeTunnelStartRequest,
  resolveTunnelConfigPath,
  validateTunnelStartRequest,
} from './types.js';
import { cloudflareTunnelProviderCapabilities } from './providers/cloudflare.js';
import { tailscaleTunnelProviderCapabilities } from './providers/tailscale.js';

describe('tunnel HTTPS port', () => {
  const validate = (input, capabilities = tailscaleTunnelProviderCapabilities) => () => (
    validateTunnelStartRequest(normalizeTunnelStartRequest(input), capabilities)
  );

  it('leaves the port to the provider when none is given', () => {
    expect(normalizeTunnelStartRequest({ provider: 'tailscale', mode: 'serve' }).httpsPort).toBeUndefined();
    expect(validate({ provider: 'tailscale', mode: 'serve' })).not.toThrow();
  });

  it('accepts a port the mode lists, as a number or a string', () => {
    expect(validate({ provider: 'tailscale', mode: 'funnel', httpsPort: 8443 })).not.toThrow();
    expect(validate({ provider: 'tailscale', mode: 'serve', httpsPort: '10000' })).not.toThrow();
  });

  it('refuses a port outside the list and anything that is not a whole number', () => {
    expect(validate({ provider: 'tailscale', mode: 'funnel', httpsPort: 9443 })).toThrow('HTTPS port must be one of 443, 8443, 10000');
    expect(validate({ provider: 'tailscale', mode: 'serve', httpsPort: '443abc' })).toThrow('HTTPS port must be one of 443, 8443, 10000');
  });

  it('refuses a port for a mode that takes none', () => {
    expect(validate({ provider: 'cloudflare', mode: 'quick', httpsPort: 443 }, cloudflareTunnelProviderCapabilities))
      .toThrow("Provider 'cloudflare' does not take an HTTPS port");
  });
});

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
