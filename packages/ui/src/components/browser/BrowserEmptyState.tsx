import React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import {
  fetchDevServers,
  mergeDevServerCandidates,
  placeDevServerCandidates,
  type DevServerDiscovery,
  type WorkFolder,
} from '@/lib/browser/devServers';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { clearAnnouncedDevServers, useAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { browserUrlLabel } from '@/lib/browser/url';
import { isRemoteWebLoopbackUrl, isSpaceUnreachableFromHere } from '@/lib/browser/devTunnel';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useSpaceMarkLabel } from '@/lib/spaces/space-mark';
import { useSpaceDirectoryStopped } from '@/lib/spaces/spaces-store';
import { hideDevServerPort, showHiddenDevServerPorts, useHiddenDevServerPorts } from '@/lib/browser/hiddenDevServers';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';


const pathLabel = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    return path === '/' ? '' : path;
  } catch {
    return '';
  }
};

const REFRESH_INTERVAL_MS = 2_000;

const isUnreachableFromHere = (directory: string): boolean => !isCapacitorApp() && isRemoteWebLoopbackUrl('http://localhost', directory);

export const BrowserEmptyState: React.FC<{
  onOpen: (url: string) => void;
  directory?: string;
  visible: boolean;
}> = ({ onOpen, directory = '', visible }) => {
  const { t } = useI18n();
  const [discovery, setDiscovery] = React.useState<DevServerDiscovery>({ kind: 'loading' });
  const announced = useAnnouncedDevServers(directory);
  const [remoteOnly] = React.useState(() => isUnreachableFromHere(directory));
  const [spaceUnreachable] = React.useState(() => isSpaceUnreachableFromHere(directory));
  const insideSpace = isSpaceDirectory(directory);
  const spaceMark = useSpaceMarkLabel(directory);
  const spaceStopped = useSpaceDirectoryStopped(directory);

  React.useEffect(() => {
    if (spaceStopped) {
      setDiscovery({ kind: 'ready', servers: [] });
      return;
    }
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const poll = () => {
      void fetchDevServers(controller.signal, directory).then((result) => {
        if (!active) return;
        setDiscovery(result);
        timer = setTimeout(poll, REFRESH_INTERVAL_MS);
      });
    };
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [directory, spaceStopped, visible]);

  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const folders = React.useMemo<WorkFolder[]>(() => [
    ...projects.map((project) => ({ path: project.path, projectPath: project.path })),
    ...[...worktreesByProject].flatMap(([projectPath, worktrees]) => (
      worktrees.map((worktree) => ({ path: worktree.path, projectPath }))
    )),
  ], [projects, worktreesByProject]);

  const candidates = React.useMemo(() => placeDevServerCandidates({
    candidates: mergeDevServerCandidates({
      announced,
      discovered: discovery.kind === 'ready' ? discovery.servers : null,
    }),
    folders,
    directory,
  }), [announced, directory, discovery, folders]);
  const hiddenPorts = useHiddenDevServerPorts();
  const [showOutsideWork, setShowOutsideWork] = React.useState(false);
  const visibleCandidates = React.useMemo(
    () => candidates.filter((candidate) => candidate.announced || (
      !hiddenPorts.includes(candidate.port) && (showOutsideWork || (!candidate.outsideWork && !candidate.notWebPage))
    )),
    [candidates, hiddenPorts, showOutsideWork],
  );
  const hiddenCount = candidates.length - visibleCandidates.length;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-hidden bg-background p-6 text-center">
      <OpenChamberLogo width={110} height={110} className="shrink-0 opacity-20" />
      <div className="flex shrink-0 flex-col gap-1">
        <span className="typography-ui-header text-foreground">{t('contextPanel.browser.empty')}</span>
        <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
      </div>

      {candidates.length > 0 ? (
        <div className="flex min-h-0 w-full max-w-lg flex-col gap-1">
          <span className="shrink-0 typography-micro text-start text-muted-foreground">
            {announced.length > 0
              ? t('contextPanel.browser.devServers.justStarted')
              : t('contextPanel.browser.devServers.title')}
          </span>
          {remoteOnly && !spaceUnreachable ? (
            <span className="shrink-0 pb-1 text-start typography-micro text-muted-foreground">
              {t('contextPanel.browser.devServers.remoteOnly')}
            </span>
          ) : null}
          <ScrollableOverlay outerClassName="min-h-0" className="flex flex-col gap-1 pe-0.5" disableHorizontal>
            {visibleCandidates.map((candidate) => (
              <div key={candidate.port} className="group/server flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size={isMobileSurfaceRuntime() ? 'default' : 'sm'}
                  className={cn('min-w-0 flex-1 justify-start gap-2', isMobileSurfaceRuntime() && 'min-h-11', remoteOnly && 'cursor-default opacity-60')}
                  aria-disabled={remoteOnly || undefined}
                  title={candidate.page?.title ? [candidate.page.title, candidate.command].filter(Boolean).join(' · ') : undefined}
                  onClick={() => {
                    if (remoteOnly) return;
                    clearAnnouncedDevServers(directory);
                    onOpen(candidate.url);
                  }}
                >
                  {insideSpace ? (
                    <span
                      className="shrink-0"
                      role="img"
                      aria-label={spaceMark ?? t('contextPanel.browser.spaceAddress')}
                      title={spaceMark ?? t('contextPanel.browser.spaceAddress')}
                    >
                      <Icon name="instance" className="size-3.5" aria-hidden="true" />
                    </span>
                  ) : candidate.page?.icon ? (
                    <img src={candidate.page.icon} alt="" className="size-3.5 shrink-0 object-contain" />
                  ) : (
                    <Icon name="global" className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {candidate.page?.title ? (
                    <>
                      <span className="min-w-0 truncate" dir="auto">{candidate.page.title}</span>
                      <span className="shrink-0 typography-micro text-muted-foreground" dir="ltr">
                        {browserUrlLabel(candidate.url) || candidate.url}{pathLabel(candidate.url)}
                      </span>
                    </>
                  ) : (
                    <span className="truncate">
                      {browserUrlLabel(candidate.url) || candidate.url}
                      <span className="typography-micro text-muted-foreground">{pathLabel(candidate.url)}</span>
                    </span>
                  )}
                  {candidate.command && !candidate.page?.title ? (
                    <span className="min-w-0 truncate typography-micro text-muted-foreground" dir="ltr" title={candidate.command}>
                      {candidate.command}
                    </span>
                  ) : null}
                  {spaceUnreachable ? (
                    <span
                      className="ms-auto shrink-0 text-muted-foreground"
                      role="img"
                      aria-label={t('contextPanel.browser.devServers.spaceOnlyDesktop')}
                      title={t('contextPanel.browser.devServers.spaceOnlyDesktop')}
                    >
                      <Icon name="computer" className="size-3.5" aria-hidden="true" />
                    </span>
                  ) : candidate.folderName ? (
                    <span
                      className="ms-auto flex min-w-0 items-center gap-1 typography-micro text-muted-foreground"
                      title={candidate.directory}
                    >
                      <Icon name="folder" className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate" dir="auto">{candidate.folderName}</span>
                    </span>
                  ) : null}
                </Button>
                {candidate.announced ? null : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground opacity-0 group-hover/server:opacity-100 focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                        onClick={() => hideDevServerPort(candidate.port)}
                        aria-label={t('contextPanel.browser.devServers.hide', { port: candidate.port })}
                      >
                        <Icon name="eye-off" className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('contextPanel.browser.devServers.hide', { port: candidate.port })}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            ))}
          </ScrollableOverlay>
          {hiddenCount > 0 ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto shrink-0 self-start p-0 typography-micro text-muted-foreground"
              onClick={() => {
                showHiddenDevServerPorts();
                setShowOutsideWork(true);
              }}
            >
              {hiddenCount === 1
                ? t('contextPanel.browser.devServers.showHiddenSingle', { count: hiddenCount })
                : t('contextPanel.browser.devServers.showHiddenPlural', { count: hiddenCount })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {candidates.length === 0 && discovery.kind === 'unavailable' ? (
        <span className="typography-micro text-muted-foreground">
          {t('contextPanel.browser.devServers.unavailable')}
        </span>
      ) : null}
    </div>
  );
};
