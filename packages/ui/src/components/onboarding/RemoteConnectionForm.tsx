import { useState, useCallback } from 'react';
import {
  desktopHostsGet,
  desktopHostsSet,
  desktopHostProbe,
  normalizeHostUrl,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isTauriShell } from '@/lib/desktop';
import { m } from '@/lib/i18n/messages';

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
}

type ProbeStatus = HostProbeResult['status'] | null;

function getProbeStatusMessage(status: ProbeStatus): string | null {
  switch (status) {
    case 'ok':
      return null; // Success is shown separately
    case 'auth':
      return m.obServerRequiresAuth();
    case 'wrong-service':
      return m.obWrongService();
    case 'unreachable':
      return m.obServerUnreachable();
    default:
      return null;
  }
}

function isBlockingStatus(status: ProbeStatus): boolean {
  return status === 'wrong-service' || status === 'unreachable';
}

export function RemoteConnectionForm({
  onBack,
  showBackButton = true,
  initialUrl = '',
  initialLabel = '',
  isRecoveryMode = false,
  onConnect,
  onSwitchToLocal,
}: RemoteConnectionFormProps) {
  const [url, setUrl] = useState(initialUrl);
  const [label, setLabel] = useState(initialLabel);
  const [state, setState] = useState<ConnectionState>('idle');
  const [probeResult, setProbeResult] = useState<HostProbeResult | null>(null);
  const [error, setError] = useState('');

  const normalizedUrl = normalizeHostUrl(url);

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
      setState(result.status === 'ok' ? 'success' : 'error');
    } catch (err) {
      setError(err instanceof Error ? err.message : m.obConnectionTestFailed());
      setState('error');
    }
  }, [normalizedUrl]);

  const handleConnect = useCallback(async () => {
    if (!normalizedUrl) return;

    setState('testing');
    setProbeResult(null);
    setError('');

    try {
      const probe = await desktopHostProbe(normalizedUrl);
      setProbeResult(probe);

      // Block connection on wrong-service or unreachable
      if (isBlockingStatus(probe.status)) {
        setState('error');
        return;
      }

      const config = await desktopHostsGet();
      const hostLabel = label.trim() || normalizedUrl;

      const existingHost = config.hosts.find(
        (h) => h.url === normalizedUrl
      );

      const hostId = existingHost ? existingHost.id : `host-${Date.now().toString(16)}`;

      const newHost = {
        id: hostId,
        label: hostLabel,
        url: normalizedUrl,
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

      if (isTauriShell()) {
        const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
        await tauri?.core?.invoke?.('desktop_restart');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : m.obFailedToSaveConnection());
      setState('error');
    }
  }, [normalizedUrl, label, onConnect]);

  const isTesting = state === 'testing';
  const canTest = normalizedUrl !== null && !isTesting;
  const canConnect = normalizedUrl !== null && !isTesting && !isBlockingStatus(probeResult?.status ?? null);

  const probeMessage = getProbeStatusMessage(probeResult?.status ?? null);
  const isSuccess = probeResult?.status === 'ok';
  const isAuth = probeResult?.status === 'auth';
  const isBlocking = isBlockingStatus(probeResult?.status ?? null);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="w-full max-w-md space-y-6">
        {showBackButton && (
          <div className="flex items-center">
            <Button variant="ghost" onClick={onBack} className="p-0 text-muted-foreground hover:text-foreground">
              &larr; {m.obBack()}
            </Button>
          </div>
        )}

        <div className="space-y-2 text-center">
          <h1 className="typography-ui-header text-xl font-semibold text-foreground">
            {isRecoveryMode ? m.obConnectToDifferentServer() : m.obConnectToRemoteServer()}
          </h1>
          <p className="text-muted-foreground text-sm">
            {m.obRemoteServerDescription()}
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="remote-url" className="text-sm text-foreground">
              {m.obServerAddress()}
            </label>
            <Input
              id="remote-url"
              type="url"
              value={url}
              onChange={handleUrlChange}
              placeholder={m.obServerAddressPlaceholder()}
              disabled={isTesting}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="remote-label" className="text-sm text-foreground">
              {m.obServerNameOptional()}
            </label>
            <Input
              id="remote-label"
              type="text"
              value={label}
              onChange={handleLabelChange}
              placeholder={m.obServerNamePlaceholder()}
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
            {m.obConnectedSuccessfully({ latencyMs: probeResult.latencyMs })}
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
            {m.obServerRequiresAuthShort()}
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
              <div className="font-semibold mb-1">{m.obConnectionFailed()}</div>
              <div className="opacity-90">{probeMessage}</div>
            </div>
            <div className="text-xs opacity-80">
              {probeResult.status === 'unreachable'
                ? m.obSuggestionsUnreachable()
                : m.obSuggestionsWrongService()}
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
            {isTesting ? m.obTesting() : m.obTestConnection()}
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!canConnect}
          >
            {m.obConnectAndRestart()}
          </Button>
        </div>

        {/* Suggested actions when connection is blocked */}
        {isBlocking && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground text-center">{m.obWhatWouldYouLikeToDo()}</div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onBack}
                className="flex-1"
              >
                {m.obChooseDifferentServer()}
              </Button>
              {!isRecoveryMode && onSwitchToLocal && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSwitchToLocal}
                  className="flex-1"
                >
                  {m.obUseLocalInstead()}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
