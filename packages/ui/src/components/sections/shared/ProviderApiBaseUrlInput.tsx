import React from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import {
  useGitProviderDomainsStore,
  type GitProviderName,
} from '@/stores/useGitProviderDomainsStore';

/**
 * Persist the full `gitProviders` settings object. The server replaces the
 * whole `gitProviders` key on PUT, so every provider must be sent together —
 * sending a single provider alone would wipe the others.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const saveGitProvidersConfig = async (): Promise<void> => {
  const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
  const payload = {
    gitProviders: {
      github: { apiBaseUrl: apiBaseUrls.github, detectUrls: domains.github },
      gitlab: { apiBaseUrl: apiBaseUrls.gitlab, detectUrls: domains.gitlab },
      gitea: { apiBaseUrl: apiBaseUrls.gitea, detectUrls: domains.gitea },
    },
  };
  reportSettingsSaveState('saving');
  try {
    const response = await runtimeFetch('/api/config/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    reportSettingsSaveState('saved');
  } catch (error) {
    console.warn('Failed to persist git provider settings:', error);
    reportSettingsSaveState('error');
  }
};

/**
 * Server-side default API base URL for a git provider's API calls. A per-account
 * base URL still wins once an account is connected. Commits (updates the store
 * cache optimistically and persists the full gitProviders object) on blur or
 * Enter; the settings round-trip re-hydrates the store afterwards.
 */
export const ProviderApiBaseUrlInput: React.FC<{ provider: GitProviderName }> = ({ provider }) => {
  const { t } = useI18n();
  const storedValue = useGitProviderDomainsStore((state) => state.apiBaseUrls[provider]);
  const setApiBaseUrl = useGitProviderDomainsStore((state) => state.setApiBaseUrl);
  const [draft, setDraft] = React.useState(storedValue);

  React.useEffect(() => {
    setDraft(storedValue);
  }, [storedValue]);

  const commit = React.useCallback(() => {
    const next = draft.trim();
    if (next !== storedValue) {
      setApiBaseUrl(provider, next);
      void saveGitProvidersConfig();
    } else {
      // Blur with no real change: drop incidental whitespace from the draft.
      setDraft(storedValue);
    }
  }, [draft, provider, setApiBaseUrl, storedValue]);

  return (
    <SettingsStackedField
      label={t(`settings.${provider}.page.apiBaseUrl.label`)}
      description={t(`settings.${provider}.page.apiBaseUrl.description`)}
      descriptionPlacement="after"
      settingsItem={`git.${provider}-api-base-url`}
    >
      <Input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={t(`settings.${provider}.page.apiBaseUrl.placeholder`)}
        aria-label={t(`settings.${provider}.page.apiBaseUrl.label`)}
        className="h-9"
      />
    </SettingsStackedField>
  );
};
