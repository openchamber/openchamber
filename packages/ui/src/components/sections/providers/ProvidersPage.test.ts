import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders } from './providerAvailability';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});
