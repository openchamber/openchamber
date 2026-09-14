import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlAuthAccount, SourceControlAuthStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getManagedCredentialSourceLabelKey, GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';
import { useSourceControlAuthEntry, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

type GitHubAccount = SourceControlAuthAccount;

const AVATAR_CLASS = 'flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80';


/**
 * The connected GitHub account: an avatar, and a switcher when more than one
 * account is signed in (OAuth and `gh` CLI logins). Renders nothing while
 * GitHub is disconnected — connecting happens in Settings → Integrations.
 */
export const GitHubAccountControl: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const entry = useSourceControlAuthEntry(GITHUB_SOURCE_CONTROL_IDENTITY);
  const status: SourceControlAuthStatus | null = entry?.status ?? null;
  const setStatus = useSourceControlAuthStore((state) => state.setStatus);
  const [isSwitching, setIsSwitching] = React.useState(false);

  const switchAccount = React.useCallback(async (accountId: string) => {
    if (!accountId || isSwitching) return;
    setIsSwitching(true);
    try {
      setStatus(GITHUB_SOURCE_CONTROL_IDENTITY, await sourceControl.authActivate(GITHUB_SOURCE_CONTROL_IDENTITY, accountId));
    } catch (error) {
      console.error('Failed to switch GitHub account:', error);
    } finally {
      setIsSwitching(false);
    }
  }, [isSwitching, setStatus, sourceControl]);

  if (status?.status !== 'connected') {
    return null;
  }

  const login = status.user.username || null;
  const avatarUrl = status.user.avatarUrl ?? null;
  const accounts: GitHubAccount[] = status.accounts;
  const title = login ? t('header.github.connectedWithLogin', { login }) : t('header.github.connected');
  const avatar = avatarUrl ? (
    <img
      src={avatarUrl}
      alt={login ? t('header.github.avatarWithLogin', { login }) : t('header.github.avatar')}
      className="h-full w-full object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ) : (
    <Icon name="github-fill" className="h-3.5 w-3.5 text-foreground" />
  );

  if (accounts.length <= 1) {
    return (
      <div className={cn(AVATAR_CLASS, className)} title={title}>
        {avatar}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(AVATAR_CLASS, 'p-0 hover:ring-2 hover:ring-primary/40 disabled:opacity-50', className)}
          title={title}
          disabled={isSwitching}
        >
          {avatar}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
          {t('header.github.accountsTitle')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accounts.map((account) => {
          const accountUser = account.user;
          const isCurrent = Boolean(account.current);
          const sourceLabel = t(getManagedCredentialSourceLabelKey(account.source ?? 'oauth'));
          return (
            <DropdownMenuItem
              key={account.id}
              className="gap-2"
              disabled={isSwitching}
              onSelect={() => {
                if (!isCurrent) {
                  void switchAccount(account.id);
                }
              }}
            >
              {accountUser?.avatarUrl ? (
                <img
                  src={accountUser.avatarUrl}
                  alt={accountUser.username ? t('header.github.avatarWithLogin', { login: accountUser.username }) : t('header.github.avatar')}
                  className="h-6 w-6 rounded-full border border-border/60 bg-muted object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                  <Icon name="github-fill" className="h-3 w-3 text-muted-foreground" />
                </div>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate typography-ui-label text-foreground">
                  {accountUser?.name?.trim() || accountUser.username || 'GitHub'}
                </span>
                {accountUser.username ? (
                  <span className="truncate typography-micro text-muted-foreground">
                    <span className="font-mono">{accountUser.username}</span>
                    <span className="mx-1 opacity-50">·</span>
                    <span>{sourceLabel}</span>
                  </span>
                ) : null}
              </span>
              {isCurrent ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
