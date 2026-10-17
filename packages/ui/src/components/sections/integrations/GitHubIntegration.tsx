import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { GitHubSettings } from '@/components/sections/openchamber/GitHubSettings';
import { IntegrationCatalogCard } from '@/components/sections/integrations/IntegrationCatalogCard';
import { useI18n } from '@/lib/i18n';
import { useSourceControlAuthEntry } from '@/stores/useSourceControlAuthStore';
import { GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';

/**
 * The GitHub row of Settings → Integrations → Built-in integrations: a
 * collapsible card whose body is the account/device-flow UI. Sign-in status
 * shows on the collapsed row so the page answers "am I connected?" at a
 * glance, like the Linear card beside it.
 */
export const GitHubIntegration: React.FC = () => {
  const { t } = useI18n();
  const entry = useSourceControlAuthEntry(GITHUB_SOURCE_CONTROL_IDENTITY);
  const status = entry?.status ?? null;
  const isLoading = entry?.isLoading ?? false;
  const hasChecked = entry?.hasChecked ?? false;
  const [open, setOpen] = React.useState(false);

  const connected = status?.connected === true;
  const accounts = status?.accounts ?? [];
  // One account reads best as its own name. Several would make a single name
  // look like the only one, so the collapsed row reports how many there are
  // and the expanded body names them.
  const currentName = (accounts.find((account) => account.current) ?? accounts[0])?.user.username.trim()
    ?? (status?.status === 'connected' ? status.user.username.trim() : '');
  const statusLabel = isLoading && !hasChecked
    ? t('common.loading')
    : connected
      ? accounts.length > 1
        ? t('settings.sourceControl.accounts.connectedCount', { count: accounts.length })
        : currentName || t('settings.github.page.status.active')
      : t('settings.integrations.github.status.notConnected');
  return (
    <IntegrationCatalogCard
      settingsItem="integrations.github"
      logo={<Icon name="github-fill" className="size-5 text-foreground" />}
      name={t('settings.integrations.github.title')}
      description={t('settings.integrations.github.description')}
      status={statusLabel}
      statusTone={connected ? 'success' : 'neutral'}
      open={open}
      onOpenChange={setOpen}
    >
      <GitHubSettings embedded />
    </IntegrationCatalogCard>
  );
};
