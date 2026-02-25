import React from 'react';
import QRCode from 'qrcode';
import {
  RiFileCopyLine,
  RiLoader4Line,
  RiCheckLine,
  RiErrorWarningLine,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { ButtonSmall } from '@/components/ui/button-small';
import { GridLoader } from '@/components/ui/grid-loader';
import { cn } from '@/lib/utils';

type TunnelState =
  | 'checking'
  | 'not-available'
  | 'idle'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

interface TunnelInfo {
  url: string;
  passwordUrl: string;
}

export const TunnelSettings: React.FC = () => {
  const [state, setState] = React.useState<TunnelState>('checking');
  const [tunnelInfo, setTunnelInfo] = React.useState<TunnelInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const checkAvailabilityAndStatus = React.useCallback(async (signal: AbortSignal) => {
    try {
      const [checkRes, statusRes] = await Promise.all([
        fetch('/api/openchamber/tunnel/check', { signal }),
        fetch('/api/openchamber/tunnel/status', { signal }),
      ]);

      const checkData = await checkRes.json();
      const statusData = await statusRes.json();

      if (statusData.active && statusData.url) {
        setTunnelInfo({ url: statusData.url, passwordUrl: statusData.passwordUrl });
        setState('active');
        return;
      }

      setState(checkData.available ? 'idle' : 'not-available');
    } catch {
      if (!signal.aborted) {
        setState('error');
        setErrorMessage('Failed to check tunnel availability');
      }
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    checkAvailabilityAndStatus(controller.signal);
    return () => controller.abort();
  }, [checkAvailabilityAndStatus]);

  React.useEffect(() => {
    if (!tunnelInfo?.passwordUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(tunnelInfo.passwordUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (!cancelled) setQrDataUrl(null);
    });

    return () => { cancelled = true; };
  }, [tunnelInfo?.passwordUrl]);

  const handleStart = React.useCallback(async () => {
    setState('starting');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/openchamber/tunnel/start', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setState('error');
        setErrorMessage(data.error || 'Failed to start tunnel');
        toast.error(data.error || 'Failed to start tunnel');
        return;
      }

      setTunnelInfo({ url: data.url, passwordUrl: data.passwordUrl });
      setState('active');
      toast.success('Tunnel started');
    } catch {
      setState('error');
      setErrorMessage('Failed to start tunnel');
      toast.error('Failed to start tunnel');
    }
  }, []);

  const handleStop = React.useCallback(async () => {
    setState('stopping');

    try {
      await fetch('/api/openchamber/tunnel/stop', { method: 'POST' });
      setTunnelInfo(null);
      setQrDataUrl(null);
      setState('idle');
      toast.success('Tunnel stopped');
    } catch {
      setState('error');
      setErrorMessage('Failed to stop tunnel');
      toast.error('Failed to stop tunnel');
    }
  }, []);

  const handleCopyUrl = React.useCallback(async () => {
    if (!tunnelInfo?.passwordUrl) return;

    try {
      await navigator.clipboard.writeText(tunnelInfo.passwordUrl);
      setCopied(true);
      toast.success('URL copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [tunnelInfo?.passwordUrl]);

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <GridLoader size="sm" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="typography-ui-header font-medium text-foreground">Remote Tunnel</h3>
        <p className="typography-meta text-muted-foreground/70 mt-1">
          Expose this session over a Cloudflare tunnel so you can access it from your phone or another device.
        </p>
      </div>

      {state === 'not-available' && (
        <section className="px-2 pb-2 pt-0 space-y-2">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3">
            <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <div className="space-y-1">
              <p className="typography-meta font-medium text-foreground">cloudflared not found</p>
              <p className="typography-meta text-muted-foreground/70">
                Install it to use remote tunnels:
              </p>
              <code className="typography-code block rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                brew install cloudflared
              </code>
            </div>
          </div>
        </section>
      )}

      {(state === 'idle' || state === 'starting') && (
        <section className="px-2 pb-2 pt-0 space-y-3">
          <ButtonSmall
            variant="ghost"
            onClick={handleStart}
            disabled={state === 'starting'}
            className={cn(
              'gap-2',
              state === 'starting' && 'opacity-70',
            )}
          >
            {state === 'starting' ? (
              <>
                <RiLoader4Line className="size-3.5 animate-spin" />
                Starting tunnel...
              </>
            ) : (
              'Start Tunnel'
            )}
          </ButtonSmall>
        </section>
      )}

      {(state === 'active' || state === 'stopping') && tunnelInfo && (
        <section className="px-2 pb-2 pt-0 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
              <p className="typography-meta font-medium text-foreground">Tunnel active</p>
            </div>

            <div className="flex items-center gap-2">
              <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                {tunnelInfo.passwordUrl}
              </code>
              <ButtonSmall variant="ghost" onClick={handleCopyUrl} className="shrink-0 gap-1.5">
                {copied ? (
                  <RiCheckLine className="size-3.5 text-[var(--status-success)]" />
                ) : (
                  <RiFileCopyLine className="size-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </ButtonSmall>
            </div>
          </div>

          {qrDataUrl && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 bg-white p-4">
              <img
                src={qrDataUrl}
                alt="Tunnel QR code"
                className="size-48"
              />
              <p className="typography-meta text-neutral-500">
                Scan with your phone to connect
              </p>
            </div>
          )}

          <ButtonSmall
            variant="ghost"
            onClick={handleStop}
            disabled={state === 'stopping'}
            className="gap-2 text-[var(--status-error)]"
          >
            {state === 'stopping' ? (
              <>
                <RiLoader4Line className="size-3.5 animate-spin" />
                Stopping...
              </>
            ) : (
              'Stop Tunnel'
            )}
          </ButtonSmall>
        </section>
      )}

      {state === 'error' && (
        <section className="px-2 pb-2 pt-0 space-y-3">
          <p className="typography-meta text-[var(--status-error)]">
            {errorMessage || 'An error occurred'}
          </p>
          <ButtonSmall variant="ghost" onClick={handleStart}>
            Retry
          </ButtonSmall>
        </section>
      )}

      <div className="px-2">
        <p className="typography-meta text-muted-foreground/50">
          The tunnel URL includes a session password for security. Anyone with the full URL can access this session.
        </p>
      </div>
    </div>
  );
};
