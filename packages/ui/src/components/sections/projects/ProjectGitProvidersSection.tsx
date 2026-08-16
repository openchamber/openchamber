import React from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { getProjectGitProviders, saveProjectGitProviders } from '@/lib/projectGitProviders';
import {
  useGitProviderDomainsStore,
  type GitProviderApiBaseUrls,
  type GitProviderName,
} from '@/stores/useGitProviderDomainsStore';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { useGitProvider } from '@/lib/gitProvider';
import type { ProjectRef } from '@/lib/openchamberConfig';

const GIT_PROVIDERS: GitProviderName[] = ['github', 'gitlab', 'gitea'];

const EMPTY_API_BASE_URLS: GitProviderApiBaseUrls = { github: '', gitlab: '', gitea: '' };

const PROVIDER_ICONS: Record<GitProviderName, IconName> = {
  github: 'github-fill',
  gitlab: 'gitlab',
  gitea: 'gitea',
};

/**
 * Read the per-provider `apiBaseUrl` overrides out of an untyped server
 * `gitProviders` payload. Unknown or malformed entries collapse to ''.
 */
const readProjectApiBaseUrls = (gitProviders: unknown): GitProviderApiBaseUrls => {
  const result: GitProviderApiBaseUrls = { ...EMPTY_API_BASE_URLS };
  if (!gitProviders || typeof gitProviders !== 'object' || Array.isArray(gitProviders)) {
    return result;
  }
  const config = gitProviders as Record<string, unknown>;
  for (const provider of GIT_PROVIDERS) {
    const entry = config[provider];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const apiBaseUrl = (entry as Record<string, unknown>).apiBaseUrl;
    result[provider] = typeof apiBaseUrl === 'string' ? apiBaseUrl.trim() : '';
  }
  return result;
};

/**
 * Read the forced `provider` out of an untyped server `gitProviders` payload.
 * Anything outside github|gitlab|gitea collapses to null (auto-detect).
 */
const readProjectProvider = (gitProviders: unknown): GitProviderName | null => {
  if (!gitProviders || typeof gitProviders !== 'object' || Array.isArray(gitProviders)) {
    return null;
  }
  const provider = (gitProviders as Record<string, unknown>).provider;
  return typeof provider === 'string' && GIT_PROVIDERS.includes(provider as GitProviderName)
    ? (provider as GitProviderName)
    : null;
};

/**
 * Build the full per-project `gitProviders` object for the server. The server
 * replaces the whole `gitProviders` key on PUT, so every provider is sent
 * together; providers with an empty override are omitted, and the forced
 * `provider` is included only when one is selected.
 */
const buildGitProvidersPayload = (
  drafts: GitProviderApiBaseUrls,
  provider: GitProviderName | null,
): { provider?: GitProviderName } & Partial<Record<GitProviderName, { apiBaseUrl: string }>> => {
  const payload: Partial<Record<GitProviderName, { apiBaseUrl: string }>> & { provider?: GitProviderName } = {};
  for (const entryProvider of GIT_PROVIDERS) {
    const url = drafts[entryProvider].trim();
    if (url) {
      payload[entryProvider] = { apiBaseUrl: url };
    }
  }
  if (provider) {
    payload.provider = provider;
  }
  return payload;
};

type ProjectGitProvidersSectionProps = {
  projectRef: ProjectRef;
};

/**
 * Per-project git provider overrides on top of auto-detection: a forced
 * provider (auto-detect or github/gitlab/gitea) and a single API base URL
 * override for the active provider. Persisted through the project-scoped
 * `/api/projects/:id/git-providers` route; empty overrides fall back to the
 * global server settings value. The one API URL field follows the provider
 * selector — the selected provider when forced, otherwise the currently
 * detected one. Commits on blur/Enter (or provider selection) and re-hydrates
 * the detection store so a new host/provider applies immediately.
 */
