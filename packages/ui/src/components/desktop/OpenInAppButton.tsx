import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { isDesktopLocalOriginActive, isTauriShell, openDesktopPath, openDesktopProjectInApp } from '@/lib/desktop';
import { DEFAULT_OPEN_IN_APP_ID, OPEN_IN_APPS } from '@/lib/openInApps';
import { useOpenInAppsStore, type OpenInAppOption } from '@/stores/useOpenInAppsStore';
import { RiArrowDownSLine, RiCheckLine, RiFileCopyLine, RiRefreshLine } from '@remixicon/react';

const FINDER_DEFAULT_ICON_DATA_URL = 'data:image/png;base64,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';
const TERMINAL_DEFAULT_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAAB+C9pSAAAACXBIWXMAABYlAAAWJQFJUiTwAAABnWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj4yNTY8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MjU2PC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+Cl6wHhsAAAQzSURBVFgJ7VZNbBNHFH67Xv9RxwnBDqlUoQglcZK6qSIEJIQWAYJQoVY9IE5RTzn20FMvqdpDesq9B24+NdwthAJCkZChJg1JSOXYQIwQKQIaBdtENbs73t2+N8miGWOcpFHUHniyd97OvJ9v3nv7ZgDe038cAeVd/jOZjC94sKdfU+Bj24G9igpexwYPyiu2bauKqqqirkOTqmrjnIOyFsoyUKDocSCj/7mU7ujoMER5l68JYOFZ4YSiwPjd9O0jjx7ch1KhAJZVAcdx0LxDv3XetYKjggr4I4bzHo8G4aYmONjZBYf6+2dUzfd9PNowJajUZmef/PX5zcWl0rmvvnbQHrra+f/M+S+dqYXs2t3Hz09Ve5UicCmZ3NPb1Zv66btv+65dSULA64WGxkbw+Xx8V9XK9d4pWowxeFUqgW6acHroC/j5l0sLD/PZY98MDf3t6mouQ+On3X1H7/2e7rtOztHpgbY2+CAUgperq+D3+7cNgtLSEA7D0+VluDF5FS7cSff2HT56DF1dd/3KhQTWJ/lclsc8jIrk9IfRURgZGQEvRqNSWa8D2t1W/liXXK8Ro0i0lF0ExaPEXec0SgAqhrm3VCzwdS9GQNd1GBsbg0AgAIlEAlpbW7EYLVF/U56AagieiGwbuhERlSQApmEE8c/XKXxU0fF4HNowFfPz81Aul7edBjLGbeHITANsZga4g42HVAM2Y74KM/kSIQ/izgcHB2FiYgJmZmZ4MZpYULRG5PF4+Bx/2cLDxuhhYUqFLwGoWCaQEBGhNjAa4+Pj/J3SQA6pHpqbm/kcNitIJpOgaZIZvlbrQbZNJvcjSZOZDKhwRKLic4l2Pjc3B8FgkE+trKxAVUN0RWuOZNtCHyJJACj/bgREIZcnA9PT029SQM63unuywSOwUWOuTQmAhfmnlluPxIjUk6u1RrbJh0jyV0Ap2OZnJhrbjOcRqEqBBMDCAtltAORDJAkAVj2mWS5CUXinPDUx+oxFkgBYjO0qANu2wKoqQgkAfgW7C4AiYMmfoQSgwpjj7GYRUh/Q66SAmdisNxql227FfP1bXrRlVExdtCNHwDRLdPkgwmi8OUREhe3y1NLJFpEfbWMNvBRtSI2o+KqYi+zbx4NQwptMCO8E1HjEHYjKm/HknG5FZIsCG4lEoLS2lhP1JAB3bt1KH//s+GJPd3dPJpvlN5kwXiYIhHukisr1eAItXsm6YzGItrTcn5+dvS3qSQBSqVQhFouNnj039CsaCC7mcqDjgbNT6op1AtrU8Wo3Ojk5KaVAOptdR8PDwxf3t7SMvXjxvJNOPP31a35Krt8CXKl3j2SUDip/IAjRaBRaP9z/cHW18GMikbhcrVUTAAm1t7d/NDAwcDIUCvVqmtqkyLe3ajtvvTtg4x3SLpbLa3+kUr9N5fP55beE3k/8HyLwDx2/HIx7q3WfAAAAAElFTkSuQmCC';

type OpenInAppOptionWithFallback = OpenInAppOption & {
  fallbackIconDataUrl?: string;
};

const withFallbackIcon = (app: OpenInAppOption): OpenInAppOptionWithFallback => ({
  ...app,
  fallbackIconDataUrl: app.id === 'finder'
    ? FINDER_DEFAULT_ICON_DATA_URL
    : app.id === 'terminal'
      ? TERMINAL_DEFAULT_ICON_DATA_URL
      : undefined,
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
  activeFilePath?: string | null;
  className?: string;
};

export const OpenInAppButton = ({ directory, activeFilePath, className }: OpenInAppButtonProps) => {
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

  const isDesktopLocal = isTauriShell() && isDesktopLocalOriginActive();

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
    const opened = await openDesktopProjectInApp(directory, app.id, app.appName, activeFilePath);
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
    toast.success('Path copied to clipboard');
  };

  return (
    <div
        className={cn(
          'app-region-no-drag inline-flex h-7 items-center self-center rounded-md border border-[var(--interactive-border)]',
          'bg-[var(--surface-elevated)] shadow-none overflow-hidden',
          className
        )}
    >
      <button
        type="button"
        onClick={() => void handleOpen(selectedApp)}
        className={cn(
          'inline-flex h-full items-center gap-2 px-3 typography-ui-label font-medium',
          'text-foreground hover:bg-interactive-hover transition-colors'
        )}
        aria-label={`Open in ${selectedApp.label}`}
      >
        <AppIcon
          label={selectedApp.label}
          iconDataUrl={selectedApp.iconDataUrl}
          fallbackIconDataUrl={selectedApp.fallbackIconDataUrl}
        />
        <span className={cn('header-open-label', isScanning ? 'animate-pulse text-muted-foreground' : undefined)}>
          Open
        </span>
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
            aria-label="Choose app to open"
          >
            <RiArrowDownSLine className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="w-56 max-h-[70vh] overflow-y-auto"
          style={{ translate: '-30px 0' }}
        >
          <DropdownMenuItem className="flex items-center gap-2" onClick={() => void handleCopyPath()}>
            <RiFileCopyLine className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">Copy Path</span>
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
                  <RiCheckLine className="ml-auto h-4 w-4 text-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          {isCacheStale ? (
            <DropdownMenuItem
              className="flex items-center gap-2"
              onClick={() => void loadInstalledApps(true)}
            >
              <RiRefreshLine className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">Refresh Apps</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
