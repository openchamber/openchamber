import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { fetchDevServers, mergeDevServerCandidates, type DevServerDiscovery } from '@/lib/browser/devServers';
import { clearAnnouncedDevServers, useAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { browserUrlLabel, isLoopbackUrl } from '@/lib/browser/url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

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
 * True when the listed servers are on another machine and this client has no
 * way to reach them. The desktop shell tunnels a local port for exactly this
 * case; a browser tab has no equivalent, and its `localhost` is its own.
 */
const isUnreachableFromHere = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (window.__OPENCHAMBER_ELECTRON__) return false;
  const baseUrl = getRuntimeApiBaseUrl();
  if (!baseUrl) return false;
  try {
    return !isLoopbackUrl(new URL(baseUrl, window.location.href).toString());
  } catch {
    return false;
  }
};

export const BrowserEmptyState: React.FC<{
  onOpen: (url: string) => void;
  directory?: string;
}> = ({ onOpen, directory = '' }) => {
  const { t } = useI18n();
  const [discovery, setDiscovery] = React.useState<DevServerDiscovery>({ kind: 'loading' });
  const announced = useAnnouncedDevServers(directory);
  const [remoteOnly] = React.useState(isUnreachableFromHere);

  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const poll = () => {
      void fetchDevServers(controller.signal).then((result) => {
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
  }, []);

  const candidates = React.useMemo(() => mergeDevServerCandidates({
    announced,
    discovered: discovery.kind === 'ready' ? discovery.servers : null,
  }), [announced, discovery]);

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
          {remoteOnly ? (
            <span className="shrink-0 pb-1 text-left typography-micro text-muted-foreground">
              {t('contextPanel.browser.devServers.remoteOnly')}
            </span>
          ) : null}
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-0.5">
            {candidates.map((candidate) => (
              <Button
                key={candidate.port}
                type="button"
                variant="outline"
                size="sm"
                className="w-full shrink-0 justify-start gap-2"
                onClick={() => {
                  // The offer is answered; leaving it up would keep suggesting
                  // servers behind a page the user is already looking at.
                  clearAnnouncedDevServers(directory);
                  onOpen(candidate.url);
                }}
              >
                <Icon name="global" className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{browserUrlLabel(candidate.url) || candidate.url}</span>
                <span className="ml-auto truncate typography-micro text-muted-foreground">
                  {pathLabel(candidate.url)}
                </span>
              </Button>
            ))}
          </div>
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
