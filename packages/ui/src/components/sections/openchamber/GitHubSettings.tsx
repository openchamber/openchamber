import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import type { SourceControlDeviceFlowStart } from '@/lib/api/types';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { SourceControlAccountList } from './SourceControlAccountList';
import { DeviceFlowCode } from './DeviceFlowCode';

/**
 * Body of the GitHub card in Settings → Integrations. The card row already
 * names the provider and shows the connection pill, so this renders only the
 * accounts, the sign-in flow, and the CLI fallback.
 */
type GitHubSettingsProps = {
  /** The Integrations card is the only host today; the flag is its contract and changes nothing here. */
  embedded?: boolean;
};

export const GitHubSettings: React.FC<GitHubSettingsProps> = () => {
  const { t } = useI18n();
  const sourceControl = getRegisteredRuntimeAPIs()?.sourceControl;
  const authKey = getSourceControlAuthKey(GITHUB_SOURCE_CONTROL_IDENTITY);
  const authEntry = useSourceControlAuthStore((state) => state.entries[authKey]);
  const status = authEntry?.status ?? null;
  const isLoading = authEntry?.isLoading ?? false;
  const hasChecked = authEntry?.hasChecked ?? false;
  const refreshStatus = useSourceControlAuthStore((state) => state.refreshStatus);
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);

  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const [isBusy, setIsBusy] = React.useState(false);
  const [flow, setFlow] = React.useState<SourceControlDeviceFlowStart | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = React.useState<number | null>(null);
  const [pollAttempt, setPollAttempt] = React.useState(0);
  const pollTimerRef = React.useRef<number | null>(null);
  const flowRuntimeKeyRef = React.useRef('');
  const runtimeGenerationRef = React.useRef(0);
  const captureRuntime = React.useCallback(() => {
    const runtimeKey = getRuntimeKey();
    const generation = runtimeGenerationRef.current;
    return () => generation === runtimeGenerationRef.current && runtimeKey === getRuntimeKey();
  }, []);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPollIntervalMs(null);
  }, []);

  const stopFlow = React.useCallback(() => {
    flowRuntimeKeyRef.current = '';
    setFlow(null);
    stopPolling();
  }, [stopPolling]);

  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      runtimeGenerationRef.current += 1;
      setIsBusy(false);
      stopFlow();
    });
    return () => {
      runtimeGenerationRef.current += 1;
      unsubscribe();
    };
  }, [stopFlow]);

  React.useEffect(() => {
    (async () => {
      try {
        if (!hasChecked && sourceControl) {
          await refreshStatus(sourceControl, GITHUB_SOURCE_CONTROL_IDENTITY);
        }
      } catch (error) {
        console.warn('Failed to load GitHub auth status:', error);
      }
    })();
    return () => {
      stopPolling();
    };
  }, [hasChecked, refreshStatus, sourceControl, stopPolling]);

  const startConnect = React.useCallback(async () => {
    const isCurrentRuntime = captureRuntime();
    setIsBusy(true);
    try {
      if (!sourceControl) return;
      const payload = await sourceControl.authStart(GITHUB_SOURCE_CONTROL_IDENTITY);
      if (!isCurrentRuntime()) return;

      flowRuntimeKeyRef.current = getRuntimeKey();
      setFlow(payload);
      setPollAttempt(0);
      setPollIntervalMs(Math.max(1, payload.interval) * 1000);

      const url = payload.verificationUriComplete || payload.verificationUri;
      void openExternal(url);
    } catch (error) {
      if (isCurrentRuntime()) {
        console.error('Failed to start GitHub connect:', error);
        toast.error(t('settings.github.page.toast.startConnectFailed'));
      }
    } finally {
      if (isCurrentRuntime()) setIsBusy(false);
    }
  }, [captureRuntime, openExternal, sourceControl, t]);

  React.useEffect(() => {
    if (!flow?.flowId || !pollIntervalMs) {
      return;
    }
    if (pollTimerRef.current != null) {
      return;
    }

    const poll = async () => {
      const isCurrentRuntime = captureRuntime();
      if (flowRuntimeKeyRef.current !== getRuntimeKey()) {
        stopFlow();
        return;
      }

      try {
        if (!sourceControl) throw new Error('Source control runtime API unavailable');
        const result = await sourceControl.authComplete(GITHUB_SOURCE_CONTROL_IDENTITY, flow.flowId);
        if (!isCurrentRuntime() || flowRuntimeKeyRef.current !== getRuntimeKey()) return;
        if (result.status === 'connected') {
          stopFlow();
          await refreshStatus(sourceControl, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });
          if (!isCurrentRuntime()) return;
          await refreshInstances(sourceControl, { force: true });
          if (!isCurrentRuntime()) return;
          toast.success(t('settings.github.page.toast.connected'));
          return;
        }

        if (result.status === 'pending' && result.slowDown) {
          setPollIntervalMs((prev) => (prev ? prev + 5000 : 5000));
        }
        if (result.status === 'pending') setPollAttempt((attempt) => attempt + 1);

        if (result.status === 'error') {
          toast.error(result.message || t('settings.github.page.toast.authorizationFailed'));
          stopFlow();
        }
      } catch (error) {
        if (isCurrentRuntime() && flowRuntimeKeyRef.current === getRuntimeKey()) {
          console.warn('GitHub polling failed:', error);
          setPollAttempt((attempt) => attempt + 1);
        }
      }
    };

    pollTimerRef.current = window.setTimeout(() => {
      void poll();
    }, pollIntervalMs);

    return () => {
      if (pollTimerRef.current != null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [captureRuntime, flow, pollAttempt, pollIntervalMs, refreshInstances, refreshStatus, sourceControl, stopFlow, t]);

  const toggleGhCli = React.useCallback(async (disabled: boolean) => {
    const isCurrentRuntime = captureRuntime();
    setIsBusy(true);
    try {
      if (!sourceControl) return;
      await sourceControl.authSetCliDisabled(GITHUB_SOURCE_CONTROL_IDENTITY, disabled);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });
      if (!isCurrentRuntime()) return;
      toast.success(disabled ? t('settings.github.page.toast.ghCliDisabled') : t('settings.github.page.toast.ghCliEnabled'));
    } catch (error) {
      if (isCurrentRuntime()) {
        console.error('Failed to update gh CLI setting:', error);
        toast.error(t('settings.github.page.toast.ghCliUpdateFailed'));
      }
    } finally {
      if (isCurrentRuntime()) setIsBusy(false);
    }
  }, [captureRuntime, refreshStatus, sourceControl, t]);

  const removeAccount = React.useCallback(async (accountId: string) => {
    const isCurrentRuntime = captureRuntime();
    setIsBusy(true);
    try {
      stopFlow();
      if (!sourceControl) return;
      await sourceControl.authDisconnect(GITHUB_SOURCE_CONTROL_IDENTITY, accountId);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });
      if (!isCurrentRuntime()) return;
      await refreshInstances(sourceControl, { force: true });
      if (!isCurrentRuntime()) return;
      toast.success(t('settings.github.page.toast.disconnected'));
    } catch (error) {
      if (isCurrentRuntime()) {
        console.error('Failed to remove GitHub account:', error);
        toast.error(t('settings.github.page.toast.disconnectFailed'));
      }
    } finally {
      if (isCurrentRuntime()) setIsBusy(false);
    }
  }, [captureRuntime, refreshInstances, refreshStatus, sourceControl, stopFlow, t]);

  if (isLoading && !hasChecked) {
    return null;
  }

  const accounts = status?.accounts ?? [];
  const ghCli = status?.cli ?? null;
  const refreshError = status?.status === 'unreachable' || status?.status === 'temporarily-unavailable'
    ? status.message || t('sessionAuth.error.networkRetry')
    : null;
  const showCliFallback = Boolean(ghCli?.available && !ghCli.active && (!ghCli.user || ghCli.disabled));

  return (
    <div className="space-y-3" data-settings-item="git.github-account">
      {refreshError && (
        <SettingsFieldRow label={t('sessionAuth.error.networkTitle')} description={refreshError}>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy || isLoading || !sourceControl}
            onClick={() => {
              if (sourceControl) void refreshStatus(sourceControl, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });
            }}
          >
            {t('sessionAuth.error.retry')}
          </Button>
        </SettingsFieldRow>
      )}
      {accounts.length === 0 ? (
        !refreshError && <p className="typography-meta text-muted-foreground">{t('settings.github.page.status.notConnected')}</p>
      ) : (
        <SourceControlAccountList
          accounts={accounts}
          avatarAlt={(username) => t('settings.github.page.avatarAlt.withLogin', { login: username })}
          currentLabel={t('settings.sourceControl.accounts.inUse')}
          sourceLabel={(account) => account.source === 'cli'
            ? t('settings.github.page.accountSource.cli')
            : t('settings.github.page.accountSource.oauth')}
          statusLabel={(account) => account.status === 'valid'
            ? t('settings.sourceControl.accounts.available')
            : t('settings.sourceControl.accounts.needsAuthentication')}
          renderActions={(account) => (
            <>
              {account.status === 'invalid' ? (
                <Button size="sm" variant="outline" onClick={startConnect} disabled={isBusy}>
                  {t('settings.sourceControl.actions.reauthenticate')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => account.source === 'cli' ? toggleGhCli(true) : removeAccount(account.id)}
                disabled={isBusy}
              >
                {account.source === 'cli' ? t('settings.github.page.ghCli.actions.disable') : t('settings.sourceControl.actions.remove')}
              </Button>
            </>
          )}
        />
      )}

      {flow ? (
        <DeviceFlowCode
          code={flow.userCode}
          description={t('settings.github.page.flow.description')}
          openLabel={t('settings.github.page.actions.openGithub')}
          onOpen={() => void openExternal(flow.verificationUriComplete || flow.verificationUri)}
          onCancel={stopFlow}
          disabled={isBusy}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-settings-item="git.github-connect"
            size="sm"
            variant={accounts.length > 0 ? 'outline' : 'default'}
            onClick={startConnect}
            disabled={isBusy}
          >
            {accounts.length > 0 ? t('settings.github.page.actions.addAccount') : t('settings.github.page.actions.connect')}
          </Button>
        </div>
      )}

      {showCliFallback && ghCli ? (
        <SettingsFieldRow
          label={t('settings.github.page.ghCli.title')}
          description={ghCli.disabled
            ? t('settings.github.page.ghCli.disabledDescription')
            : t('settings.github.page.ghCli.fallbackDescription')}
          className="border-t border-[var(--surface-subtle)] pt-3"
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => toggleGhCli(!ghCli.disabled)}
            disabled={isBusy}
          >
            {ghCli.disabled
              ? t('settings.github.page.ghCli.actions.enable')
              : t('settings.github.page.ghCli.actions.disable')}
          </Button>
        </SettingsFieldRow>
      ) : null}
    </div>
  );
};
