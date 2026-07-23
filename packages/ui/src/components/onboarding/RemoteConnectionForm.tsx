import { useState, useCallback, useEffect } from 'react';
import {
  desktopHostsGet,
  desktopHostsSet,
  desktopHostProbe,
  resolveDesktopHostUrl,
  importDesktopHostPairing,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

type ConnectionState = 'idle' | 'testing' | 'success' | 'error';

export interface RemoteConnectionFormProps {
  onBack: () => void;
  /** Optional: show the back button (default: true) */
  showBackButton?: boolean;
  /** Optional: initial URL to pre-populate */
  initialUrl?: string;
  /** Optional: initial label to pre-populate */
  initialLabel?: string;
  /** Optional: show recovery mode styling/behavior */
  isRecoveryMode?: boolean;
  /** Optional: callback when successfully connected */
  onConnect?: () => void;
  /** Optional: callback when user wants to switch to local setup */
  onSwitchToLocal?: () => void;
  showInstancePicker?: boolean;
}

type ProbeStatus = HostProbeResult['status'] | null;

function getProbeStatusMessageKey(status: ProbeStatus): string | null {
  switch (status) {
    case 'ok':
      return null; // Success is shown separately
    case 'auth':
      return 'onboarding.remoteConnection.probe.authMessage';
    case 'update-recommended':
      return 'onboarding.remoteConnection.probe.updateRecommendedMessage';
    case 'incompatible':
      return 'onboarding.remoteConnection.probe.incompatibleMessage';
    case 'wrong-service':
      return 'onboarding.remoteConnection.probe.wrongServiceMessage';
    case 'unreachable':
      return 'onboarding.remoteConnection.probe.unreachableMessage';
    default:
      return null;
  }
}

function isBlockingStatus(status: ProbeStatus): boolean {
  return status === 'wrong-service' || status === 'unreachable' || status === 'incompatible';
}

export function RemoteConnectionForm({
  onBack,
  showBackButton = true,
  initialUrl = '',
  initialLabel = '',
  isRecoveryMode = false,
  onConnect,
  onSwitchToLocal,
  showInstancePicker = false,
}: RemoteConnectionFormProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState(initialUrl);
  const [label, setLabel] = useState(initialLabel);
  const [state, setState] = useState<ConnectionState>('idle');
  const [probeResult, setProbeResult] = useState<HostProbeResult | null>(null);
  const [error, setError] = useState('');
  const [hosts, setHosts] = useState<DesktopHost[]>([]);
  const [view, setView] = useState<'instances' | 'add' | 'import'>(() => showInstancePicker ? 'instances' : 'add');
  const [connectLink, setConnectLink] = useState('');

  useEffect(() => {
    if (!showInstancePicker) return;
    void desktopHostsGet().then((config) => setHosts(config.hosts)).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [showInstancePicker]);

  const resolvedUrl = resolveDesktopHostUrl(url);
  const normalizedUrl = resolvedUrl?.persistedUrl ?? null;

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(e.target.value);
    setState('idle');
    setProbeResult(null);
    setError('');
  }, []);

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
  }, []);

  const handleTest = useCallback(async () => {
    if (!normalizedUrl) return;

    setState('testing');
    setProbeResult(null);
    setError('');

    try {
      const result = await desktopHostProbe(normalizedUrl);
      setProbeResult(result);
      setState(result.status === 'ok' || result.status === 'update-recommended' ? 'success' : 'error');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.remoteConnection.errors.connectionTestFailed'));
      setState('error');
    }
  }, [normalizedUrl, t]);

  const handleConnect = useCallback(async () => {
    if (!resolvedUrl) return;
    const targetUrl = resolvedUrl.persistedUrl;

    setState('testing');
    setProbeResult(null);
    setError('');

    try {
      const probe = await desktopHostProbe(targetUrl);
      setProbeResult(probe);

      // Block connection on wrong-service or unreachable
      if (isBlockingStatus(probe.status)) {
        setState('error');
        return;
      }

      const config = await desktopHostsGet();
      const hostLabel = label.trim() || targetUrl;

      const existingHost = config.hosts.find(
        (h) => h.url === targetUrl
      );

      const hostId = existingHost ? existingHost.id : `host-${Date.now().toString(16)}`;

      const newHost = {
        id: hostId,
        label: hostLabel,
        url: targetUrl,
        apiUrl: targetUrl,
      };

      const updatedHosts = existingHost
        ? config.hosts.map((h) => (h.id === hostId ? newHost : h))
        : [...config.hosts, newHost];

      // Set as default and mark initial choice completed
      await desktopHostsSet({
        hosts: updatedHosts,
        defaultHostId: hostId,
        initialHostChoiceCompleted: true,
      });

      onConnect?.();

      if (resolvedUrl.redeemUrl) {
        window.location.assign(resolvedUrl.redeemUrl);
        return;
      }

      if (isDesktopShell()) {
        await restartDesktopApp();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.remoteConnection.errors.failedToSaveConnection'));
      setState('error');
    }
  }, [resolvedUrl, label, onConnect, t]);

  const selectHost = useCallback(async (hostId: string) => {
    const config = await desktopHostsGet();
    await desktopHostsSet({
      hosts: config.hosts,
      defaultHostId: hostId,
      initialHostChoiceCompleted: true,
    });
    await restartDesktopApp();
  }, []);

  const handleImport = useCallback(async () => {
    setState('testing');
    setError('');
    try {
      const config = await desktopHostsGet();
      const imported = await importDesktopHostPairing(connectLink, config.hosts);
      await desktopHostsSet({
        hosts: imported.hosts,
        defaultHostId: imported.hostId,
        initialHostChoiceCompleted: true,
      });
      await restartDesktopApp();
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'invalid-connect-link'
          ? t('settings.remoteInstances.direct.error.invalidConnectLink')
          : t('onboarding.remoteConnection.errors.failedToSaveConnection'),
      );
      setState('error');
    }
  }, [connectLink, t]);

  const isTesting = state === 'testing';
  const canTest = normalizedUrl !== null && !isTesting;
  const canConnect = normalizedUrl !== null && !isTesting && !isBlockingStatus(probeResult?.status ?? null);

  const probeMessageKey = getProbeStatusMessageKey(probeResult?.status ?? null);
  const isSuccess = probeResult?.status === 'ok';
  const isUpdateRecommended = probeResult?.status === 'update-recommended';
  const isAuth = probeResult?.status === 'auth';
  const isBlocking = isBlockingStatus(probeResult?.status ?? null);

  if (showInstancePicker && view === 'instances') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="typography-ui-header text-xl font-semibold text-foreground">
              {t('desktopHostSwitcher.actions.switchInstance')}
            </h1>
            <p className="text-muted-foreground text-sm">{t('settings.remoteInstances.direct.description')}</p>
          </div>
          {error ? <div className="text-sm text-[var(--status-error)]">{error}</div> : null}
          <div className="space-y-2">
            {hosts.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t('settings.remoteInstances.direct.state.empty')}
              </div>
            ) : hosts.map((host) => (
              <Button
                key={host.id}
                variant="outline"
                className="w-full justify-start"
                onClick={() => void selectHost(host.id)}
              >
                <span className="min-w-0 truncate">{host.label}</span>
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setView('import')}>
              {t('settings.remoteInstances.direct.import.action')}
            </Button>
            <Button className="flex-1" onClick={() => setView('add')}>
              {t('settings.remoteInstances.direct.actions.add')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (showInstancePicker && view === 'import') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="w-full max-w-md space-y-6">
          <Button variant="ghost" onClick={() => setView('instances')} className="p-0 text-muted-foreground">
            {t('onboarding.common.actions.back')}
          </Button>
          <div className="space-y-2 text-center">
            <h1 className="typography-ui-header text-xl font-semibold text-foreground">
              {t('settings.remoteInstances.direct.import.action')}
            </h1>
            <p className="text-muted-foreground text-sm">{t('settings.remoteInstances.direct.import.description')}</p>
          </div>
          <Input
            value={connectLink}
            onChange={(event) => setConnectLink(event.target.value)}
            placeholder={t('settings.remoteInstances.direct.import.placeholder')}
            disabled={isTesting}
            autoFocus
          />
          {error ? <div className="text-sm text-[var(--status-error)]">{error}</div> : null}
          <Button onClick={() => void handleImport()} disabled={isTesting || !connectLink.trim()}>
            {t('settings.remoteInstances.direct.import.action')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="w-full max-w-md space-y-6">
        {(showBackButton || showInstancePicker) && (
          <div className="flex items-center">
            <Button variant="ghost" onClick={showInstancePicker ? () => setView('instances') : onBack} className="p-0 text-muted-foreground hover:text-foreground">
              {t('onboarding.common.actions.back')}
            </Button>
          </div>
        )}

        <div className="space-y-2 text-center">
            <h1 className="typography-ui-header text-xl font-semibold text-foreground">
            {isRecoveryMode
              ? t('onboarding.remoteConnection.titleRecovery')
              : t('onboarding.remoteConnection.title')}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t('onboarding.remoteConnection.description')}
            </p>
          </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="remote-url" className="text-sm text-foreground">
              {t('onboarding.remoteConnection.field.serverAddress')}
            </label>
            <Input
              id="remote-url"
              type="url"
              value={url}
              onChange={handleUrlChange}
              placeholder={t('onboarding.remoteConnection.field.serverAddressPlaceholder')}
              disabled={isTesting}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="remote-label" className="text-sm text-foreground">
              {t('onboarding.remoteConnection.field.nameOptional')}
            </label>
            <Input
              id="remote-label"
              type="text"
              value={label}
              onChange={handleLabelChange}
              placeholder={t('onboarding.remoteConnection.field.namePlaceholder')}
              disabled={isTesting}
            />
          </div>
        </div>

        {/* Success message */}
        {probeResult && isSuccess && (
          <div
            className="rounded-lg border p-3 text-sm"
            style={{
              borderColor: 'var(--status-success)',
              color: 'var(--status-success)',
            }}
          >
            {t('onboarding.remoteConnection.status.connectedSuccessfully', { latencyMs: probeResult.latencyMs })}
          </div>
        )}

        {/* Auth warning (non-blocking) */}
        {probeResult && isAuth && (
          <div
            className="rounded-lg border p-3 text-sm"
            style={{
              borderColor: 'var(--status-warning)',
              color: 'var(--status-warning)',
            }}
          >
            {t('onboarding.remoteConnection.status.authWarning')}
          </div>
        )}

        {probeResult && isUpdateRecommended && (
          <div
            className="rounded-lg border p-3 text-sm"
            style={{
              borderColor: 'var(--status-warning)',
              color: 'var(--status-warning)',
            }}
          >
            {probeMessageKey ? t(probeMessageKey as Parameters<typeof t>[0]) : null}
          </div>
        )}

        {/* Blocking errors */}
        {probeResult && isBlocking && (
          <div
            className="rounded-lg border p-3 text-sm space-y-3"
            style={{
              borderColor: 'var(--status-error)',
              color: 'var(--status-error)',
            }}
          >
            <div>
              <div className="font-semibold mb-1">{t('onboarding.remoteConnection.status.connectionFailed')}</div>
              <div className="opacity-90">{probeMessageKey ? t(probeMessageKey as Parameters<typeof t>[0]) : null}</div>
            </div>
            <div className="text-xs opacity-80">
              {probeResult.status === 'unreachable'
                ? t('onboarding.remoteConnection.status.suggestionsUnreachable')
                : t('onboarding.remoteConnection.status.suggestionsWrongService')}
            </div>
          </div>
        )}

        {/* Generic error */}
        {error && (
          <div
            className="rounded-lg border p-3 text-sm"
            style={{
              borderColor: 'var(--status-error)',
              color: 'var(--status-error)',
            }}
          >
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={!canTest}
          >
            {isTesting ? t('onboarding.remoteConnection.actions.testing') : t('onboarding.remoteConnection.actions.testConnection')}
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!canConnect}
          >
            {t('onboarding.remoteConnection.actions.connectAndRestart')}
          </Button>
        </div>

        {/* Suggested actions when connection is blocked */}
        {isBlocking && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground text-center">{t('onboarding.remoteConnection.actions.whatToDo')}</div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onBack}
                className="flex-1"
              >
                {t('onboarding.remoteConnection.actions.chooseDifferentServer')}
              </Button>
              {!isRecoveryMode && onSwitchToLocal && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSwitchToLocal}
                  className="flex-1"
                >
                  {t('onboarding.remoteConnection.actions.useLocalInstead')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
