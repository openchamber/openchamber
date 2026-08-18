import { describe, expect, test } from 'bun:test';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';

describe('provider logo fallbacks', () => {
  test('uses a local terminal icon when Command Code has no resolved logo', () => {
    expect(getProviderLogoFallbackIcon('command-code')).toBe('terminal-box');
  });

  test('does not replace providers with their own logo assets', () => {
    expect(getProviderLogoFallbackIcon('claude-code')).toBeNull();
    expect(getProviderLogoFallbackIcon('cursor')).toBeNull();
  });
});
