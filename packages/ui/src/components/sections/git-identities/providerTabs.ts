export type GitProviderTabId = 'github' | 'gitlab' | 'gitea';

export const providerTabForSettingsItem = (settingsItemId: string | null | undefined): GitProviderTabId | null => {
  if (!settingsItemId) return null;
  if (settingsItemId.startsWith('git.github-')) return 'github';
  if (settingsItemId.startsWith('git.gitlab-')) return 'gitlab';
  if (settingsItemId.startsWith('git.gitea-')) return 'gitea';
  return null;
};
