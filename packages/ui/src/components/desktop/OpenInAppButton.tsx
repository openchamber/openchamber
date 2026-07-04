import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { isDesktopLocalOriginActive, isDesktopShell, openDesktopPath, openDesktopProjectInApp } from '@/lib/desktop';
import { DEFAULT_OPEN_IN_APP_ID, OPEN_IN_APPS } from '@/lib/openInApps';
import { useOpenInAppsStore, type OpenInAppOption } from '@/stores/useOpenInAppsStore';
import { useI18n } from '@/lib/i18n';

const FINDER_DEFAULT_ICON_DATA_URL = 'data:image/png;base64,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';
const FILES_DEFAULT_ICON_DATA_URL = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0ic3ZnMTEzMDAiIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3IiB2ZXJzaW9uPSIxLjAiIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOmNjPSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9ucyMiIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayI+CiA8dGl0bGUgaWQ9InRpdGxlNDE2MiI+QWR3YWl0YSBJY29uIFRlbXBsYXRlPC90aXRsZT4KIDxkZWZzIGlkPSJkZWZzMyI+CiAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXJHcmFkaWVudDE2OTciPgogICA8c3RvcCBpZD0ic3RvcDE2ODUiIHN0eWxlPSJzdG9wLWNvbG9yOiNkZWRkZGEiIG9mZnNldD0iMCIvPgogICA8c3RvcCBpZD0ic3RvcDE2ODciIHN0eWxlPSJzdG9wLWNvbG9yOiNlZWVlZWMiIG9mZnNldD0iLjA0NTQ1NSIvPgogICA8c3RvcCBpZD0ic3RvcDE2ODkiIHN0eWxlPSJzdG9wLWNvbG9yOiNkZWRkZGEiIG9mZnNldD0iLjA5MDkwOSIvPgogICA8c3RvcCBpZD0ic3RvcDE2OTEiIHN0eWxlPSJzdG9wLWNvbG9yOiNkZWRkZGEiIG9mZnNldD0iLjkwOTA5Ii8+CiAgIDxzdG9wIGlkPSJzdG9wMTY5MyIgc3R5bGU9InN0b3AtY29sb3I6I2VlZWVlYyIgb2Zmc2V0PSIuOTU0NTUiLz4KICAgPHN0b3AgaWQ9InN0b3AxNjk1IiBzdHlsZT0ic3RvcC1jb2xvcjojYzBiZmJjIiBvZmZzZXQ9IjEiLz4KICA8L2xpbmVhckdyYWRpZW50PgogIDxsaW5lYXJHcmFkaWVudCBpZD0ibGluZWFyR3JhZGllbnQxMDQ5IiB4MT0iMjAiIHgyPSIxMDgiIHkxPSIyMzgiIHkyPSIyMzgiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiB4bGluazpocmVmPSIjbGluZWFyR3JhZGllbnQxNjk3Ii8+CiAgPGxpbmVhckdyYWRpZW50IGlkPSJsaW5lYXJHcmFkaWVudDExODUiIHgxPSI1MCIgeDI9Ijc0IiB5MT0iMjM4IiB5Mj0iMjM4IiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKDIsLTIyKSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIHhsaW5rOmhyZWY9IiNsaW5lYXJHcmFkaWVudDE2OTciLz4KICA8bGluZWFyR3JhZGllbnQgaWQ9ImxpbmVhckdyYWRpZW50MTM0OCIgeDE9IjY1IiB4Mj0iNjUiIHkxPSIyMDQiIHkyPSIyMDAiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgPHN0b3AgaWQ9InN0b3AxMjQxIiBzdHlsZT0ic3RvcC1jb2xvcjojOWE5OTk2IiBvZmZzZXQ9IjAiLz4KICAgPHN0b3AgaWQ9InN0b3AxMjQzIiBzdHlsZT0ic3RvcC1jb2xvcjojYzBiZmJjIiBvZmZzZXQ9IjEiLz4KICA8L2xpbmVhckdyYWRpZW50PgogPC9kZWZzPgogPG1ldGFkYXRhIGlkPSJtZXRhZGF0YTQiPgogIDxyZGY6UkRGPgogICA8Y2M6V29yayByZGY6YWJvdXQ9IiI+CiAgICA8ZGM6Zm9ybWF0PmltYWdlL3N2Zyt4bWw8L2RjOmZvcm1hdD4KICAgIDxkYzp0eXBlIHJkZjpyZXNvdXJjZT0iaHR0cDovL3B1cmwub3JnL2RjL2RjbWl0eXBlL1N0aWxsSW1hZ2UiLz4KICAgIDxkYzpjcmVhdG9yPgogICAgIDxjYzpBZ2VudD4KICAgICAgPGRjOnRpdGxlPkdOT01FIERlc2lnbiBUZWFtPC9kYzp0aXRsZT4KICAgICA8L2NjOkFnZW50PgogICAgPC9kYzpjcmVhdG9yPgogICAgPGRjOnNvdXJjZS8+CiAgICA8Y2M6bGljZW5zZSByZGY6cmVzb3VyY2U9Imh0dHA6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LXNhLzQuMC8iLz4KICAgIDxkYzp0aXRsZT5BZHdhaXRhIEljb24gVGVtcGxhdGU8L2RjOnRpdGxlPgogICAgPGRjOnN1YmplY3Q+CiAgICAgPHJkZjpCYWcvPgogICAgPC9kYzpzdWJqZWN0PgogICAgPGRjOmRhdGUvPgogICAgPGRjOnJpZ2h0cz4KICAgICA8Y2M6QWdlbnQ+CiAgICAgIDxkYzp0aXRsZS8+CiAgICAgPC9jYzpBZ2VudD4KICAgIDwvZGM6cmlnaHRzPgogICAgPGRjOnB1Ymxpc2hlcj4KICAgICA8Y2M6QWdlbnQ+CiAgICAgIDxkYzp0aXRsZS8+CiAgICAgPC9jYzpBZ2VudD4KICAgIDwvZGM6cHVibGlzaGVyPgogICAgPGRjOmlkZW50aWZpZXIvPgogICAgPGRjOnJlbGF0aW9uLz4KICAgIDxkYzpsYW5ndWFnZS8+CiAgICA8ZGM6Y292ZXJhZ2UvPgogICAgPGRjOmRlc2NyaXB0aW9uLz4KICAgIDxkYzpjb250cmlidXRvcj4KICAgICA8Y2M6QWdlbnQ+CiAgICAgIDxkYzp0aXRsZS8+CiAgICAgPC9jYzpBZ2VudD4KICAgIDwvZGM6Y29udHJpYnV0b3I+CiAgIDwvY2M6V29yaz4KICAgPGNjOkxpY2Vuc2UgcmRmOmFib3V0PSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9saWNlbnNlcy9ieS1zYS80LjAvIj4KICAgIDxjYzpwZXJtaXRzIHJkZjpyZXNvdXJjZT0iaHR0cDovL2NyZWF0aXZlY29tbW9ucy5vcmcvbnMjUmVwcm9kdWN0aW9uIi8+CiAgICA8Y2M6cGVybWl0cyByZGY6cmVzb3VyY2U9Imh0dHA6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL25zI0Rpc3RyaWJ1dGlvbiIvPgogICAgPGNjOnJlcXVpcmVzIHJkZjpyZXNvdXJjZT0iaHR0cDovL2NyZWF0aXZlY29tbW9ucy5vcmcvbnMjTm90aWNlIi8+CiAgICA8Y2M6cmVxdWlyZXMgcmRmOnJlc291cmNlPSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9ucyNBdHRyaWJ1dGlvbiIvPgogICAgPGNjOnBlcm1pdHMgcmRmOnJlc291cmNlPSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9ucyNEZXJpdmF0aXZlV29ya3MiLz4KICAgIDxjYzpyZXF1aXJlcyByZGY6cmVzb3VyY2U9Imh0dHA6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL25zI1NoYXJlQWxpa2UiLz4KICAgPC9jYzpMaWNlbnNlPgogIDwvcmRmOlJERj4KIDwvbWV0YWRhdGE+CiA8ZyBpZD0ibGF5ZXIxIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLC0xNzIpIj4KICA8ZyBpZD0ibGF5ZXI5Ij4KICAgPGcgaWQ9ImcxMjA3Ij4KICAgIDxyZWN0IGlkPSJyZWN0MTA0MSIgeD0iMjAiIHk9IjIzNCIgd2lkdGg9Ijg4IiBoZWlnaHQ9IjU4IiByeD0iOC43NzI2IiByeT0iOC4wMTc5IiBzdHlsZT0iZmlsbDp1cmwoI2xpbmVhckdyYWRpZW50MTA0OSk7cGFpbnQtb3JkZXI6bm9ybWFsIi8+CiAgICA8cmVjdCBpZD0icmVjdDE1NDM1LTYiIHg9IjIwIiB5PSIxODAiIHdpZHRoPSI4OCIgaGVpZ2h0PSIxMDgiIHJ4PSI4Ljc3MjYiIHJ5PSI4LjAxNzkiIHN0eWxlPSJmaWxsOiNmNmY1ZjQ7cGFpbnQtb3JkZXI6bm9ybWFsIi8+CiAgICA8cmVjdCBpZD0icmVjdDExNjciIHg9IjI0IiB5PSIxODYiIHdpZHRoPSI4MCIgaGVpZ2h0PSI5OCIgcng9IjQiIHJ5PSI0LjAwMjIiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXc7ZmlsbDojMWE1ZmI0O3BhaW50LW9yZGVyOm5vcm1hbCIvPgogICAgPHJlY3QgaWQ9InJlY3QxNTQ0MS04IiB4PSIyNCIgeT0iMTg0IiB3aWR0aD0iODAiIGhlaWdodD0iOTgiIHJ4PSI0IiByeT0iNC4wMDIyIiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3O2ZpbGw6IzM1ODRlNDtwYWludC1vcmRlcjpub3JtYWwiLz4KICAgIDxyZWN0IGlkPSJyZWN0MTU0NDMtNiIgeD0iMjQiIHk9IjIxNiIgd2lkdGg9IjgwIiBoZWlnaHQ9IjIiIHJ4PSIwIiByeT0iMCIgc3R5bGU9ImVuYWJsZS1iYWNrZ3JvdW5kOm5ldztmaWxsOiMxYzcxZDg7cGFpbnQtb3JkZXI6bm9ybWFsIi8+CiAgICA8cmVjdCBpZD0icmVjdDE1NDYxLTIiIHg9IjI0IiB5PSIyNDgiIHdpZHRoPSI4MCIgaGVpZ2h0PSIyIiByeD0iMCIgcnk9IjAiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXc7ZmlsbDojMWM3MWQ4O3BhaW50LW9yZGVyOm5vcm1hbCIvPgogICAgPGcgaWQ9ImcxMDg4Ij4KICAgICA8cGF0aCBpZD0icGF0aDI2MDM1IiBkPSJtNTUgMTk2aDE4YzEuNjYyIDAgMyAxIDMgM3Y1aC0zLjk2ODhsLTAuMDMxMjUtNGgtMTZsMC4wMzEyNSA0aC00LjAzMTJ2LTVjMC0xLjY2MiAxLjMzOC0zIDMtM3oiIHN0eWxlPSJmaWxsOnVybCgjbGluZWFyR3JhZGllbnQxMTg1KTtwYWludC1vcmRlcjpub3JtYWwiLz4KICAgICA8cmVjdCBpZD0icmVjdDEwNTkiIHg9IjUyIiB5PSIyMDIiIHdpZHRoPSIyNCIgaGVpZ2h0PSI0IiByeT0iMS41IiBzdHlsZT0ib3BhY2l0eTouMSIvPgogICAgIDxwYXRoIGlkPSJyZWN0MTA2MSIgZD0ibTU1IDIwMGMtMS42NjIgMC0zIDEuMzM4LTMgM3YxaDR2LTJoMTZ2Mmg0di0xYzAtMS42NjItMS4zMzgtMy0zLTN6IiBzdHlsZT0iZmlsbDp1cmwoI2xpbmVhckdyYWRpZW50MTM0OCkiLz4KICAgICA8cmVjdCBpZD0icmVjdDExODkiIHg9IjU2IiB5PSIyMDIiIHdpZHRoPSIxNiIgaGVpZ2h0PSIyIiBzdHlsZT0ib3BhY2l0eTouMSIvPgogICAgPC9nPgogICAgPHVzZSBpZD0idXNlMTA5MCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwzMikiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIHhsaW5rOmhyZWY9IiNnMTA4OCIvPgogICAgPHVzZSBpZD0idXNlMTA5MiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCw2NCkiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIHhsaW5rOmhyZWY9IiNnMTA4OCIvPgogICA8L2c+CiAgPC9nPgogPC9nPgo8L3N2Zz4K';
const TERMINAL_DEFAULT_ICON_DATA_URL = 'data:image/png;base64,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';

