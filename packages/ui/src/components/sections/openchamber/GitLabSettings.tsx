import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import type {
  SourceControlCapabilities,
  SourceControlAPI,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
} from '@/lib/api/types';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { getSourceControlAuthKey, useSourceControlAuthEntry, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { SourceControlAccountList } from './SourceControlAccountList';
import { DeviceFlowCode } from './DeviceFlowCode';

const DEFAULT_GITLAB_IDENTITY: SourceControlIdentity = { provider: 'gitlab', instance: 'https://gitlab.com' };

/** Sub-block inside the card body, same row chrome the Linear card uses for its workspaces. */
const INSTANCE_BLOCK_CLASS = 'overflow-hidden rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-muted)]';
const INSTANCE_ROW_CLASS = 'px-3 py-3';
const INSTANCE_ROW_DIVIDER_CLASS = 'border-t border-[var(--surface-subtle)]';

const normalizeGitLabIdentity = (value: string): SourceControlIdentity | null => {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
    const hasUnsupportedParts = Boolean(
      url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname && url.pathname !== '/'),
    );
    const hasSupportedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);

    if (hasUnsupportedParts || !hasSupportedProtocol) return null;
    return { provider: 'gitlab', instance: url.origin };
  } catch {
    return null;
  }
};

interface GitLabInstanceItemProps {
  identity: SourceControlIdentity;
  sourceControl: SourceControlAPI;
  onSaved?: () => void;
}

