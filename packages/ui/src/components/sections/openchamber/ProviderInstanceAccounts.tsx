import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import type {
  SourceControlCapabilities,
  SourceControlAPI,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
} from '@/lib/api/types';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useSourceControlAuthEntry, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { SourceControlAccountList } from './SourceControlAccountList';
import { DeviceFlowCode } from './DeviceFlowCode';
import { providerSettingsCopy, tokenCreationUrl } from './sourceControlProviderSettings';

interface ProviderInstanceAccountsProps {
  descriptor: SourceControlProviderDescriptor;
  identity: SourceControlIdentity;
  sourceControl: SourceControlAPI;
  onSaved?: () => void;
}

/**
 * One instance of a source-control provider in its Settings card: the address,
 * its accounts, and the ways to add one. The sign-in methods are the ones the
 * descriptor names and the instance reports available
 * (`capabilities.authenticationMethods`), so a provider offers only what both
 * the server's provider module and this instance support.
 *
 * A personal access token is typed into a password field that starts empty,
 * is cleared once the server accepts it, and is never logged or shown again.
 */
export const ProviderInstanceAccounts: React.FC<ProviderInstanceAccountsProps> = ({ descriptor, identity, sourceControl, onSaved }) => {
  const { t } = useI18n();
  const copy = providerSettingsCopy(descriptor);
  const provider = descriptor.label;
  const cliName = descriptor.auth.cliName ?? '';
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const refreshStatus = useSourceControlAuthStore((state) => state.refreshStatus);
  const setStatus = useSourceControlAuthStore((state) => state.setStatus);
  const authEntry = useSourceControlAuthEntry(identity);
  const [capabilities, setCapabilities] = React.useState<SourceControlCapabilities | null>(null);
  const [capabilitiesFailed, setCapabilitiesFailed] = React.useState(false);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = React.useState(0);
  const [flow, setFlow] = React.useState<SourceControlDeviceFlowStart | null>(null);
  const [pollDelayMs, setPollDelayMs] = React.useState(0);
  const [pollAttempt, setPollAttempt] = React.useState(0);
  const [token, setToken] = React.useState('');
  const [isAddingAccount, setIsAddingAccount] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [operationFailed, setOperationFailed] = React.useState(false);
  const [tokenRejected, setTokenRejected] = React.useState(false);
  const flowRuntimeKeyRef = React.useRef('');
  const runtimeGenerationRef = React.useRef(0);
  const captureRuntime = React.useCallback(() => {
    const runtimeKey = getRuntimeKey();
    const generation = runtimeGenerationRef.current;
    return () => generation === runtimeGenerationRef.current && runtimeKey === getRuntimeKey();
  }, []);
  const status = authEntry?.status ?? null;
  const accounts = status?.accounts ?? [];
  const cli = status && 'cli' in status ? status.cli : undefined;

  const stopFlow = React.useCallback(() => {
    flowRuntimeKeyRef.current = '';
    setFlow(null);
    setPollDelayMs(0);
  }, []);

  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      runtimeGenerationRef.current += 1;
      stopFlow();
    });
    return () => {
      runtimeGenerationRef.current += 1;
      unsubscribe();
    };
  }, [stopFlow]);
  React.useEffect(() => stopFlow(), [identity.instance, identity.provider, stopFlow]);

  React.useEffect(() => {
    let cancelled = false;
    const isCurrentRuntime = captureRuntime();
    setCapabilitiesFailed(false);
    void Promise.all([
      sourceControl.capabilities(identity),
      refreshStatus(sourceControl, identity),
    ]).then(([nextCapabilities]) => {
      if (!cancelled && isCurrentRuntime()) setCapabilities(nextCapabilities);
    }).catch(() => {
      if (!cancelled && isCurrentRuntime()) setCapabilitiesFailed(true);
    });
    return () => { cancelled = true; };
  }, [capabilitiesAttempt, captureRuntime, identity, refreshStatus, sourceControl]);

  React.useEffect(() => {
    if (!flow || pollDelayMs <= 0) return;

    const poll = async () => {
      const isCurrentRuntime = captureRuntime();
      if (flowRuntimeKeyRef.current !== getRuntimeKey()) {
        stopFlow();
        return;
      }

      try {
        const result = await sourceControl.authComplete(identity, flow.flowId);
        if (!isCurrentRuntime() || flowRuntimeKeyRef.current !== getRuntimeKey()) return;
        if (result.status === 'connected') {
          stopFlow();
          setIsAddingAccount(false);
          await refreshStatus(sourceControl, identity, { force: true });
          if (!isCurrentRuntime()) return;
          await refreshInstances(sourceControl, { force: true });
          if (!isCurrentRuntime()) return;
          onSaved?.();
          setOperationFailed(false);
          return;
        }
        if (result.status === 'pending') {
          setPollDelayMs((result.slowDown ? pollDelayMs + 5_000 : pollDelayMs) || 5_000);
          setPollAttempt((attempt) => attempt + 1);
          return;
        }
        stopFlow();
        setOperationFailed(true);
      } catch {
        if (isCurrentRuntime() && flowRuntimeKeyRef.current === getRuntimeKey()) setPollAttempt((attempt) => attempt + 1);
      }
    };

    const timer = window.setTimeout(() => {
      void poll();
    }, pollDelayMs);
    return () => window.clearTimeout(timer);
  }, [captureRuntime, flow, identity, onSaved, pollAttempt, pollDelayMs, refreshInstances, refreshStatus, sourceControl, stopFlow]);

  const startDeviceFlow = async () => {
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      const nextFlow = await sourceControl.authStart(identity);
      if (!isCurrentRuntime()) return;
      flowRuntimeKeyRef.current = getRuntimeKey();
      setFlow(nextFlow);
      setPollAttempt(0);
      setPollDelayMs(Math.max(1, nextFlow.interval) * 1_000);
      await openExternalUrl(nextFlow.verificationUriComplete || nextFlow.verificationUri);
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const saveToken = async () => {
    if (!token.trim()) return;
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      const nextStatus = await sourceControl.authSetToken(identity, token.trim());
      if (!isCurrentRuntime()) return;
      setStatus(identity, nextStatus);
      setToken('');
      setIsAddingAccount(false);
      await refreshStatus(sourceControl, identity, { force: true });
      if (!isCurrentRuntime()) return;
      await refreshInstances(sourceControl, { force: true });
      if (!isCurrentRuntime()) return;
      onSaved?.();
    } catch (error) {
      if (!isCurrentRuntime()) return;
      // The server says whether the token itself was refused; anything else is
      // a failure the person cannot fix by editing what they pasted.
      if (error instanceof Error && 'code' in error && error.code === 'INVALID_TOKEN') setTokenRejected(true);
      else setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const removeAccount = async (accountId: string) => {
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      await sourceControl.authDisconnect(identity, accountId);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, identity, { force: true });
      if (!isCurrentRuntime()) return;
      await refreshInstances(sourceControl, { force: true });
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const switchToAccount = async (accountId: string) => {
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      const nextStatus = await sourceControl.authActivate(identity, accountId);
      if (!isCurrentRuntime()) return;
      setStatus(identity, nextStatus);
      const instances = await refreshInstances(sourceControl, { force: true });
      if (!isCurrentRuntime()) return;
      if (instances.some((item) => item.provider === identity.provider && item.instance === identity.instance)) {
        onSaved?.();
      }
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const toggleCli = async () => {
    if (!cli) return;
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      await sourceControl.authSetCliDisabled(identity, !cli.disabled);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, identity, { force: true });
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const cancelAddAccount = () => {
    setIsAddingAccount(false);
    setFlow(null);
    setPollDelayMs(0);
    setPollAttempt(0);
    setToken('');
    setOperationFailed(false);
    setTokenRejected(false);
  };

  // Offered where the descriptor names the method and this instance reports it available.
  const methods = new Set(descriptor.auth.methods.filter((method) => capabilities?.authenticationMethods[method].available));
  const scopes = descriptor.auth.token?.scopes.join(', ') ?? '';
  const createTokenUrl = tokenCreationUrl(descriptor, identity.instance);
  const connected = accounts.length > 0;
  const showConnectionMethods = !connected || isAddingAccount;
  // The accounts listed below say the instance is connected; the line under
  // the address only speaks when something is in progress or wrong.
  let statusMessage: string | null;
  if (authEntry?.isLoading) {
    statusMessage = t('settings.sourceControl.status.checking');
  } else if (tokenRejected) {
    statusMessage = t(copy.tokenRejected, { provider });
  } else if (operationFailed || capabilitiesFailed || status?.status === 'unreachable') {
    statusMessage = t(copy.operationFailed);
  } else if (accounts.length > 0) {
    statusMessage = null;
  } else {
    statusMessage = t(copy.notConnected);
  }

  return (
    // One group per instance: the address heads it, its accounts and actions
    // follow. Groups part with a line, never a filled box inside the card.
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* The address reads as a host; the full URL stays in the tooltip. */}
          <div className="typography-ui-label truncate font-medium text-foreground" title={identity.instance}>
            {identity.instance.replace(/^https?:\/\//, '')}
          </div>
          {statusMessage ? (
            <div className="typography-meta mt-0.5 text-muted-foreground">
              {statusMessage}
            </div>
          ) : null}
        </div>
        {capabilitiesFailed || status?.status === 'unreachable' ? (
          <Button size="sm" variant="outline" disabled={busy || authEntry?.isLoading} onClick={() => setCapabilitiesAttempt((attempt) => attempt + 1)}>
            {t('sessionAuth.error.retry')}
          </Button>
        ) : null}
      </div>

      {accounts.length > 0 ? (
        <div>
          <SourceControlAccountList
            accounts={accounts}
            avatarAlt={(username) => username}
            currentLabel={t('settings.sourceControl.accounts.inUse')}
            sourceLabel={(account) => account.source === 'cli' ? t(copy.cliLabel, { cli: cliName }) : t(getManagedCredentialSourceLabelKey(account.source))}
            statusLabel={(account) => account.status === 'valid'
              ? null
              : t('settings.sourceControl.accounts.needsAuthentication')}
            renderActions={(account) => (
              <>
                {account.status === 'invalid' && account.source !== 'cli' ? (
                  <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
                    {t('settings.sourceControl.actions.reauthenticate')}
                  </Button>
                ) : null}
                {/* The CLI login is used only after a switch to it; the header switcher is not there while nothing is connected. */}
                {account.source === 'cli' && !account.current ? (
                  <Button size="sm" variant="outline" onClick={() => void switchToAccount(account.id)} disabled={busy}>
                    {t(copy.useCli, { cli: cliName })}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => account.source === 'cli' ? toggleCli() : removeAccount(account.id)}
                  disabled={busy}
                >
                  {account.source === 'cli' ? t(copy.disableCli, { cli: cliName }) : t('settings.sourceControl.actions.remove')}
                </Button>
              </>
            )}
          />
        </div>
      ) : null}

      {connected && !isAddingAccount && (
        <div>
          <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
            {t('settings.github.page.actions.addAccount')}
          </Button>
        </div>
      )}

      {showConnectionMethods && (
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          {methods.has('device') && !flow && (
            <SettingsFieldRow label={t(copy.deviceLabel)}>
              <Button size="sm" onClick={startDeviceFlow} disabled={busy}>{t(copy.connect, { provider })}</Button>
            </SettingsFieldRow>
          )}
          {flow && (
            <DeviceFlowCode
              code={flow.userCode}
              description={t(copy.deviceWaiting, { provider })}
              openLabel={t(copy.openProvider, { provider })}
              onOpen={() => void openExternalUrl(flow.verificationUriComplete || flow.verificationUri)}
              onCancel={cancelAddAccount}
            />
          )}
          {methods.has('pat') && (
            <SettingsFieldRow
              label={t(copy.tokenLabel)}
              info={t(copy.tokenInfo, { scopes })}
              description={createTokenUrl ? (
                <Button size="xs" variant="link" className="h-auto p-0" onClick={() => void openExternalUrl(createTokenUrl)}>
                  {t(copy.createToken)}
                </Button>
              ) : undefined}
            >
              <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
                <Input
                  className="h-8 w-full min-w-0 rounded-md"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  aria-label={t(copy.tokenLabel)}
                  autoComplete="off"
                />
                <Button className="w-full @xl:w-auto" size="sm" onClick={saveToken} disabled={busy || !token.trim()}>{t('settings.common.actions.saveChanges')}</Button>
              </div>
            </SettingsFieldRow>
          )}
          {isAddingAccount && !flow && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={cancelAddAccount} disabled={busy}>
                {t('settings.common.actions.cancel')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* While the CLI login is a listed account, its own row carries the switch. */}
      {descriptor.auth.methods.includes('cli') && (connected || cli?.disabled) && cli && (cli.available || cli.disabled)
        && (cli.disabled || !accounts.some((account) => account.source === 'cli')) && (
        <div>
          <SettingsFieldRow label={t(copy.cliLabel, { cli: cliName })} info={t(copy.cliInfo, { cli: cliName })}>
            <Button size="sm" variant="outline" onClick={toggleCli} disabled={busy}>
              {cli.disabled ? t(copy.enableCli, { cli: cliName }) : t(copy.disableCli, { cli: cliName })}
            </Button>
          </SettingsFieldRow>
        </div>
      )}
    </div>
  );
};

