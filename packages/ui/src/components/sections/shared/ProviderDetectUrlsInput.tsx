import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import {
  normalizeProviderDomain,
  useGitProviderDomainsStore,
  type GitProviderName,
} from '@/stores/useGitProviderDomainsStore';
import { saveGitProvidersConfig } from './ProviderApiBaseUrlInput';

/**
 * Detection URLs for a git provider: an SSH or HTTPS URL typed into the field
 * becomes a chip (displayed as its bare hostname) on Enter or comma, and the X
 * on a chip removes it. The hosts feed provider autodetection of repo remotes.
 * Each change updates the store cache optimistically and persists the full
 * gitProviders object; the settings round-trip re-hydrates the store.
 */
export const ProviderDetectUrlsInput: React.FC<{ provider: GitProviderName }> = ({ provider }) => {
  const { t } = useI18n();
  const domains = useGitProviderDomainsStore((state) => state.domains[provider]);
  const setDomains = useGitProviderDomainsStore((state) => state.setDomains);
  const [draft, setDraft] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);

  const commitDraft = React.useCallback(() => {
    const raw = draft.trim();
    if (!raw) {
      setDraft('');
      setInvalid(false);
      return;
    }
    const next = [...domains];
    let added = false;
    for (const part of raw.split(',')) {
      const host = normalizeProviderDomain(part);
      if (host && !next.includes(host)) {
        next.push(host);
        added = true;
      }
    }
    if (added) {
      setDomains(provider, next);
      setDraft('');
      setInvalid(false);
      void saveGitProvidersConfig();
    } else {
      // Unparseable input: keep the draft so the user can fix it.
      setInvalid(true);
    }
  }, [draft, domains, provider, setDomains]);

  const removeChip = React.useCallback((host: string) => {
    setDomains(provider, domains.filter((entry) => entry !== host));
    void saveGitProvidersConfig();
  }, [domains, provider, setDomains]);

  return (
    <SettingsStackedField
      label={t(`settings.${provider}.page.detectUrls.label`)}
      description={t(`settings.${provider}.page.detectUrls.description`)}
      descriptionPlacement="after"
      settingsItem={`git.${provider}-detect-urls`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {domains.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {domains.map((host) => (
              <span
                key={host}
                className="inline-flex h-6 items-center gap-0.5 rounded-md border border-border/60 bg-[var(--surface-elevated)] pl-2 pr-1"
              >
                <span className="typography-micro font-mono text-foreground">{host}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={t('settings.gitProviders.detectUrls.remove', { host })}
                  title={t('settings.gitProviders.detectUrls.remove', { host })}
                  onClick={() => removeChip(host)}
                  className="h-4 w-4 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                >
                  <Icon name="close" className="size-3" />
                </Button>
              </span>
            ))}
          </div>
        ) : null}
        <Input
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          placeholder={t(`settings.${provider}.page.detectUrls.placeholder`)}
          aria-label={t('settings.gitProviders.detectUrls.add')}
          aria-invalid={invalid || undefined}
          className="h-9"
        />
        {invalid ? (
          <p className="typography-micro text-[var(--status-error)]">
            {t('settings.gitProviders.detectUrls.invalid')}
          </p>
        ) : null}
      </div>
    </SettingsStackedField>
  );
};
