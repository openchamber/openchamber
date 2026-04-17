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
      return 'Server requires authentication. You can still connect, but may need to provide credentials.';
    case 'wrong-service':
      return 'Server responded but is not running OpenChamber. Verify the address points to an OpenChamber server.';
    case 'unreachable':
      return 'Server is unreachable. Check your network connection and verify the server address.';
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
      setError(err instanceof Error ? err.message : 'Connection test failed');
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
      setError(err instanceof Error ? err.message : 'Failed to save connection');
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
              &larr; Back
            </Button>
          </div>
        )}

        <div className="space-y-2 text-center">
          <h1 className="typography-ui-header text-xl font-semibold text-foreground">
            {isRecoveryMode ? 'Connect to a Different Server' : 'Connect to Remote Server'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isRecoveryMode
              ? 'Enter the address of an OpenChamber server to connect to.'
              : 'Enter the address of an OpenChamber server to connect to.'}
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="remote-url" className="text-sm text-foreground">
              Server Address
            </label>
            <Input
              id="remote-url"
              type="url"
              value={url}
              onChange={handleUrlChange}
              placeholder="https://your-server.example.com:4096"
              disabled={isTesting}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="remote-label" className="text-sm text-foreground">
              Name (optional)
            </label>
            <Input
              id="remote-label"
              type="text"
              value={label}
              onChange={handleLabelChange}
              placeholder="My Remote Server"
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
            Connected successfully ({probeResult.latencyMs}ms)
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
            Server requires authentication. You can still connect.
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
              <div className="font-semibold mb-1">Connection Failed</div>
              <div className="opacity-90">{probeMessage}</div>
            </div>
            <div className="text-xs opacity-80">
              {probeResult.status === 'unreachable'
                ? 'Suggestions: Check the server address, verify the server is running, or check your network connection.'
                : 'Suggestions: Verify the URL points to an OpenChamber server, or contact the server administrator.'}
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
            {isTesting ? 'Testing\u2026' : 'Test Connection'}
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!canConnect}
          >
            Connect &amp; Restart
          </Button>
        </div>

        {/* Suggested actions when connection is blocked */}
        {isBlocking && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground text-center">What would you like to do?</div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onBack}
                className="flex-1"
              >
                Choose Different Server
              </Button>
              {!isRecoveryMode && onSwitchToLocal && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSwitchToLocal}
                  className="flex-1"
                >
                  Use Local Instead
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
