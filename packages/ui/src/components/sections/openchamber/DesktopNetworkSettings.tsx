import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp } from '@/lib/desktop';

export const DesktopNetworkSettings: React.FC = () => {
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error('Failed to load desktop settings');
        }

        const data = (await response.json().catch(() => null)) as null | { desktopLanAccessEnabled?: unknown };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        setSavedValue(enabled);
        setDraftValue(enabled);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load desktop settings');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const isDirty = draftValue !== savedValue;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const parsed = Number(window.location.port);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;

  const handleToggle = React.useCallback(() => {
    setDraftValue((current) => !current);
  }, []);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/config/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ desktopLanAccessEnabled: draftValue }),
      });

      if (!response.ok) {
        throw new Error('Failed to save desktop settings');
      }

      setSavedValue(draftValue);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error('Saved, but failed to restart app');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save desktop settings');
      setIsSaving(false);
    }
  }, [draftValue, isDirty]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">Desktop Network Access</h3>
      </div>

      <section className="space-y-2 px-2 pb-2 pt-0">
        <div
          className="group flex cursor-pointer items-start gap-2 py-1.5"
          role="button"
          tabIndex={0}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleToggle();
            }
          }}
        >
          <Checkbox
            checked={draftValue}
            onChange={handleToggle}
            ariaLabel="Allow LAN access to desktop sidecar"
            disabled={isLoading || isSaving}
          />
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label text-foreground">Let other devices on your local network open this app</div>
            <div className="typography-micro text-muted-foreground/70">
              Restarts the app so phones, tablets, and other computers on your Wi-Fi can open it.
            </div>
            <div className="typography-micro text-[var(--status-warning)]/85">
              Warning: while enabled, the app is reachable by anyone on the same local network.
            </div>
          </div>
        </div>

        {error ? (
          <div className="px-2 typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {lanUrl ? (
          <div className="px-2 typography-micro text-muted-foreground/80">
            {isDirty && !savedValue ? 'After restart, open from another device: ' : 'Open from another device: '}
            <span className="font-mono text-foreground">{lanUrl}</span>
          </div>
        ) : null}

        <div className="flex justify-start py-1.5">
          <Button
            type="button"
            size="xs"
            onClick={handleSaveAndRestart}
            disabled={isLoading || isSaving || !isDirty}
            className="shrink-0 !font-normal"
          >
            {isSaving ? 'Saving…' : 'Save + Restart'}
          </Button>
        </div>
      </section>
    </div>
  );
};
