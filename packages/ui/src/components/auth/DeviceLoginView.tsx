import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import {
  buildDevicePairingPayload,
  DeviceFlowRequestError,
  parseDevicePairingPayload,
  pollDeviceToken,
  startDeviceFlow,
  type DevicePollingState,
  type DeviceStartResponse,
} from '@/lib/auth/deviceFlow';
import { resolveInstanceApiBaseUrlAfterLogin } from '@/lib/auth/resolveInstanceAfterLogin';
import { setToken } from '@/lib/auth/tokenStorage';
import { useInstancesStore } from '@/stores/useInstancesStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  getQrScannerAvailability,
  getRuntimeDevicePlatformMetadata,
  isNativeMobileApp,
  openExternalUrl,
  scanQrCodeFromCamera,
  writeTextToClipboard,
} from '@/lib/desktop';

type DeviceLoginViewProps = {
  forceOpen?: boolean;
};

type FlowState = 'idle' | 'starting' | 'pending' | 'denied' | 'expired' | 'error' | 'success';

const describeStartFlowError = (error: unknown, instanceUrl: string): string => {
  const origin = (() => {
    try {
      return new URL(instanceUrl).origin;
    } catch {
      return instanceUrl;
    }
  })();

  if (error instanceof DeviceFlowRequestError) {
    if (error.code === 'network_error') {
      return `Connection error: unable to reach ${origin}. Check URL, network, and that server is running.`;
    }
    if (error.code === 'server_error') {
      return 'Server error: the instance failed to create a device login request. Try again in a moment.';
    }
    if (error.code === 'auth_required') {
      return 'Authentication error: this instance rejected device login request.';
    }
    if (error.code === 'invalid_response') {
      return 'Protocol error: instance returned an invalid device-login response.';
    }
    const detail = error.details || error.message || error.code;
    return `Device login failed: ${detail}`;
  }

  const fallback = error instanceof Error ? error.message : String(error ?? 'unknown_error');
  if (fallback === 'access_denied') {
    return 'Request declined from the server approval prompt.';
  }
  if (fallback === 'expired_token') {
    return 'The device code expired before approval. Start login again.';
  }
  return `Device login failed: ${fallback}`;
};

