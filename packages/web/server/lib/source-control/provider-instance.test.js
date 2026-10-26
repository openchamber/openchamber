import { describe, expect, it } from 'vitest';
import { normalizeSourceControlProviderInstance } from './provider-instance.js';

describe('normalizeSourceControlProviderInstance', () => {
  it('keeps a plain hostname', () => {
    expect(normalizeSourceControlProviderInstance('github', 'github.com')).toBe('github.com');
    expect(normalizeSourceControlProviderInstance('github', 'ghe.example.com')).toBe('ghe.example.com');
  });

  it('accepts an https origin without a path, credentials, port, query or hash', () => {
    expect(normalizeSourceControlProviderInstance('github', 'HTTPS://GHE.Example.com/')).toBe('ghe.example.com');
  });

  it('rejects an https origin with a path, credentials, port, query or hash', () => {
    expect(() => normalizeSourceControlProviderInstance('github', 'https://ghe.example.com/api/v3')).toThrow('GitHub instance must be an HTTPS origin');
    expect(() => normalizeSourceControlProviderInstance('github', 'https://user@example.com')).toThrow('GitHub instance must be an HTTPS origin');
    expect(() => normalizeSourceControlProviderInstance('github', 'https://example.com:8443')).toThrow('GitHub instance must be an HTTPS origin');
  });

  it('rejects a scheme-less value that cannot form an https origin instead of throwing a TypeError at the caller', () => {
    expect(() => normalizeSourceControlProviderInstance('github', 'git hub.com')).toThrow('GitHub instance must be an HTTPS origin');
  });
});
