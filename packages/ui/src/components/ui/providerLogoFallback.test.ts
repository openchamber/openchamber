import { describe, expect, test } from 'bun:test';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';

describe('provider logo fallbacks', () => {
  test('uses a local terminal icon for Command Code provider ID variants', () => {
    for (const providerId of ['command-code', 'commandcode', 'command_code', 'command code']) {
      expect(getProviderLogoFallbackIcon(providerId)).toBe('terminal-box');
    }
  });

  test('does not replace providers with their own logo assets', () => {
    expect(getProviderLogoFallbackIcon('claude-code')).toBeNull();
    expect(getProviderLogoFallbackIcon('cursor')).toBeNull();
  });
});