export const DeviceLoginView: React.FC<DeviceLoginViewProps> = ({ forceOpen = false }) => {
  const instances = useInstancesStore((state) => state.instances);
  const addInstance = useInstancesStore((state) => state.addInstance);
  const setCurrentInstance = useInstancesStore((state) => state.setCurrentInstance);
  const setDefaultInstance = useInstancesStore((state) => state.setDefaultInstance);
  const touchInstance = useInstancesStore((state) => state.touchInstance);
  const setDeviceLoginOpen = useUIStore((state) => state.setDeviceLoginOpen);

  const [instanceUrl, setInstanceUrl] = React.useState('');
  const [deviceName, setDeviceName] = React.useState('');
  const [phase, setPhase] = React.useState<FlowState>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [pollState, setPollState] = React.useState<DevicePollingState | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = React.useState(5000);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [flow, setFlow] = React.useState<(DeviceStartResponse & { apiBaseUrl: string }) | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number>(0);
  const [isScanningQr, setIsScanningQr] = React.useState(false);
  const [isCheckingScannerAvailability, setIsCheckingScannerAvailability] = React.useState(false);
  const [scannerUnavailableReason, setScannerUnavailableReason] = React.useState<string | null>(null);
  const pollAbortRef = React.useRef<AbortController | null>(null);
  const isNativeMobile = React.useMemo(() => isNativeMobileApp(), []);

  const canClose = forceOpen ? instances.length > 0 : true;

  const clearPolling = React.useCallback(() => {
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  React.useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      setSecondsLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  React.useEffect(() => {
    if (!flow) {
      setQrDataUrl(null);
      return;
    }

    if (isNativeMobile) {
      setQrDataUrl(null);
      return;
    }

    const payload = buildDevicePairingPayload(flow.apiBaseUrl);
    void QRCode.toDataURL(payload, {
      margin: 1,
      width: 180,
      errorCorrectionLevel: 'M',
    })
      .then((next: string) => {
        setQrDataUrl(next);
      })
      .catch(() => {
        setQrDataUrl(null);
      });
  }, [flow, isNativeMobile]);

  React.useEffect(() => {
    if (!isNativeMobile) {
      setIsCheckingScannerAvailability(false);
      setScannerUnavailableReason(null);
      return;
    }

    let cancelled = false;
    setIsCheckingScannerAvailability(true);
    void getQrScannerAvailability()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setScannerUnavailableReason(status.available ? null : status.reason || 'Camera unavailable for QR scanning.');
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setScannerUnavailableReason('Unable to verify camera availability. You can still use manual URL entry.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingScannerAvailability(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isNativeMobile]);

  const resetFlow = React.useCallback(() => {
    clearPolling();
    setFlow(null);
    setPhase('idle');
    setErrorMessage(null);
    setPollState(null);
    setPollIntervalMs(5000);
    setExpiresAt(null);
  }, [clearPolling]);

  const handleCancel = React.useCallback(() => {
    resetFlow();
    if (canClose) {
      setDeviceLoginOpen(false);
    }
  }, [canClose, resetFlow, setDeviceLoginOpen]);

  const handleStart = React.useCallback(async () => {
    setPhase('starting');
    setErrorMessage(null);

    let resolved;
    try {
      resolved = resolveInstanceApiBaseUrlAfterLogin({ enteredUrl: instanceUrl });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid instance URL';
      setPhase('error');
      setErrorMessage(reason);
      toast.error('Invalid instance URL', {
        description: `${reason}. Expected: https://host or https://host/api`,
      });
      return;
    }

    try {
      clearPolling();
      const platform = await getRuntimeDevicePlatformMetadata();
      const started = await startDeviceFlow(resolved.apiBaseUrl, {
        name: deviceName.trim() || undefined,
        platform,
        verificationApiBaseUrl: resolved.apiBaseUrl,
      });
      const nextFlow = {
        ...started,
        apiBaseUrl: resolved.apiBaseUrl,
      };
      setFlow(nextFlow);
      setPhase('pending');
      setPollState('authorization_pending');
      setPollIntervalMs(Math.max(1000, started.interval * 1000));
      setExpiresAt(Date.now() + (started.expiresIn * 1000));

      const abortController = new AbortController();
      pollAbortRef.current = abortController;

      const token = await pollDeviceToken(resolved.apiBaseUrl, {
        deviceCode: started.deviceCode,
        intervalSeconds: started.interval,
        signal: abortController.signal,
        onUpdate: (update) => {
          setPollState(update.state);
          setPollIntervalMs(update.intervalMs);
        },
      });

      const instanceId = addInstance({
        apiBaseUrl: resolved.apiBaseUrl,
        label: resolved.origin,
      });
      setToken(instanceId, {
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        expiresIn: token.expiresIn,
      });
      setDefaultInstance(instanceId);
      setCurrentInstance(instanceId);
      touchInstance(instanceId);

      clearPolling();
      setPhase('success');
      setDeviceLoginOpen(false);
      toast.success('Device approved. Opening app...');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      const message = describeStartFlowError(error, resolved.apiBaseUrl);
      const rawCode = error instanceof Error ? error.message : '';
      if (rawCode === 'access_denied') {
        setPhase('denied');
      } else if (rawCode === 'expired_token') {
        setPhase('expired');
      } else {
        setPhase('error');
      }
      setErrorMessage(message);
      toast.error('Device login failed', {
        description: message,
      });
    }
  }, [addInstance, clearPolling, deviceName, instanceUrl, setCurrentInstance, setDefaultInstance, setDeviceLoginOpen, touchInstance]);

  const handleScanQr = React.useCallback(async () => {
    if (scannerUnavailableReason) {
      toast.error('Camera unavailable', {
        description: scannerUnavailableReason,
      });
      return;
    }

    setIsScanningQr(true);
    try {
      const result = await scanQrCodeFromCamera();
      if (result.status === 'cancelled') {
        toast.info('QR scan cancelled', {
          description: result.message || 'Scanning was cancelled before a QR code was captured.',
        });
        return;
      }
      if (result.status === 'denied') {
        toast.error('Camera permission denied', {
          description: 'Grant camera permission to OpenChamber and retry QR scan.',
        });
        return;
      }
      if (result.status === 'unavailable') {
        toast.error('QR scanning is only available on mobile app runtime');
        return;
      }
      if (result.status === 'camera_unavailable') {
        setScannerUnavailableReason(result.message || 'Camera unavailable for QR scanning.');
        toast.error('Camera unavailable', {
          description: result.message || 'Scanner could not access a camera. On simulator, use manual URL entry or a physical device.',
        });
        return;
      }
      if (result.status !== 'ok') {
        toast.error('Failed to scan QR code', {
          description: result.message || 'Unknown scanner error',
        });
        return;
      }

      const parsed = parseDevicePairingPayload(result.content);
      if (!parsed) {
        toast.error('Invalid pairing QR');
        return;
      }

      setInstanceUrl(parsed.apiBaseUrl);
      toast.success('Instance URL captured from QR');
    } finally {
      setIsScanningQr(false);
    }
  }, [scannerUnavailableReason]);

  const handleCopy = React.useCallback(async (text: string, label: string) => {
    try {
      const copied = await writeTextToClipboard(text);
      if (!copied) {
        throw new Error('copy_failed');
      }
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  }, []);

  const openVerificationUrl = React.useCallback(async (url: string) => {
    const opened = await openExternalUrl(url);
    if (!opened && typeof window !== 'undefined') {
      window.location.assign(url);
    }
  }, []);

  const canStart = phase !== 'starting' && phase !== 'pending' && instanceUrl.trim().length > 0;
  const waiting = phase === 'pending';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: 'radial-gradient(110% 150% at 50% -30%, var(--surface-overlay) 0%, transparent 68%)' }} />

      <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-border/50 bg-card/90 p-4 shadow-sm backdrop-blur sm:p-6">
        <div className="mb-4 space-y-1">
          <h1 className="typography-ui-header font-semibold text-foreground">Device Login</h1>
          <p className="typography-meta text-muted-foreground">Add a remote OpenChamber instance and approve this device from Settings.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="device-instance-url" className="typography-ui-label text-foreground">Instance URL</label>
              {isNativeMobile ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={waiting || isScanningQr || phase === 'starting' || Boolean(scannerUnavailableReason)}
                  onClick={() => void handleScanQr()}
                >
                  {isScanningQr ? 'Scanning...' : 'Scan QR'}
                </Button>
              ) : null}
            </div>
            <Input
              id="device-instance-url"
              value={instanceUrl}
              onChange={(event) => setInstanceUrl(event.target.value)}
              placeholder="https://example.com or https://example.com/api"
              disabled={waiting || isScanningQr}
            />
            {isNativeMobile && isCheckingScannerAvailability ? (
              <p className="typography-micro text-muted-foreground">Checking camera availability...</p>
            ) : null}
            {isNativeMobile && scannerUnavailableReason ? (
              <p className="typography-micro text-status-warning">QR scan unavailable: {scannerUnavailableReason}</p>
            ) : null}
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="device-name" className="typography-ui-label text-foreground">Device Name (optional)</label>
            <Input
              id="device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="My phone"
              disabled={waiting}
            />
          </div>
        </div>

        {!flow ? null : (
          <div className="mt-4 grid gap-4 rounded-xl border border-border/50 bg-background/60 p-3 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="space-y-2">
              <div>
                <div className="typography-meta text-muted-foreground">Code</div>
                <div className="typography-ui-header font-mono text-foreground">{flow.userCode}</div>
              </div>
              <div>
                <div className="typography-meta text-muted-foreground">Verification URL</div>
                <div className="typography-meta break-all text-foreground">{flow.verificationUriComplete || flow.verificationUri}</div>
              </div>
              <div className="typography-meta text-muted-foreground">Expires in {secondsLeft}s</div>
              <div className="typography-meta text-muted-foreground">Polling every {Math.max(1, Math.round(pollIntervalMs / 1000))}s {pollState ? `(${pollState})` : ''}</div>
            </div>

            <div className="flex flex-col items-center gap-2">
              {!isNativeMobile && qrDataUrl ? <img src={qrDataUrl} alt="Device login QR" className="h-[180px] w-[180px] rounded border border-border/60 bg-background" /> : null}
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy(flow.userCode, 'Code')}>Copy Code</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void openVerificationUrl(flow.verificationUriComplete || flow.verificationUri)}>Open Verification</Button>
            </div>
          </div>
        )}

        {errorMessage ? (
          <div className="mt-3 rounded-lg border border-status-error-border bg-status-error-background px-3 py-2 typography-meta text-status-error-foreground">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void handleStart()} disabled={!canStart}>{waiting ? 'Waiting for approval...' : 'Add'}</Button>
          {flow ? <Button type="button" variant="outline" onClick={resetFlow}>Retry</Button> : null}
          <Button type="button" variant="ghost" onClick={handleCancel} disabled={!canClose && !flow}>Cancel</Button>
        </div>
      </div>
    </div>
  );
};
