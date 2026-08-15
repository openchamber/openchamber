import React from 'react';
import { Input } from '@/components/ui/input';
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
import type { ProjectRef } from '@/lib/openchamberConfig';

const GIT_PROVIDERS: GitProviderName[] = ['github', 'gitlab', 'gitea'];

const EMPTY_API_BASE_URLS: GitProviderApiBaseUrls = { github: '', gitlab: '', gitea: '' };

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
 * Build the full per-project `gitProviders` object for the server. The server
 * replaces the whole `gitProviders` key on PUT, so every provider is sent
 * together; providers with an empty override are omitted.
 */
const buildGitProvidersPayload = (
  drafts: GitProviderApiBaseUrls,
): Partial<Record<GitProviderName, { apiBaseUrl: string }>> => {
  const payload: Partial<Record<GitProviderName, { apiBaseUrl: string }>> = {};
  for (const provider of GIT_PROVIDERS) {
    const url = drafts[provider].trim();
    if (url) {
      payload[provider] = { apiBaseUrl: url };
    }
  }
  return payload;
};

type ProjectGitProvidersSectionProps = {
  projectRef: ProjectRef;
};

/**
 * Per-project git provider API base URL overrides. Each provider's override is
 * persisted through the project-scoped `/api/projects/:id/git-providers` route;
 * empty overrides fall back to the global server settings value. Commits on
 * blur or Enter and re-hydrates the detection store so a new host applies
 * immediately.
 */
export const ProjectGitProvidersSection: React.FC<ProjectGitProvidersSectionProps> = ({ projectRef }) => {
  const { t } = useI18n();
  const globalApiBaseUrls = useGitProviderDomainsStore((state) => state.apiBaseUrls);
  const [drafts, setDrafts] = React.useState<GitProviderApiBaseUrls>({ ...EMPTY_API_BASE_URLS });
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
      // Never clobber an edit the user started before the read resolved.
      if (!hasEditedRef.current) {
        setDrafts(loaded);
        committedSnapshotRef.current = JSON.stringify(buildGitProvidersPayload(loaded));
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRef.id]);

  const commit = React.useCallback(() => {
    const payload = buildGitProvidersPayload(drafts);
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
  }, [drafts, projectRef.id]);

  return (
    <ProjectSettingsSubsection
      title={t('settings.projects.page.gitProviders.title')}
      info={t('settings.projects.page.gitProviders.description')}
      settingsItem="projects.git-providers"
    >
      {GIT_PROVIDERS.map((provider) => {
        const isEmpty = drafts[provider].trim().length === 0;
        // Show what the project inherits when no override is set: the global
        // setting when present, otherwise the provider's default placeholder.
        const inheritedUrl =
          globalApiBaseUrls[provider] || t(`settings.${provider}.page.apiBaseUrl.placeholder`);
        return (
          <SettingsStackedField
            key={provider}
            label={t(`settings.${provider}.page.apiBaseUrl.label`)}
            settingsItem={`projects.git-providers.${provider}`}
            descriptionPlacement="after"
            description={
              isEmpty && !isLoading
                ? t('settings.projects.page.gitProviders.inheritsGlobal', { url: inheritedUrl })
                : undefined
            }
          >
            <Input
              type="text"
              value={drafts[provider]}
              onChange={(event) => {
                hasEditedRef.current = true;
                setDrafts((prev) => ({ ...prev, [provider]: event.target.value }));
              }}
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
      })}
    </ProjectSettingsSubsection>
  );
};