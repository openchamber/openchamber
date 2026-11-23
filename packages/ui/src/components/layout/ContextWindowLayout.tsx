import React from 'react';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { ContextSurfacePanes } from './ContextSurfacePanes';
import { GuestHosts } from './GuestHosts';
import { ProjectActionsProvider } from './ProjectActionsProvider';
import { ZoneDropOverlay } from './ZoneDropOverlay';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { DiagnosticDialogAvailableContext } from '@/lib/diagnostics/dialog-availability';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useContextWindowPanel } from '@/hooks/useContextWindowPanel';
import { isDesktopShell } from '@/lib/desktop';
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isZoneShown } from '@/lib/workspace/zones';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';

const folderName = (path: string | undefined): string => path?.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';

const useFollowedLabel = (): string => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const directory = useEffectiveDirectory();
  const title = sessionId ? sessions.find((session) => session.id === sessionId)?.title?.trim() : '';
  return title || folderName(directory);
};

const ContextWindowHeader: React.FC = () => {
  const { direction } = useI18n();
  const label = useFollowedLabel();
  const macosMajor = globalThis.window?.__OPENCHAMBER_MACOS_MAJOR__ ?? 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const controlsAtStart = usesFramelessChrome && side === getInlineStartSide(direction);
  const controlsAtEnd = usesFramelessChrome && !controlsAtStart;
  const macosHeight = hasMacTrafficLights ? (macosMajor >= 26 ? 'h-11' : macosMajor <= 15 ? 'h-14' : 'h-12') : 'h-12';
  return (
    <header
      className={cn(
        'app-region-drag flex shrink-0 select-none items-center gap-3 bg-background',
        // oxlint-disable-next-line openchamber/no-physical-sides -- window chrome is physical
        hasMacTrafficLights ? 'pl-[88px]' : direction === 'rtl' && controlsAtEnd ? 'pl-0' : 'pl-3',
        // oxlint-disable-next-line openchamber/no-physical-sides -- window chrome is physical
        direction === 'ltr' && controlsAtEnd ? 'pr-0' : 'pr-3',
        macosHeight,
      )}
    >
      {controlsAtStart ? <WindowsWindowControls visible position={side} /> : null}
      <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">
        {label}
      </span>
      {controlsAtEnd ? <WindowsWindowControls visible position={side} /> : null}
    </header>
  );
};

const CenterEmptyHint: React.FC = () => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory();
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const shown = useUIStore((state) => isZoneShown(
    directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined,
    state.contextSurfaceZones,
    'bottom',
  ));
  if (shown) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
      {t('contextPanel.window.empty')}
    </div>
  );
};

export const ContextWindowLayout: React.FC = () => {
  useSessionListSync({ isVSCode: false });
  useTerminalSessionKeepalive();
  useContextWindowPanel();
  const hasHeader = isDesktopShell();

  return (
    <DiagnosticDialogAvailableContext.Provider value><DiffWorkerProvider>
      <ProjectActionsProvider>
        <div data-page-scroll-lock="true" className="main-content-safe-area relative flex h-[100dvh] flex-col bg-background">
          {hasHeader ? <ContextWindowHeader /> : null}
          <div className={cn('relative flex min-h-0 flex-1 overflow-hidden', !hasHeader && 'pt-2')} data-page-scroll-lock="true">
            <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true" data-workspace-row="true">
              <ContextPanel zone="left" variant="side" />
              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-workspace-chat="true" data-workspace-center="">
                  <ContextPanel zone="bottom" variant="center" />
                  <CenterEmptyHint />
                </div>
                <ContextPanel zone="right" variant="side" />
                <ContextSurfacePanes />
                <ZoneDropOverlay />
              </div>
            </div>
            <div data-page-scroll-lock="true">
              <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
            </div>
            <ErrorBoundary><GuestHosts /></ErrorBoundary>
          </div>
        </div>
      </ProjectActionsProvider>
    </DiffWorkerProvider></DiagnosticDialogAvailableContext.Provider>
  );
};