type OpenInAppOptionWithFallback = OpenInAppOption & {
  fallbackIconDataUrl?: string;
};

const getOpenInAppFallbackIconDataUrl = (appId: string): string | undefined => {
  const platform = typeof window !== 'undefined' ? window.__OPENCHAMBER_PLATFORM__ : undefined;
  if (appId === 'finder' && platform === 'linux') {
    return FILES_DEFAULT_ICON_DATA_URL;
  }
  if (appId === 'finder' && platform === 'darwin') {
    return FINDER_DEFAULT_ICON_DATA_URL;
  }
  if (appId === 'terminal') {
    return TERMINAL_DEFAULT_ICON_DATA_URL;
  }
  return undefined;
};

const withFallbackIcon = (app: OpenInAppOption): OpenInAppOptionWithFallback => ({
  ...app,
  fallbackIconDataUrl: getOpenInAppFallbackIconDataUrl(app.id),
});

const AppIcon = ({
  label,
  iconDataUrl,
  fallbackIconDataUrl,
}: {
  label: string;
  iconDataUrl?: string;
  fallbackIconDataUrl?: string;
}) => {
  const [failed, setFailed] = React.useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  const src = iconDataUrl || fallbackIconDataUrl;

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        className="h-4 w-4 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        'h-4 w-4 rounded-sm flex items-center justify-center',
        'bg-[var(--surface-muted)] text-[9px] font-medium text-muted-foreground'
      )}
    >
      {initial}
    </span>
  );
};

