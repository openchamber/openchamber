import React from 'react';
import { Button } from '@/components/ui/button';
import { ButtonSmall } from '@/components/ui/button-small';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type { GitHubAuthStatus } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { RiGithubFill, RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type GitHubUser = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

type DeviceFlowStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

type DeviceFlowCompleteResponse =
  | { connected: true; user: GitHubUser; scope?: string }
  | { connected: false; status?: string; error?: string };

export const GitHubSettings: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const runtimeGitHub = getRegisteredRuntimeAPIs()?.github;
  const status = useGitHubAuthStore((state) => state.status);
  const isLoading = useGitHubAuthStore((state) => state.isLoading);
  const hasChecked = useGitHubAuthStore((state) => state.hasChecked);
  const refreshStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setStatus = useGitHubAuthStore((state) => state.setStatus);

  const openExternal = React.useCallback(async (url: string) => {
    if (typeof window === 'undefined') {
      return;
    }

    type TauriShell = { shell?: { open?: (url: string) => Promise<unknown> } };
    const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
    if (tauri?.shell?.open) {
      try {
        await tauri.shell.open(url);
        return;
      } catch {
        // fall through
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  }, []);

  const [isBusy, setIsBusy] = React.useState(false);
  const [flow, setFlow] = React.useState<DeviceFlowStartResponse | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = React.useState<number | null>(null);
  const pollTimerRef = React.useRef<number | null>(null);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPollIntervalMs(null);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        if (!hasChecked) {
          await refreshStatus(runtimeGitHub);
        }
      } catch (error) {
        console.warn('Failed to load GitHub auth status:', error);
      }
    })();
    return () => {
      stopPolling();
    };
  }, [hasChecked, refreshStatus, runtimeGitHub, stopPolling]);

  const startConnect = React.useCallback(async () => {
    setIsBusy(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authStart()
        : await (async () => {
            const response = await fetch('/api/github/auth/start', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({}),
            });
            const body = (await response.json().catch(() => null)) as DeviceFlowStartResponse | { error?: string } | null;
            if (!response.ok || !body || !('deviceCode' in body)) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body;
          })();

      setFlow(payload);
      setPollIntervalMs(Math.max(1, payload.interval) * 1000);

      const url = payload.verificationUriComplete || payload.verificationUri;
      void openExternal(url);
    } catch (error) {
      console.error('Failed to start GitHub connect:', error);
      toast.error('Failed to start GitHub connect');
    } finally {
      setIsBusy(false);
    }
  }, [openExternal, runtimeGitHub]);

  const pollOnce = React.useCallback(async (deviceCode: string) => {
    if (runtimeGitHub) {
      return runtimeGitHub.authComplete(deviceCode) as Promise<DeviceFlowCompleteResponse>;
    }

    const response = await fetch('/api/github/auth/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ deviceCode }),
    });

    const payload = (await response.json().catch(() => null)) as DeviceFlowCompleteResponse | { error?: string } | null;
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText);
    }
    return payload as DeviceFlowCompleteResponse;
  }, [runtimeGitHub]);

  React.useEffect(() => {
    if (!flow?.deviceCode || !pollIntervalMs) {
      return;
    }
    if (pollTimerRef.current != null) {
      return;
    }

    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const result = await pollOnce(flow.deviceCode);
            if (result.connected) {
              toast.success('GitHub connected');
              setFlow(null);
              stopPolling();
              await refreshStatus(runtimeGitHub, { force: true });
              return;
            }

          if (result.status === 'slow_down') {
            setPollIntervalMs((prev) => (prev ? prev + 5000 : 5000));
          }

          if (result.status === 'expired_token' || result.status === 'access_denied') {
            toast.error(result.error || 'GitHub authorization failed');
            setFlow(null);
            stopPolling();
          }
        } catch (error) {
          console.warn('GitHub polling failed:', error);
        }
      })();
    }, pollIntervalMs);

    return () => {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [flow, pollIntervalMs, pollOnce, refreshStatus, runtimeGitHub, stopPolling]);

  const disconnect = React.useCallback(async () => {
    setIsBusy(true);
    try {
      stopPolling();
      setFlow(null);
      if (runtimeGitHub) {
        await runtimeGitHub.authDisconnect();
      } else {
        const response = await fetch('/api/github/auth', {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(response.statusText);
        }
      }
      toast.success('GitHub disconnected');
      await refreshStatus(runtimeGitHub, { force: true });
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error);
      toast.error('Failed to disconnect GitHub');
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeGitHub, stopPolling]);

  const activateAccount = React.useCallback(async (accountId: string) => {
    if (!accountId) return;
    setIsBusy(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authActivate(accountId)
        : await (async () => {
            const response = await fetch('/api/github/auth/activate', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({ accountId }),
            });
            const body = (await response.json().catch(() => null)) as GitHubAuthStatus | { error?: string } | null;
            if (!response.ok || !body) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body as GitHubAuthStatus;
          })();

      setStatus(payload);
      toast.success('GitHub account switched');
    } catch (error) {
      console.error('Failed to switch GitHub account:', error);
      toast.error('Failed to switch GitHub account');
    } finally {
      setIsBusy(false);
    }
  }, [runtimeGitHub, setStatus]);

  if (isLoading) {
    return null;
  }

  const connected = Boolean(status?.connected);
  const user = status?.user;
  const accounts = status?.accounts ?? [];

  return (
    <div className="mb-8">
      <div className="mb-3 px-1 flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-semibold text-foreground">GitHub</h3>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              Connect a GitHub account for in-app PR and issue workflows.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        {connected ? (
          <div className={cn("px-4 py-3", isMobile ? "flex flex-col gap-3" : "flex items-center justify-between gap-4")}>
            <div className={cn("flex min-w-0 items-center gap-4", isMobile ? "w-full" : undefined)}>
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.login ? `${user.login} avatar` : 'GitHub avatar'}
                  className="h-10 w-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]" />
              )}

              <div className="min-w-0 flex-1">
                <div className="typography-ui-label text-foreground">
                  {user?.name?.trim() || user?.login || 'GitHub'}
                </div>
                <div className={cn("flex items-center gap-2 typography-meta text-muted-foreground mt-0.5", isMobile ? "flex-wrap" : "truncate")}>
                  <RiGithubFill className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono">{user?.login || 'unknown'}</span>
                  {user?.email && <span className="opacity-50">•</span>}
                  {user?.email && <span>{user.email}</span>}
                </div>
                {status?.scope && (
                  <div className="typography-micro text-muted-foreground/70 mt-0.5">Scopes: {status.scope}</div>
                )}
              </div>
            </div>

            <ButtonSmall variant="outline" onClick={disconnect} disabled={isBusy} className={cn("text-[var(--status-error)] hover:text-[var(--status-error)]", isMobile ? "w-full" : undefined)}>
              Disconnect
            </ButtonSmall>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div className="flex min-w-0 flex-col">
              <span className="typography-ui-label text-foreground">Not Connected</span>
            </div>
            <ButtonSmall variant="default" onClick={startConnect} disabled={isBusy}>
              Connect GitHub
            </ButtonSmall>
          </div>
        )}

        {accounts.length > 1 && (
          <div className="mt-2 border-t border-[var(--surface-subtle)] pt-2 px-2 pb-1">
            <div className="typography-micro text-muted-foreground mb-2 px-1">Other Accounts</div>
            <div className="space-y-1">
              {accounts.map((account) => {
                const accountUser = account.user;
                const isCurrent = Boolean(account.current);
                return (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-muted)] px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {accountUser?.avatarUrl ? (
                        <img
                          src={accountUser.avatarUrl}
                          alt={accountUser.login ? `${accountUser.login} avatar` : 'GitHub avatar'}
                          className="h-6 w-6 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                          <RiGithubFill className="h-3 w-3 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex flex-col">
                        <span className="typography-ui-label text-foreground truncate">
                          {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                        </span>
                        {accountUser?.login && (
                          <span className="typography-micro text-muted-foreground truncate font-mono">
                            {accountUser.login}
                          </span>
                        )}
                      </div>
                    </div>
                    {isCurrent ? (
                      <span className="typography-micro text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-1.5 py-0.5 rounded">Active</span>
                    ) : (
                      <ButtonSmall
                        variant="ghost"
                        onClick={() => activateAccount(account.id)}
                        disabled={isBusy}
                      >
                        Switch to
                      </ButtonSmall>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {connected && (
        <div className="mt-2 px-2 pb-2">
          <ButtonSmall
            variant="outline"
            onClick={startConnect}
            disabled={isBusy}
            className={cn(isMobile ? 'w-full' : undefined)}
          >
            Add Account
          </ButtonSmall>
        </div>
      )}

      {flow && (
        <div className="mt-4 rounded-lg bg-[var(--surface-elevated)]/70 p-4 border border-[var(--interactive-border)]">
          <div className="space-y-1">
            <h4 className="typography-ui-label text-foreground">Authorize OpenChamber</h4>
            <p className="typography-meta text-muted-foreground">
              In GitHub, enter the following code to authorize this device:
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 mt-4">
            <div className="font-mono text-xl tracking-widest text-foreground bg-[var(--surface-muted)] px-3 py-1.5 rounded-md border border-[var(--interactive-border)]">{flow.userCode}</div>
            <Button size="sm" asChild>
              <a
                href={flow.verificationUriComplete || flow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open GitHub
              </a>
            </Button>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="typography-micro text-muted-foreground animate-pulse">
              Waiting for approval… (auto-refresh)
            </span>
            <ButtonSmall variant="ghost" disabled={isBusy} onClick={() => {
              stopPolling();
              setFlow(null);
            }}>
              Cancel
            </ButtonSmall>
          </div>
        </div>
      )}
    </div>
  );
};
