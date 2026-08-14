import React from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useGitProviderDomainsStore, type GitProviderName } from '@/stores/useGitProviderDomainsStore';

/**
 * Comma-separated custom-domain input for a git provider. Commits (normalizes,
 * dedupes, persists) on blur or Enter; the field reflects the persisted,
 * normalized list joined by ', '.
 */
export const CustomDomainsInput: React.FC<{ provider: GitProviderName }> = ({ provider }) => {
  const { t } = useI18n();
  const domains = useGitProviderDomainsStore((state) => state.domains[provider]);
  const setDomains = useGitProviderDomainsStore((state) => state.setDomains);
  const [value, setValue] = React.useState(domains.join(', '));

  React.useEffect(() => {
    setValue(domains.join(', '));
  }, [domains]);

  const commit = React.useCallback(() => {
    setDomains(provider, value.split(',').map((entry) => entry.trim()).filter(Boolean));
  }, [provider, setDomains, value]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${provider}-custom-domains`} className="typography-settings-field-label text-foreground">
        {t(`settings.${provider}.page.customDomains.label`)}
      </label>
      <Input
        id={`${provider}-custom-domains`}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={t(`settings.${provider}.page.customDomains.placeholder`)}
        className="h-9 max-w-[24rem]"
      />
      <span className="typography-micro text-muted-foreground">
        {t(`settings.${provider}.page.customDomains.description`)}
      </span>
    </div>
  );
};