type OpenInAppButtonProps = {
  directory: string;
  className?: string;
};

export const OpenInAppButton = ({ directory, className }: OpenInAppButtonProps) => {
  const { t } = useI18n();
  const selectedAppId = useOpenInAppsStore((state) => state.selectedAppId);
  const availableApps = useOpenInAppsStore((state) => state.availableApps);
  const isCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const isScanning = useOpenInAppsStore((state) => state.isScanning);
  const initialize = useOpenInAppsStore((state) => state.initialize);
  const loadInstalledApps = useOpenInAppsStore((state) => state.loadInstalledApps);
  const selectApp = useOpenInAppsStore((state) => state.selectApp);

  React.useEffect(() => {
    initialize();
  }, [initialize]);

  const isDesktopLocal = isDesktopShell() && isDesktopLocalOriginActive();

  const selectedApp = React.useMemo(() => {
    const known = availableApps.find((app) => app.id === selectedAppId)
      ?? availableApps.find((app) => app.id === DEFAULT_OPEN_IN_APP_ID)
      ?? availableApps[0]
      ?? OPEN_IN_APPS[0];
    if (known) {
      return withFallbackIcon(known);
    }
    return withFallbackIcon(OPEN_IN_APPS[0]);
  }, [availableApps, selectedAppId]);

  if (!isDesktopLocal || !directory) {
    return null;
  }

  if (availableApps.length === 0) {
    return null;
  }

  const handleOpen = async (app: OpenInAppOption) => {
    const opened = await openDesktopProjectInApp(directory, app.id, app.appName);
    if (!opened) {
      await openDesktopPath(directory, app.appName);
    }
  };

  const handleSelect = async (app: OpenInAppOption) => {
    await selectApp(app.id);
    await handleOpen(app);
  };

  const handleCopyPath = async () => {
    const text = directory;
    const result = await copyTextToClipboard(text);
    if (!result.ok) {
      return;
    }
    toast.success(t('openInApp.toast.pathCopied'));
  };

  return (
    <div
        className={cn(
          'app-region-no-drag inline-flex h-7 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
          'bg-[var(--surface-elevated)] overflow-hidden',
          'border border-border/60',
          className
        )}
    >
      <button
        type="button"
        onClick={() => void handleOpen(selectedApp)}
        className={cn(
          'inline-flex h-full items-center px-2.5 typography-ui-label font-medium',
          'text-foreground hover:bg-interactive-hover transition-colors',
          isScanning && 'animate-pulse'
        )}
        aria-label={t('openInApp.actions.openInAria', { app: selectedApp.label })}
      >
        <AppIcon
          label={selectedApp.label}
          iconDataUrl={selectedApp.iconDataUrl}
          fallbackIconDataUrl={selectedApp.fallbackIconDataUrl}
        />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors'
            )}
            aria-label={t('openInApp.actions.chooseAppAria')}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56 max-h-[70vh] overflow-y-auto"
        >
          <DropdownMenuItem className="flex items-center gap-2" onClick={() => void handleCopyPath()}>
            <Icon name="file-copy" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('openInApp.actions.copyPath')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {availableApps.map((app) => {
            const appWithFallback = withFallbackIcon(app);
            return (
              <DropdownMenuItem
                key={app.id}
                className="flex items-center gap-2"
                onClick={() => void handleSelect(app)}
              >
                <AppIcon
                  label={app.label}
                  iconDataUrl={app.iconDataUrl}
                  fallbackIconDataUrl={appWithFallback.fallbackIconDataUrl}
                />
                <span className="typography-ui-label text-foreground">{app.label}</span>
                {selectedApp.id === app.id ? (
                  <Icon name="check" className="ml-auto h-4 w-4 text-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          {isCacheStale ? (
            <DropdownMenuItem
              className="flex items-center gap-2"
              onClick={() => void loadInstalledApps(true)}
            >
              <Icon name="refresh" className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">{t('openInApp.actions.refreshApps')}</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
