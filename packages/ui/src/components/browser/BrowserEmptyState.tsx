import React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { fetchDevServers, mergeDevServerCandidates, type DevServerDiscovery } from '@/lib/browser/devServers';
import { clearAnnouncedDevServers, useAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { browserUrlLabel } from '@/lib/browser/url';
import { isRemoteWebLoopbackUrl, isSpaceUnreachableFromHere } from '@/lib/browser/devTunnel';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useSpaceMarkLabel } from '@/lib/spaces/space-mark';
import { hideDevServerPort, showHiddenDevServerPorts, useHiddenDevServerPorts } from '@/lib/browser/hiddenDevServers';

/**
 * What the panel shows before anything is loaded.
 *
 * Rather than an inert placeholder, this lists the servers actually running,
 * which is almost always what the user came here to open. Discovery failure is
 * stated plainly instead of being rendered as "nothing is running" — the two
 * mean very different things to someone whose dev server is definitely up.
 */

/** The base path a server is served under, or '' when it sits at the root. */
const pathLabel = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    return path === '/' ? '' : path;
  } catch {
    return '';
  }
};

/** Re-checked while the panel is open: a project's servers appear seconds apart. */
const REFRESH_INTERVAL_MS = 2_000;

/**
 * True when the listed servers are on another machine, or inside an isolated
 * space, and this client has no way to reach them. The desktop shell tunnels a
 * local port for exactly this case; a browser tab has no equivalent, and its
 * `localhost` is its own.
 */
const isUnreachableFromHere = (directory: string): boolean => isRemoteWebLoopbackUrl('http://localhost', directory);

export const BrowserEmptyState: React.FC<{
  onOpen: (url: string) => void;
  directory?: string;
}> = ({ onOpen, directory = '' }) => {
  const { t } = useI18n();
  const [discovery, setDiscovery] = React.useState<DevServerDiscovery>({ kind: 'loading' });
  const announced = useAnnouncedDevServers(directory);
  const [remoteOnly] = React.useState(() => isUnreachableFromHere(directory));
  const [spaceUnreachable] = React.useState(() => isSpaceUnreachableFromHere(directory));
  // A space's servers carry the container mark the sidebar gives the space, with the space's
  // name and place behind it.
  const insideSpace = isSpaceDirectory(directory);
  const spaceMark = useSpaceMarkLabel(directory);

  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const poll = () => {
      void fetchDevServers(controller.signal, directory).then((result) => {
        if (!active) return;
        setDiscovery(result);
        // One look is a snapshot of whichever servers happened to be up first.
        timer = setTimeout(poll, REFRESH_INTERVAL_MS);
      });
    };
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [directory]);

  const candidates = React.useMemo(() => mergeDevServerCandidates({
    announced,
    discovered: discovery.kind === 'ready' ? discovery.servers : null,
  }), [announced, discovery]);
  // A server that just announced itself is shown even on a hidden port: the
  // user started it, so it is no longer noise.
  const hiddenPorts = useHiddenDevServerPorts();
  const visibleCandidates = React.useMemo(
    () => candidates.filter((candidate) => candidate.announced || !hiddenPorts.includes(candidate.port)),
    [candidates, hiddenPorts],
  );
  const hiddenCount = candidates.length - visibleCandidates.length;

  return (
    // The whole panel must not scroll: a centred column that overflows clips its
    // own top, and no amount of scrolling reaches it. Only the list of servers
    // scrolls, and it shrinks to whatever room is left before it does.
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-hidden bg-background p-6 text-center">
      <OpenChamberLogo width={110} height={110} className="shrink-0 opacity-20" />
      <div className="flex shrink-0 flex-col gap-1">
        <span className="typography-ui-header text-foreground">{t('contextPanel.browser.empty')}</span>
        <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
      </div>

      {candidates.length > 0 ? (
        <div className="flex min-h-0 w-full max-w-sm flex-col gap-1">
          <span className="shrink-0 typography-micro text-left text-muted-foreground">
            {announced.length > 0
              ? t('contextPanel.browser.devServers.justStarted')
              : t('contextPanel.browser.devServers.title')}
          </span>
          {remoteOnly && !spaceUnreachable ? (
            <span className="shrink-0 pb-1 text-left typography-micro text-muted-foreground">
              {t('contextPanel.browser.devServers.remoteOnly')}
            </span>
          ) : null}
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-0.5">
            {visibleCandidates.map((candidate) => (
              <div key={candidate.port} className="group/server flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // Not `disabled`: that takes the pointer away, and with it the
                  // tooltips of the two marks that say why the row does not open.
                  className={cn('min-w-0 flex-1 justify-start gap-2', remoteOnly && 'cursor-default opacity-60')}
                  aria-disabled={remoteOnly || undefined}
                  onClick={() => {
                    if (remoteOnly) return;
                    // The offer is answered; leaving it up would keep suggesting
                    // servers behind a page the user is already looking at.
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
                      <Icon name="box-3" className="size-3.5" aria-hidden="true" />
                    </span>
                  ) : (
                    <Icon name="global" className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{browserUrlLabel(candidate.url) || candidate.url}</span>
                  {spaceUnreachable ? (
                    <span
                      className="ml-auto shrink-0 text-muted-foreground"
                      role="img"
                      aria-label={t('contextPanel.browser.devServers.spaceOnlyDesktop')}
                      title={t('contextPanel.browser.devServers.spaceOnlyDesktop')}
                    >
                      <Icon name="computer" className="size-3.5" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="ml-auto truncate typography-micro text-muted-foreground">
                      {pathLabel(candidate.url)}
                    </span>
                  )}
                </Button>
                {candidate.announced ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground opacity-0 group-hover/server:opacity-100 focus-visible:opacity-100"
                    onClick={() => hideDevServerPort(candidate.port)}
                    aria-label={t('contextPanel.browser.devServers.hide', { port: candidate.port })}
                    title={t('contextPanel.browser.devServers.hide', { port: candidate.port })}
                  >
                    <Icon name="eye-off" className="size-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {hiddenCount > 0 ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto shrink-0 self-start p-0 typography-micro text-muted-foreground"
              onClick={showHiddenDevServerPorts}
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
