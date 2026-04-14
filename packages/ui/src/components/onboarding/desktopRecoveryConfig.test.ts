import { describe, expect, test } from 'bun:test';
import { getDesktopRecoveryConfig } from './desktopRecoveryConfig';

describe('getDesktopRecoveryConfig', () => {
  // ---------------------------------------------------------------------------
  // 1. local-unavailable: both actions visible + retry labeled "Retry Local"
  // ---------------------------------------------------------------------------
  test('local-unavailable exposes both actions and Retry Local', () => {
    const config = getDesktopRecoveryConfig('local-unavailable');

    expect(config.title).toBe('Local OpenCode Unavailable');
    expect(config.iconKey).toBe('local');
    expect(config.showRetry).toBe(true);
    expect(config.retryLabel).toBe('Retry Local');
    expect(config.showUseLocal).toBe(true);
    expect(config.showUseRemote).toBe(true);
    // local-unavailable uses setup-oriented label since local needs installing
    expect(config.useLocalLabel).toBe('Set Up Local');
    expect(config.useRemoteLabel).toBe('Use Remote');
  });

  // ---------------------------------------------------------------------------
  // 2. remote-unreachable: both actions + retry
  // ---------------------------------------------------------------------------
  test('remote-unreachable exposes both actions + retry', () => {
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      'My Server',
      'https://example.com:4096',
    );

    expect(config.title).toBe('Remote Server Unreachable');
    expect(config.iconKey).toBe('remote');
    expect(config.showRetry).toBe(true);
    expect(config.retryLabel).toBe('Retry Connection');
    expect(config.showUseLocal).toBe(true);
    expect(config.showUseRemote).toBe(true);
    // remote variants keep standard "Use Local"
    expect(config.useLocalLabel).toBe('Use Local');
    expect(config.useRemoteLabel).toBe('Use Remote');
  });

  // ---------------------------------------------------------------------------
  // 3. remote-wrong-service: both actions, NO retry
  // ---------------------------------------------------------------------------
  test('remote-wrong-service exposes both actions and no retry', () => {
    const config = getDesktopRecoveryConfig(
      'remote-wrong-service',
      'Bad Host',
      'https://wrong.example.com',
    );

    expect(config.title).toBe('Incompatible Server');
    expect(config.iconKey).toBe('remote');
    expect(config.showRetry).toBe(false);
    expect(config.retryLabel).toBe(undefined);
    expect(config.showUseLocal).toBe(true);
    expect(config.showUseRemote).toBe(true);
    expect(config.useLocalLabel).toBe('Use Local');
    expect(config.useRemoteLabel).toBe('Use Remote');
  });

  // ---------------------------------------------------------------------------
  // 4. missing-default-host: chooser-with-context (both actions, no retry)
  // ---------------------------------------------------------------------------
  test('missing-default-host behaves like chooser-with-context', () => {
    const config = getDesktopRecoveryConfig('missing-default-host');

    expect(config.title).toBe('No Default Connection');
    expect(config.iconKey).toBe('local');
    expect(config.showRetry).toBe(false);
    expect(config.retryLabel).toBe(undefined);
    expect(config.showUseLocal).toBe(true);
    expect(config.showUseRemote).toBe(true);
    expect(config.useLocalLabel).toBe('Use Local');
    expect(config.useRemoteLabel).toBe('Use Remote');
  });

  // ---------------------------------------------------------------------------
  // 5. descriptions redact sensitive query params for remote variants
  // ---------------------------------------------------------------------------
  test('remote-unreachable description redacts sensitive query params in URL', () => {
    const sensitiveUrl =
      'https://example.com:4096?token=super-secret&auth=abc123';
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      undefined,
      sensitiveUrl,
    );

    // Secrets must never appear in the description
    expect(config.description).not.toContain('super-secret');
    expect(config.description).not.toContain('abc123');
    // Redaction marker is present
    expect(config.description).toContain('REDACTED');
    expect(config.description).toContain('example.com');
  });

  test('remote-wrong-service description redacts sensitive query params in URL', () => {
    const sensitiveUrl =
      'https://wrong.example.com?api_key=sk-12345&secret=mysecret';
    const config = getDesktopRecoveryConfig(
      'remote-wrong-service',
      undefined,
      sensitiveUrl,
    );

    // Secrets must never appear in the description
    expect(config.description).not.toContain('sk-12345');
    expect(config.description).not.toContain('mysecret');
    // Redaction marker is present
    expect(config.description).toContain('REDACTED');
    expect(config.description).toContain('wrong.example.com');
  });

  test('local-unavailable description does not reference host URL', () => {
    const config = getDesktopRecoveryConfig(
      'local-unavailable',
      'Some Host',
      'https://example.com?token=secret',
    );

    // local-unavailable ignores hostUrl in its description
    expect(config.description).not.toContain('example.com');
    expect(config.description).not.toContain('secret');
  });

  test('missing-default-host description does not reference host URL', () => {
    const config = getDesktopRecoveryConfig(
      'missing-default-host',
      'Some Host',
      'https://example.com?token=secret',
    );

    expect(config.description).not.toContain('example.com');
    expect(config.description).not.toContain('secret');
  });

  // ---------------------------------------------------------------------------
  // 6. URL-like hostLabel is also redacted (sensitive data leak prevention)
  // ---------------------------------------------------------------------------
  test('remote-unreachable redacts URL-like hostLabel containing sensitive query params', () => {
    const urlAsLabel =
      'https://example.com:4096?token=super-secret&auth=abc123';
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      urlAsLabel,
      'https://fallback.example.com',
    );

    // Secrets in hostLabel must never appear in the description
    expect(config.description).not.toContain('super-secret');
    expect(config.description).not.toContain('abc123');
    // Redaction marker is present
    expect(config.description).toContain('REDACTED');
    expect(config.description).toContain('example.com');
  });

  test('remote-wrong-service redacts URL-like hostLabel containing sensitive query params', () => {
    const urlAsLabel =
      'https://wrong.example.com?api_key=sk-12345&secret=mysecret';
    const config = getDesktopRecoveryConfig(
      'remote-wrong-service',
      urlAsLabel,
      'https://fallback.example.com',
    );

    // Secrets in hostLabel must never appear in the description
    expect(config.description).not.toContain('sk-12345');
    expect(config.description).not.toContain('mysecret');
    // Redaction marker is present
    expect(config.description).toContain('REDACTED');
    expect(config.description).toContain('wrong.example.com');
  });

  test('remote-unreachable redacts embedded credentials in URL-like hostLabel', () => {
    const urlWithCreds = 'https://admin:s3cret@example.com:4096';
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      urlWithCreds,
      'https://fallback.example.com',
    );

    // Username/password must never appear in the description
    expect(config.description).not.toContain('admin');
    expect(config.description).not.toContain('s3cret');
    // Hostname should still be visible
    expect(config.description).toContain('example.com');
  });

  test('remote-wrong-service redacts embedded credentials in URL-like hostLabel', () => {
    const urlWithCreds = 'https://user:pass123@wrong.example.com';
    const config = getDesktopRecoveryConfig(
      'remote-wrong-service',
      urlWithCreds,
      'https://fallback.example.com',
    );

    expect(config.description).not.toContain('user');
    expect(config.description).not.toContain('pass123');
    expect(config.description).toContain('wrong.example.com');
  });

  test('non-URL hostLabel is used as-is without redaction', () => {
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      'My Server',
      'https://example.com?token=secret',
    );

    // Plain label should appear verbatim
    expect(config.description).toContain('My Server');
    // hostUrl secrets should not leak (already tested above, but sanity check)
    expect(config.description).not.toContain('secret');
  });

  // ---------------------------------------------------------------------------
  // Fallback descriptions when no host info is provided
  // ---------------------------------------------------------------------------
  test('remote-unreachable falls back to generic text when no host info', () => {
    const config = getDesktopRecoveryConfig('remote-unreachable');

    expect(config.description).toContain('the remote server');
    expect(config.description).not.toContain('undefined');
  });

  test('remote-wrong-service falls back to generic text when no host info', () => {
    const config = getDesktopRecoveryConfig('remote-wrong-service');

    expect(config.description).toContain('unknown');
  });

  // ---------------------------------------------------------------------------
  // Whitespace-only hostLabel is treated as absent
  // ---------------------------------------------------------------------------
  test('whitespace-only hostLabel falls back to hostUrl', () => {
    const config = getDesktopRecoveryConfig(
      'remote-unreachable',
      '   ',
      'https://fallback.example.com?token=secret',
    );

    // hostLabel is whitespace-only → should use redacted hostUrl instead
    expect(config.description).not.toContain('secret');
    expect(config.description).toContain('fallback.example.com');
    expect(config.description).toContain('REDACTED');
  });
});