export const ProjectGitProvidersSection: React.FC<ProjectGitProvidersSectionProps> = ({ projectRef }) => {
  const { t } = useI18n();
  const globalApiBaseUrls = useGitProviderDomainsStore((state) => state.apiBaseUrls);
  const [drafts, setDrafts] = React.useState<GitProviderApiBaseUrls>({ ...EMPTY_API_BASE_URLS });
  const [provider, setProvider] = React.useState<GitProviderName | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const hasEditedRef = React.useRef(false);
  const committedSnapshotRef = React.useRef('');

  React.useEffect(() => {
    let cancelled = false;
    hasEditedRef.current = false;
    setIsLoading(true);
    void (async () => {
      const { gitProviders } = await getProjectGitProviders(projectRef.id);
      if (cancelled) {
        return;
      }
      const loaded = readProjectApiBaseUrls(gitProviders);
      const loadedProvider = readProjectProvider(gitProviders);
      // Never clobber an edit the user started before the read resolved.
      if (!hasEditedRef.current) {
        setDrafts(loaded);
        setProvider(loadedProvider);
        committedSnapshotRef.current = JSON.stringify(buildGitProvidersPayload(loaded, loadedProvider));
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRef.id]);

  const commit = React.useCallback((nextProvider?: GitProviderName | null) => {
    const providerValue = nextProvider === undefined ? provider : nextProvider;
    const payload = buildGitProvidersPayload(drafts, providerValue);
    const snapshot = JSON.stringify(payload);
    if (snapshot === committedSnapshotRef.current) {
      // Blur with no real change: drop incidental whitespace from the drafts.
      setDrafts({
        github: drafts.github.trim(),
        gitlab: drafts.gitlab.trim(),
        gitea: drafts.gitea.trim(),
      });
      return;
    }
    const previousSnapshot = committedSnapshotRef.current;
    reportSettingsSaveState('saving');
    void saveProjectGitProviders(projectRef.id, payload).then((ok) => {
      if (ok) {
        committedSnapshotRef.current = snapshot;
        useGitProviderDomainsStore.getState().hydrateProjectFromServer(projectRef.id, payload);
        reportSettingsSaveState('saved');
      } else {
        // Keep the pre-failure snapshot so an unchanged blur can retry.
        committedSnapshotRef.current = previousSnapshot;
        reportSettingsSaveState('error');
      }
    });
  }, [drafts, provider, projectRef.id]);

  const handleProviderChange = React.useCallback((value: string) => {
    hasEditedRef.current = true;
    const next = value === 'auto' ? null : (value as GitProviderName);
    setProvider(next);
    commit(next);
  }, [commit]);

  // The live auto-detection result for this project's remote (null/'other'
  // when nothing recognizable was found). Only feeds the field attribution
  // when no provider is forced.
  const detectedProvider = useGitProvider(projectRef.path);
  const knownDetected = detectedProvider && detectedProvider !== 'other' ? detectedProvider : null;

  // One API URL override, always for the active provider: the selected
  // (forced) provider when set, otherwise whatever auto-detection currently
  // yields for this project's remote.
  const activeUrlProvider = provider ?? knownDetected;

  const renderBaseUrlField = (entryProvider: GitProviderName) => {
    const isEmpty = drafts[entryProvider].trim().length === 0;
    // Show what the project inherits when no override is set: the global
    // setting when present, otherwise the provider's default placeholder.
    const inheritedUrl =
      globalApiBaseUrls[entryProvider] || t(`settings.${entryProvider}.page.apiBaseUrl.placeholder`);
    return (
      <SettingsStackedField
        key={entryProvider}
        label={(
          <span className="inline-flex items-center gap-1.5">
            <Icon name={PROVIDER_ICONS[entryProvider]} className="h-3.5 w-3.5" />
            {t(`settings.git.tabs.${entryProvider}`)}
          </span>
        )}
        settingsItem={`projects.git-providers.${entryProvider}`}
        descriptionPlacement="after"
        description={
          isEmpty && !isLoading
            ? provider
              ? t('settings.projects.page.gitProviders.inheritsGlobal', { url: inheritedUrl })
              : t('settings.projects.page.gitProviders.provider.detectedAs', {
                  provider: t(`settings.git.tabs.${entryProvider}`),
                  url: inheritedUrl,
                })
            : undefined
        }
      >
        <Input
          type="text"
          value={drafts[entryProvider]}
          onChange={(event) => {
            hasEditedRef.current = true;
            setDrafts((prev) => ({ ...prev, [entryProvider]: event.target.value }));
          }}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          placeholder={t(`settings.${entryProvider}.page.apiBaseUrl.placeholder`)}
          aria-label={t(`settings.${entryProvider}.page.apiBaseUrl.label`)}
          className="h-9"
        />
      </SettingsStackedField>
    );
  };

  return (
    <ProjectSettingsSubsection
      title={t('settings.projects.page.gitProviders.title')}
      info={t('settings.projects.page.gitProviders.description')}
      settingsItem="projects.git-providers"
    >
      <div className="flex flex-col gap-4 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-muted)] p-4">
        <SettingsStackedField
          label={t('settings.projects.page.gitProviders.provider.label')}
          description={t('settings.projects.page.gitProviders.provider.description')}
          descriptionPlacement="after"
          settingsItem="projects.git-providers.provider"
        >
          <Select value={provider ?? 'auto'} onValueChange={handleProviderChange}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('settings.projects.page.gitProviders.provider.auto')}</SelectItem>
              {GIT_PROVIDERS.map((entryProvider) => (
                <SelectItem key={entryProvider} value={entryProvider}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name={PROVIDER_ICONS[entryProvider]} className="h-3.5 w-3.5" />
                    {t(`settings.git.tabs.${entryProvider}`)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        {activeUrlProvider ? (
          renderBaseUrlField(activeUrlProvider)
        ) : (
          <p className="typography-meta text-muted-foreground">
            {t('settings.projects.page.gitProviders.provider.autoUnknown')}
          </p>
        )}
      </div>
    </ProjectSettingsSubsection>
  );
};
