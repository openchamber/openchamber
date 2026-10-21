import React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { GitHubSettings } from '@/components/sections/openchamber/GitHubSettings';
import { GitHubEnterpriseSettings } from '@/components/sections/openchamber/GitHubEnterpriseSettings';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';

/**
 * The GitHub row of Settings → Integrations → Built-in integrations: a
 * collapsible card whose body is the github.com account/device-flow UI and the
 * GitHub Enterprise instances beneath it. Sign-in status shows on the collapsed
 * row so the page answers "am I connected?" at a glance, across every GitHub
 * instance, like the Linear and GitLab cards beside it.
 */
export const GitHubIntegration: React.FC = () => {
  const { t } = useI18n();
  const identities = useSourceControlAuthStore((state) => state.identities);
  const entries = useSourceControlAuthStore((state) => state.entries);
  const [open, setOpen] = React.useState(false);

  const githubIdentities = identities.filter((item) => item.provider === 'github');
  const visibleIdentities = [...githubIdentities];
  if (visibleIdentities.length === 0) visibleIdentities.push(GITHUB_SOURCE_CONTROL_IDENTITY);
  const instanceEntries = visibleIdentities.map((identity) => entries[getSourceControlAuthKey(identity)]);
  const validAccounts = instanceEntries
    .flatMap((entry) => (entry?.status?.status === 'connected' ? entry.status.accounts : []))
    .filter((account) => account.status === 'valid');
  // Prefer the account the user is acting as; the first valid one is an
  // arbitrary pick once several instances are configured.
  const connectedAccount = validAccounts.find((account) => account.current) ?? validAccounts[0] ?? null;
  const connected = connectedAccount !== null;
  const isChecking = instanceEntries.some((entry) => entry?.isLoading && !entry.hasChecked);
  const statusLabel = isChecking && !connected
    ? t('common.loading')
    : connected
      ? validAccounts.length > 1
        ? t('settings.sourceControl.accounts.connectedCount', { count: validAccounts.length })
        : connectedAccount.user.username.trim() || t('settings.github.page.status.active')
      : t('settings.integrations.github.status.notConnected');
  const statusClassName = connected
    ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
    : 'bg-[var(--surface-muted)] text-muted-foreground';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-settings-item="integrations.github"
        className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
      >
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-start hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name="github-fill" className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('settings.integrations.github.title')}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t('settings.integrations.github.description')}
            </p>
          </div>
          <span
            aria-live="polite"
            className={cn('max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', statusClassName)}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
          <div className="space-y-3">
            <GitHubSettings embedded />
            <GitHubEnterpriseSettings />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