const GitLabInstanceItem: React.FC<GitLabInstanceItemProps> = ({ identity, sourceControl, onSaved }) => {
  const { t } = useI18n();
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

  const connected = accounts.length > 0;
  const showConnectionMethods = !connected || isAddingAccount;
  let statusMessage: string;
  if (authEntry?.isLoading) {
    statusMessage = t('settings.gitlab.status.checking');
  } else if (tokenRejected) {
    statusMessage = t('settings.gitlab.status.tokenRejected');
  } else if (operationFailed || capabilitiesFailed || status?.status === 'unreachable') {
    statusMessage = t('settings.gitlab.status.operationFailed');
  } else if (accounts.length > 0) {
    statusMessage = t('settings.sourceControl.accounts.configured');
  } else {
    statusMessage = t('settings.gitlab.status.notConnected');
  }

  return (
    <div className={INSTANCE_BLOCK_CLASS}>
      <div className={cn(INSTANCE_ROW_CLASS, 'flex items-start justify-between gap-4')}>
        <div className="min-w-0">
          <div className="typography-ui-label truncate text-foreground">{identity.instance}</div>
          <div className="typography-meta mt-0.5 text-muted-foreground">
            {statusMessage}
          </div>
        </div>
        {capabilitiesFailed || status?.status === 'unreachable' ? (
          <Button size="sm" variant="outline" disabled={busy || authEntry?.isLoading} onClick={() => setCapabilitiesAttempt((attempt) => attempt + 1)}>
            {t('sessionAuth.error.retry')}
          </Button>
        ) : null}
      </div>

      {accounts.length > 0 ? (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <SourceControlAccountList
            accounts={accounts}
            avatarAlt={(username) => username}
            currentLabel={t('settings.sourceControl.accounts.inUse')}
            sourceLabel={(account) => t(account.source === 'cli' ? 'settings.gitlab.cli.label' : getManagedCredentialSourceLabelKey(account.source))}
            statusLabel={(account) => account.status === 'valid'
              ? t('settings.sourceControl.accounts.available')
              : t('settings.sourceControl.accounts.needsAuthentication')}
            renderActions={(account) => (
              <>
                {account.status === 'invalid' && account.source !== 'cli' ? (
                  <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
                    {t('settings.sourceControl.actions.reauthenticate')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => account.source === 'cli' ? toggleCli() : removeAccount(account.id)}
                  disabled={busy}
                >
                  {account.source === 'cli' ? t('settings.gitlab.actions.disableCli') : t('settings.sourceControl.actions.remove')}
                </Button>
              </>
            )}
          />
        </div>
      ) : null}

      {connected && !isAddingAccount && (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
            {t('settings.github.page.actions.addAccount')}
          </Button>
        </div>
      )}

      {showConnectionMethods && (
        <div className={cn(SETTINGS_FIELDS_STACK_CLASS, INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          {capabilities?.authenticationMethods.device.available && !flow && (
            <SettingsFieldRow label={t('settings.gitlab.device.label')}>
              <Button size="sm" onClick={startDeviceFlow} disabled={busy}>{t('settings.gitlab.actions.connect')}</Button>
            </SettingsFieldRow>
          )}
          {flow && (
            <DeviceFlowCode
              code={flow.userCode}
              description={t('settings.gitlab.device.waiting')}
              openLabel={t('settings.gitlab.actions.openGitLab')}
              onOpen={() => void openExternalUrl(flow.verificationUriComplete || flow.verificationUri)}
              onCancel={cancelAddAccount}
            />
          )}
          {capabilities?.authenticationMethods.pat.available && (
            <SettingsFieldRow label={t('settings.gitlab.token.label')} info={t('settings.gitlab.token.info')}>
              <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
                <Input
                  className="h-8 w-full min-w-0 rounded-md"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  aria-label={t('settings.gitlab.token.label')}
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

      {(connected || cli?.disabled) && cli && (cli.available || cli.disabled) && (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <SettingsFieldRow label={t('settings.gitlab.cli.label')} info={t('settings.gitlab.cli.info')}>
            <Button size="sm" variant="outline" onClick={toggleCli} disabled={busy}>
              {cli.disabled ? t('settings.gitlab.actions.enableCli') : t('settings.gitlab.actions.disableCli')}
            </Button>
          </SettingsFieldRow>
        </div>
      )}
    </div>
  );
};

/**
 * The GitLab row of Settings → Integrations → Built-in integrations. Same
 * collapsible card as the GitHub and Linear rows beside it: the collapsed row
 * answers "am I connected?", the body lists the instances and their accounts.
 */
export const GitLabSettings: React.FC = () => {
  const { t } = useI18n();
  const sourceControl = getRegisteredRuntimeAPIs()?.sourceControl;
  const identities = useSourceControlAuthStore((state) => state.identities);
  const entries = useSourceControlAuthStore((state) => state.entries);
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const [open, setOpen] = React.useState(false);
  const [pendingIdentity, setPendingIdentity] = React.useState<SourceControlIdentity | null>(null);
  const [instanceInput, setInstanceInput] = React.useState('');
  const [isAddingInstance, setIsAddingInstance] = React.useState(false);
  const [instanceFailed, setInstanceFailed] = React.useState(false);
  const clearPendingIdentity = React.useCallback(() => setPendingIdentity(null), []);
  const gitLabIdentities = identities.filter((item) => item.provider === 'gitlab');
  const visibleIdentities = [...gitLabIdentities];
  if (pendingIdentity && !gitLabIdentities.some((item) => item.instance === pendingIdentity.instance)) {
    visibleIdentities.push(pendingIdentity);
  }
  if (visibleIdentities.length === 0) visibleIdentities.push(DEFAULT_GITLAB_IDENTITY);

  React.useEffect(() => {
    if (sourceControl) void refreshInstances(sourceControl);
  }, [refreshInstances, sourceControl]);

  const applyInstance = () => {
    const normalized = normalizeGitLabIdentity(instanceInput);
    if (!normalized) {
      setInstanceFailed(true);
      return;
    }
    setPendingIdentity(normalized);
    setInstanceInput('');
    setIsAddingInstance(false);
    setInstanceFailed(false);
  };

  if (!sourceControl) return null;

  const instanceEntries = gitLabIdentities.map((identity) => entries[getSourceControlAuthKey(identity)]);
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
        : connectedAccount.user.username.trim() || t('settings.gitlab.status.connected')
      : t('settings.gitlab.status.notConnected');
  const statusClassName = connected
    ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
    : 'bg-[var(--surface-muted)] text-muted-foreground';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-settings-item="git.gitlab-account"
        className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
      >
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name="gitlab-fill" className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('settings.gitlab.title')}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t('settings.gitlab.info')}
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
          <SettingsControlGroup
            title={t('settings.gitlab.instances.title')}
            contentClassName="space-y-3"
            settingsItem="git.gitlab-connect"
          >
            {visibleIdentities.map((item) => (
              <GitLabInstanceItem
                key={`${getRuntimeKey()}:${item.instance}`}
                identity={item}
                sourceControl={sourceControl}
                onSaved={pendingIdentity?.instance === item.instance ? clearPendingIdentity : undefined}
              />
            ))}

            {isAddingInstance ? (
              <div className={cn(INSTANCE_BLOCK_CLASS, INSTANCE_ROW_CLASS)}>
                <SettingsFieldRow
                  label={t('settings.gitlab.instance.customLabel')}
                  info={t('settings.gitlab.instance.customInfo')}
                  description={instanceFailed ? t('settings.gitlab.status.operationFailed') : undefined}
                >
                  <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
                    <Input
                      className="h-8 w-full min-w-0 rounded-md"
                      value={instanceInput}
                      onChange={(event) => setInstanceInput(event.target.value)}
                      placeholder="https://gitlab.example.com"
                      aria-label={t('settings.gitlab.instance.customLabel')}
                    />
                    <Button className="w-full @xl:w-auto" size="sm" onClick={applyInstance}>{t('settings.gitlab.actions.useInstance')}</Button>
                    <Button className="w-full @xl:w-auto" size="sm" variant="ghost" onClick={() => {
                      setInstanceInput('');
                      setIsAddingInstance(false);
                      setInstanceFailed(false);
                    }}>
                      {t('settings.common.actions.cancel')}
                    </Button>
                  </div>
                </SettingsFieldRow>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setIsAddingInstance(true)}>
                {t('settings.gitlab.actions.addInstance')}
              </Button>
            )}
          </SettingsControlGroup>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
