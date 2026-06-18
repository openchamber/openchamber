import { describe, expect, test } from 'bun:test';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getSyncedThemeFromPayload, getSyncedThemeVariant } from './theme-sync-payload';

describe('theme sync payload', () => {
  test('accepts full custom theme payloads for embedded live sync', () => {
    const customTheme = {
      ...getDefaultTheme(true),
      metadata: {
        ...getDefaultTheme(true).metadata,
        id: 'live-custom-dark',
        name: 'Live custom dark',
        variant: 'dark' as const,
      },
    };

    expect(getSyncedThemeFromPayload({ currentTheme: customTheme })?.metadata.id).toBe('live-custom-dark');
    expect(getSyncedThemeVariant({ currentTheme: customTheme })).toBe('dark');
  });
});
