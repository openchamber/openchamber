import React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { isCapacitorApp } from '@/lib/platform';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import {
  isComposerStatusContributionSupported,
  type ComposerStatusContribution,
  type UIPluginRuntime,
} from '@/lib/uiPlugins';
import { findEnabledComposerStatusContributions, useUIPluginsStore } from '@/stores/useUIPluginsStore';
import { useSessionMessages } from '@/sync/sync-context';
import { cn } from '@/lib/utils';
import { buildComposerStatusSnapshot, COMPOSER_STATUS_ENGINE } from './composer-status-snapshot';
import type { ComposerStatusSnapshot } from '@openchamber/sdk';

// Same lazy mount as the Work Status section: only footers with a supported
// contribution pay for the pane.
const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

type ComposerStatusSurfaceProps = {
  isMobile: boolean;
  sessionId: string | null;
  directory?: string;
  placement: ComposerStatusContribution['placement'];
  className?: string;
};

const getRuntime = (isMobile: boolean): UIPluginRuntime => {
  if (isVSCodeRuntime()) return 'vscode';
  if (isMobile) return isCapacitorApp() ? 'capacitorMobile' : 'hostedMobile';
  return isDesktopShell() ? 'desktop' : 'web';
};

/**
 * The footer slot for `contributes.composerStatus` panels. The host computes
 * the snapshot (engine, provider, instant of the last completed assistant
 * turn) from its own sync and pushes it into each guest's frame; the guest
 * only paints what the host sends. With no supported contribution the surface
 * renders nothing at all — no layout gap until a guest declares one.
 */
export function ComposerStatusSurface({
  isMobile,
  sessionId,
  directory,
  placement,
  className,
}: ComposerStatusSurfaceProps) {
  const catalog = useUIPluginsStore((state) => state.catalog);
  const disabledPluginIds = useUIPluginsStore((state) => state.disabledPluginIds);
  const guests = useGuestsStore((state) => state.guests);
  const contributions = React.useMemo(
    () => findEnabledComposerStatusContributions({ catalog, disabledPluginIds })
      .filter((contribution) => contribution.placement === placement
        && isComposerStatusContributionSupported(contribution, getRuntime(isMobile))),
    [catalog, disabledPluginIds, isMobile, placement],
  );
  const messages = useSessionMessages(sessionId ?? '', directory);
  const snapshot = React.useMemo<ComposerStatusSnapshot>(
    () => buildComposerStatusSnapshot({ sessionId, engine: COMPOSER_STATUS_ENGINE, messages }),
    [sessionId, messages],
  );
  const mounted = React.useMemo(
    () => contributions
      .map((contribution) => ({
        contribution,
        guest: guests.find((guest) => guest.id === contribution.id && isGuestActive(guest)) ?? null,
      }))
      .filter((entry): entry is { contribution: ComposerStatusContribution; guest: InstalledGuest } => entry.guest !== null),
    [contributions, guests],
  );
  // Stable payload objects: the pane pushes on identity change, so a fresh
  // object per render would re-post the same snapshot on every parent render.
  const payloads = React.useMemo(
    () => mounted.map(({ contribution }) => (sessionId ? { contributionId: contribution.id, snapshot } : null)),
    [mounted, sessionId, snapshot],
  );

  if (mounted.length === 0) return null;

  return (
    <div className={cn('flex min-w-0 max-w-full items-center gap-x-1 overflow-hidden', className)} data-composer-status="true">
      {mounted.map(({ contribution, guest }, index) => (
        <div key={contribution.id} className="flex h-6 min-w-24 shrink-0 items-center overflow-hidden">
          <ErrorBoundary fallback={null}>
            <React.Suspense fallback={null}>
              <PluginPane
                mode={pluginModeFromId(guest.id)}
                surface="composer"
                item={null}
                composerStatus={payloads[index]}
              />
            </React.Suspense>
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}
