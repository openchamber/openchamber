import { describe, expect, test } from 'bun:test';

import { providerTabForSettingsItem } from './providerTabs';

describe('providerTabForSettingsItem', () => {
  test('maps GitHub settings ids to the github tab', () => {
    expect(providerTabForSettingsItem('git.github-account')).toBe('github');
    expect(providerTabForSettingsItem('git.github-api-base-url')).toBe('github');
    expect(providerTabForSettingsItem('git.github-detect-urls')).toBe('github');
  });

  test('maps GitLab settings ids to the gitlab tab', () => {
    expect(providerTabForSettingsItem('git.gitlab-account')).toBe('gitlab');
    expect(providerTabForSettingsItem('git.gitlab-api-base-url')).toBe('gitlab');
    expect(providerTabForSettingsItem('git.gitlab-detect-urls')).toBe('gitlab');
  });

  test('maps Gitea settings ids to the gitea tab', () => {
    expect(providerTabForSettingsItem('git.gitea-account')).toBe('gitea');
    expect(providerTabForSettingsItem('git.gitea-api-base-url')).toBe('gitea');
    expect(providerTabForSettingsItem('git.gitea-detect-urls')).toBe('gitea');
  });

  test('returns null for settings ids below the tabs', () => {
    expect(providerTabForSettingsItem('git.identities')).toBeNull();
    expect(providerTabForSettingsItem('git.gitmoji')).toBeNull();
    expect(providerTabForSettingsItem('git.changes-view')).toBeNull();
    expect(providerTabForSettingsItem('git.gitignored-files')).toBeNull();
  });

  test('returns null for empty or missing ids', () => {
    expect(providerTabForSettingsItem(null)).toBeNull();
    expect(providerTabForSettingsItem(undefined)).toBeNull();
    expect(providerTabForSettingsItem('')).toBeNull();
  });
});
