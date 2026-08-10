import { describe, expect, test } from 'bun:test';
import { getSettingsPageMeta, resolveSettingsSlug } from './metadata';

describe('analytics settings page', () => {
  test('metadata is registered', () => {
    const meta = getSettingsPageMeta('analytics');
    expect(meta).toMatchObject({ slug: 'analytics', group: 'general', kind: 'single' });
  });

  test('resolves the analytics slug directly', () => {
    expect(resolveSettingsSlug('analytics')).toBe('analytics');
  });
});
