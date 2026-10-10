import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { Icon } from '@/components/icon/Icon';
import { useKeybinds } from '@/hooks/useKeybind';
import { isDesktopLocalOriginActive, isDesktopShell, type UpdateInfo } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  resolveCurrentDesktopHost,
  withLocalDesktopHost,
} from '@/lib/desktopCurrentHost';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  className?: string;
};

/**
 * The instance switcher. Instances only exist in the desktop app; everywhere
 * else there is nothing to switch, so nothing renders.
 */
export function DesktopInstanceMenu({ className }: Props): React.ReactNode {
  const [isDesktopApp] = React.useState(() => isDesktopShell());
  if (!isDesktopApp) {
    return null;
  }
  return <DesktopInstanceMenuContent className={className} />;
}

function DesktopInstanceMenuContent({ className }: Props): React.ReactNode {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const [open, setOpen] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
  const [currentInstanceIsLocal, setCurrentInstanceIsLocal] = React.useState(true);
  const [remoteUpdateDialogOpen, setRemoteUpdateDialogOpen] = React.useState(false);
  const [remoteUpdateInfo, setRemoteUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [remoteUpdateChecking, setRemoteUpdateChecking] = React.useState(false);
  const [remoteUpdateError, setRemoteUpdateError] = React.useState<string | null>(null);

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    try {
      if (isDesktopLocalOriginActive()) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }
      setCurrentInstanceIsLocal(false);

      // Same resolution the host switcher's own header uses, so the button and
      // the panel it opens can never disagree about which instance this is.
      const cfg = await desktopHostsGet();
      const resolved = resolveCurrentDesktopHost(withLocalDesktopHost(cfg.hosts, cfg.localOrigin));

      if (resolved.id === LOCAL_HOST_ID) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }

      setCurrentInstanceLabel(redactSensitiveUrl(resolved.label.trim() || 'Instance'));
    } catch {
      setCurrentInstanceLabel('Local');
      setCurrentInstanceIsLocal(true);
    }
  }, []);

  React.useEffect(() => {
    void refreshCurrentInstanceLabel();
    // Switching instances does not remount the sidebar, so without this the
    // button would keep naming the instance the window left behind.
    return subscribeRuntimeEndpointChanged(() => {
      void refreshCurrentInstanceLabel();
    });
  }, [refreshCurrentInstanceLabel]);

  const checkRemoteInstanceUpdate = React.useCallback(async () => {
    if (currentInstanceIsLocal) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(null);
      return;
    }

    setRemoteUpdateChecking(true);
    setRemoteUpdateError(null);
    try {
      // Status-only poll: must not count as usage on the remote server's install id.
      const params = new URLSearchParams({ appType: 'web', instanceMode: 'remote', reportUsage: 'false' });
      const response = await runtimeFetch(`/api/openchamber/update-check?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const data = await response.json();
      setRemoteUpdateInfo({
        available: data.available ?? false,
        version: data.version,
        currentVersion: data.currentVersion ?? 'unknown',
        body: data.body,
        nextSuggestedCheckInSec: typeof data.nextSuggestedCheckInSec === 'number' ? data.nextSuggestedCheckInSec : undefined,
        packageManager: data.packageManager,
        updateCommand: data.updateCommand,
      });
    } catch (error) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(error instanceof Error ? error.message : t('header.services.remoteUpdate.error'));
    } finally {
      setRemoteUpdateChecking(false);
    }
  }, [currentInstanceIsLocal, t]);

  React.useEffect(() => {
    setRemoteUpdateInfo(null);
    setRemoteUpdateError(null);
    setRemoteUpdateDialogOpen(false);
  }, [currentInstanceIsLocal, currentInstanceLabel]);

  React.useEffect(() => {
    if (currentInstanceIsLocal) {
      return;
    }

    const initialDelayMs = 3000;
    const intervalMs = 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        if (disposed || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
          schedule(intervalMs);
          return;
        }
        void checkRemoteInstanceUpdate().finally(() => {
          if (!disposed) {
            schedule(intervalMs);
          }
        });
      }, delayMs);
    };

    schedule(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [checkRemoteInstanceUpdate, currentInstanceIsLocal, currentInstanceLabel]);

  const openRemoteInstanceUpdate = React.useCallback(() => {
    if (remoteUpdateInfo?.available) {
      setRemoteUpdateDialogOpen(true);
      return;
    }
    void checkRemoteInstanceUpdate();
  }, [checkRemoteInstanceUpdate, remoteUpdateInfo?.available]);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      void refreshCurrentInstanceLabel();
    }
  }, [refreshCurrentInstanceLabel]);

  useKeybinds({
    toggle_services_menu: () => {
      if (open) {
        setOpen(false);
        return;
      }
      // The trigger lives in the sidebar footer; a collapsed sidebar has to
      // come back first, or the menu would anchor to a zero-width column.
      const ui = useUIStore.getState();
      if (!ui.isSidebarOpen) {
        ui.setSidebarOpen(true);
      }
      handleOpenChange(true);
    },
  });

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides));

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('header.services.openWithCurrent', { current: currentInstanceLabel })}
                className={className}
              >
                <Icon name="server" className="h-4 w-4 shrink-0" />
                <span className="truncate typography-ui-label">{currentInstanceLabel}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <p>
              {t('header.services.tooltip.currentInstance', {
                current: currentInstanceLabel,
                toggle: toggleShortcut,
              })}
            </p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="end"
          className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-0"
        >
          {!currentInstanceIsLocal ? (
            <div className="border-b border-[var(--interactive-border)] px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="typography-ui-label font-medium text-foreground">{t('header.services.remoteUpdate.title')}</div>
                  <div className="typography-micro text-muted-foreground">
                    {remoteUpdateInfo?.available
                      ? t('header.services.remoteUpdate.available', { version: remoteUpdateInfo.version || '' })
                      : remoteUpdateChecking
                        ? t('header.services.remoteUpdate.checking')
                        : remoteUpdateError || t('header.services.remoteUpdate.upToDate')}
                  </div>
                </div>
                {remoteUpdateInfo?.available ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-md bg-[var(--primary-base)] px-3 py-1.5 typography-ui-label font-medium text-[var(--primary-foreground)] hover:opacity-90"
                    onClick={openRemoteInstanceUpdate}
                  >
                    {t('header.services.remoteUpdate.actions.open')}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <DesktopHostSwitcherDialog
            embedded
            open={open}
            onOpenChange={() => {}}
            onHostSwitched={() => setOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <UpdateDialog
        open={remoteUpdateDialogOpen}
        onOpenChange={setRemoteUpdateDialogOpen}
        info={remoteUpdateInfo}
        downloading={false}
        downloaded={false}
        progress={null}
        error={remoteUpdateError}
        onDownload={() => {}}
        onRestart={() => {}}
        runtimeType="web"
      />
    </>
  );
}
