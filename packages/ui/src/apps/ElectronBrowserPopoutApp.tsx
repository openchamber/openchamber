import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { StandaloneBrowserPane } from '@/components/layout/ContextPanel';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { SyncProvider } from '@/sync/sync-context';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { BROWSER_POPOUT_CHANNEL, browserPopoutKey, postBrowserPopoutMessage } from '@/stores/useBrowserPopoutStore';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import type { RuntimeAPIs } from '@/lib/api/types';

type BrowserPopoutConfig = { directory: string; tabID: string; url: string };

const readBrowserPopoutConfig = (): BrowserPopoutConfig => {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  return {
    directory: params.get('directory')?.trim() || '',
    tabID: params.get('tabID')?.trim() || 'popout',
    url: params.get('url')?.trim() || '',
  };
};

const dismissSplash = () => {
  const el = typeof document !== 'undefined' ? document.getElementById('initial-loading') : null;
  if (el) {
    el.classList.add('fade-out');
    window.setTimeout(() => el.remove(), 300);
  }
};

/**
 * Standalone browser window. Renders the same browser pane as the context panel,
 * wired to the runtime + sync context so it can navigate and stay registered as
 * the agent controller — but in a separate, resizable, movable OS window.
 */
export function ElectronBrowserPopoutApp({ apis }: { apis: RuntimeAPIs }) {
  const config = React.useMemo(() => readBrowserPopoutConfig(), []);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  React.useEffect(() => {
    if (config.directory && currentDirectory !== config.directory) {
      useDirectoryStore.getState().setDirectory(config.directory, { showOverlay: false });
    }
  }, [config.directory, currentDirectory]);

  React.useEffect(() => {
    opencodeClient.setDirectory(config.directory || currentDirectory || undefined);
  }, [config.directory, currentDirectory]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    const timer = window.setTimeout(dismissSplash, 200);
    return () => window.clearTimeout(timer);
  }, []);

  // Publish the titlebar inset the browser toolbar reads (var(--oc-titlebar-left-inset)).
  // macOS traffic lights need a ~5.5rem left gap, but they're hidden in fullscreen —
  // drop the inset then instead of leaving a dead gap (mirrors Header.tsx).
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const isMac = (window.__OPENCHAMBER_MACOS_MAJOR__ ?? 0) > 0;
    if (!isMac) {
      document.documentElement.style.setProperty('--oc-titlebar-left-inset', '0.75rem');
      return undefined;
    }
    let disposed = false;
    const sync = async () => {
      let fullscreen = false;
      try {
        fullscreen = (await invokeDesktopCommand<boolean>('desktop_is_window_fullscreen')) === true;
      } catch {
        fullscreen = false;
      }
      if (!disposed) document.documentElement.style.setProperty('--oc-titlebar-left-inset', fullscreen ? '0.75rem' : '5.5rem');
    };
    const onResize = () => { void sync(); };
    void sync();
    window.addEventListener('openchamber:window-resized', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('openchamber:window-resized', onResize);
    };
  }, []);

  // Cross-window coordination: tell the panel to re-attach when this window
  // closes, and close on a "dock" (bring back) request from the panel.
  React.useEffect(() => {
    const key = browserPopoutKey(config.directory, config.tabID);
    const notifyClosed = () => postBrowserPopoutMessage({ type: 'closed', key });
    window.addEventListener('beforeunload', notifyClosed);
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(BROWSER_POPOUT_CHANNEL);
      channel.onmessage = (event) => {
        const message = event.data as { type?: string; key?: string } | null;
        if (message && message.type === 'dock' && message.key === key) window.close();
      };
    }
    return () => {
      window.removeEventListener('beforeunload', notifyClosed);
      channel?.close();
    };
  }, [config.directory, config.tabID]);

  useWindowTitle();

  const directory = config.directory || currentDirectory || '';

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={directory}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="relative h-full bg-background text-foreground">
              <StandaloneBrowserPane
                initialUrl={config.url}
                directory={directory}
                tabID={config.tabID}
                controllerId={`${directory}::${config.tabID}`}
                isPopout
              />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
