import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import type { GitLabAuthStatus } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { Icon } from '@/components/icon/Icon';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { ProviderApiBaseUrlInput } from '@/components/sections/shared/ProviderApiBaseUrlInput';
import { ProviderDetectUrlsInput } from '@/components/sections/shared/ProviderDetectUrlsInput';
import { useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';

const getBaseUrlHost = (baseUrl?: string | null): string => {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

export const GitLabSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const runtimeGitLab = getRegisteredRuntimeAPIs()?.gitlab;
  const status = useGitLabAuthStore((state) => state.status);
  const isLoading = useGitLabAuthStore((state) => state.isLoading);
  const hasChecked = useGitLabAuthStore((state) => state.hasChecked);
  const refreshStatus = useGitLabAuthStore((state) => state.refreshStatus);
  const setStatus = useGitLabAuthStore((state) => state.setStatus);

  const [isBusy, setIsBusy] = React.useState(false);
  const [accessToken, setAccessToken] = React.useState('');
  // Prefill the connect form with the server-side default API base URL when the
  // user has not typed one yet; the per-account base URL still wins on connect.
  const [baseUrl, setBaseUrl] = React.useState(
    useGitProviderDomainsStore((state) => state.apiBaseUrls.gitlab),
  );

  React.useEffect(() => {
    (async () => {
      try {
        if (!hasChecked) {
          await refreshStatus(runtimeGitLab);
        }
      } catch (error) {
        console.warn('Failed to load GitLab auth status:', error);
      }
    })();
  }, [hasChecked, refreshStatus, runtimeGitLab]);

  const connect = React.useCallback(async () => {
    const trimmedToken = accessToken.trim();
    if (!trimmedToken) {
      toast.error(t('settings.gitlab.page.errors.invalidToken'));
      return;
    }
    const trimmedBaseUrl = baseUrl.trim() || undefined;
    setIsBusy(true);
    try {
      const payload = runtimeGitLab
        ? await runtimeGitLab.authConnect({ accessToken: trimmedToken, baseUrl: trimmedBaseUrl })
        : await (async () => {
            const response = await runtimeFetch('/api/gitlab/auth/connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ accessToken: trimmedToken, baseUrl: trimmedBaseUrl }),
            });
            const body = (await response.json().catch(() => null)) as GitLabAuthStatus | { error?: string } | null;
            if (!response.ok || !body) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body as GitLabAuthStatus;
          })();

      setStatus(payload);
      setAccessToken('');
      setBaseUrl('');
      toast.success(t('settings.gitlab.page.toast.connected'));
    } catch (error) {
      console.error('Failed to connect GitLab:', error);
      toast.error(t('settings.gitlab.page.errors.failed'));
    } finally {
      setIsBusy(false);
    }
  }, [accessToken, baseUrl, runtimeGitLab, setStatus, t]);

  const disconnect = React.useCallback(async () => {
    setIsBusy(true);
    try {
      if (runtimeGitLab) {
        await runtimeGitLab.authDisconnect();
      } else {
        const response = await runtimeFetch('/api/gitlab/auth', {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(response.statusText);
        }
      }
      toast.success(t('settings.gitlab.page.toast.disconnected'));
      await refreshStatus(runtimeGitLab, { force: true });
    } catch (error) {
      console.error('Failed to disconnect GitLab:', error);
      toast.error(t('settings.gitlab.page.toast.disconnectFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeGitLab, t]);

  const activateAccount = React.useCallback(async (accountId: string) => {
    if (!accountId) return;
    setIsBusy(true);
    try {
      const payload = runtimeGitLab
        ? await runtimeGitLab.authActivate(accountId)
        : await (async () => {
            const response = await runtimeFetch('/api/gitlab/auth/activate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ accountId }),
            });
            const body = (await response.json().catch(() => null)) as GitLabAuthStatus | { error?: string } | null;
            if (!response.ok || !body) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body as GitLabAuthStatus;
          })();

      setStatus(payload);
      toast.success(t('settings.gitlab.page.toast.accountSwitched'));
    } catch (error) {
      console.error('Failed to switch GitLab account:', error);
      toast.error(t('settings.gitlab.page.toast.accountSwitchFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [runtimeGitLab, setStatus, t]);

  if (isLoading) {
    return null;
  }

  const connected = Boolean(status?.connected);
  const user = status?.user;
  const accounts = status?.accounts ?? [];
  const otherAccounts = accounts.filter((account) => !account.current);
  const currentAccount = accounts.find((account) => account.current) ?? (accounts.length > 0 ? accounts[0] : null);
  const currentBaseUrlHost = getBaseUrlHost(currentAccount?.baseUrl ?? status?.defaultBaseUrl);

  return (
    <SettingsSection
      title={t('settings.gitlab.page.title')}
      description={t('settings.gitlab.page.description')}
      info={t('settings.gitlab.page.tooltip.connectAccount')}
      settingsItem="git.gitlab-account"
    >
      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        {connected ? (
          <div className={cn('px-4 py-3', isMobile ? 'flex flex-col gap-3' : 'flex items-center justify-between gap-4')}>
            <div className={cn('flex min-w-0 items-center gap-4', isMobile ? 'w-full' : undefined)}>
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.username ? t('settings.gitlab.page.avatarAlt.withLogin', { login: user.username }) : t('settings.gitlab.page.avatarAlt.fallback')}
                  className="h-10 w-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                  <Icon name="gitlab" className="h-4 w-4 text-muted-foreground" />
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="typography-ui-label text-foreground">
                  {user?.name?.trim() || user?.username || 'GitLab'}
                </div>
                <div className={cn('flex items-center gap-2 typography-meta text-muted-foreground mt-0.5', isMobile ? 'flex-wrap' : 'truncate')}>
                  <Icon name="gitlab" className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('settings.gitlab.page.connectedAs')}</span>
                  <span className="font-mono">{user?.username || t('settings.gitlab.page.label.unknownUser')}</span>
                  <span className="opacity-50">•</span>
                  <span className="font-mono">{currentBaseUrlHost}</span>
                </div>
              </div>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={disconnect}
              disabled={isBusy}
              className={cn('text-[var(--status-error)] hover:text-[var(--status-error)]', isMobile ? 'w-full' : undefined)}
            >
              {t('settings.gitlab.page.actions.disconnect')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="gitlab-access-token" className="typography-settings-field-label text-foreground">
                {t('settings.gitlab.page.accessToken.label')}
              </label>
              <Input
                id="gitlab-access-token"
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder={t('settings.gitlab.page.accessToken.placeholder')}
                className="h-9 max-w-[24rem]"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="gitlab-base-url" className="typography-settings-field-label text-foreground">
                {t('settings.gitlab.page.baseUrl.label')}
              </label>
              <Input
                id="gitlab-base-url"
                type="text"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={t('settings.gitlab.page.baseUrl.placeholder')}
                className="h-9 max-w-[24rem]"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="typography-ui-label text-foreground">{t('settings.gitlab.page.status.notConnected')}</span>
              <Button size="sm" variant="default" onClick={connect} disabled={isBusy || !accessToken.trim()}>
                {t('settings.gitlab.page.actions.connect')}
              </Button>
            </div>
          </div>
        )}

        {otherAccounts.length > 0 && (
          <div className="mt-2 border-t border-[var(--surface-subtle)] pt-2 px-2 pb-1">
            <div className="typography-micro text-muted-foreground mb-2 px-1">
              {t('settings.gitlab.page.label.otherAccounts')}
            </div>
            <div className="space-y-1">
              {otherAccounts.map((account) => {
                const accountUser = account.user;
                return (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-muted)] px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {accountUser?.avatarUrl ? (
                        <img
                          src={accountUser.avatarUrl}
                          alt={accountUser.username ? t('settings.gitlab.page.avatarAlt.withLogin', { login: accountUser.username }) : t('settings.gitlab.page.avatarAlt.fallback')}
                          className="h-6 w-6 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                          <Icon name="gitlab" className="h-3 w-3 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex flex-col">
                        <span className="typography-ui-label text-foreground truncate">
                          {accountUser?.name?.trim() || accountUser?.username || 'GitLab'}
                        </span>
                        {accountUser?.username && (
                          <span className="typography-micro text-muted-foreground truncate">
                            <span className="font-mono">{accountUser.username}</span>
                            <span className="mx-1 opacity-50">·</span>
                            <span className="font-mono">{getBaseUrlHost(account.baseUrl)}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => activateAccount(account.id)}
                      disabled={isBusy}
                    >
                      {t('settings.gitlab.page.actions.switch')}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 pt-4">
        <ProviderApiBaseUrlInput provider="gitlab" />
        <ProviderDetectUrlsInput provider="gitlab" />
      </div>
    </SettingsSection>
  );
};
