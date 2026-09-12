import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { RemoteSurfaceClient } from '@/lib/browser/remoteSurface';
import { RemoteBrowserCanvas } from './RemoteBrowserCanvas';
import { RemoteBrowserChrome, type BrowserInspectionMode } from './RemoteBrowserChrome';
import { RemoteBrowserViewportControls } from './RemoteBrowserViewportControls';
import { RemoteBrowserInspectionPanel } from './RemoteBrowserInspectionPanel';
import { useUIStore, type SavedServerBrowserSelection } from '@/stores/useUIStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type RemoteBrowserPaneProps = {
  readonly directory: string;
  readonly tabID?: string;
  readonly onSelectRemoteTab?: (sessionId: string, serverTargetId: string) => void;
  readonly sessionId?: string;
  readonly serverTargetId?: string;
  readonly visible?: boolean;
  readonly savedSelections?: readonly SavedServerBrowserSelection[];
  readonly onSelectSavedSelection?: (selection: SavedServerBrowserSelection) => void;
};

const RemoteBrowserView: React.FC<RemoteBrowserPaneProps> = ({
  directory,
  tabID,
  sessionId,
  serverTargetId,
  onSelectRemoteTab,
  visible = true,
  savedSelections,
  onSelectSavedSelection,
}) => {
  const { t } = useI18n();
  const pagePanelId = React.useId();
  const setServerBrowser = useUIStore((state) => state.setContextPanelTabServerBrowser);
  const setTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const clientRef = React.useRef<RemoteSurfaceClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RemoteSurfaceClient({
      directory,
      sessionId,
      preferredTabId: serverTargetId,
    });
  }
  const client = clientRef.current;
  const state = React.useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const [frameFailed, setFrameFailed] = React.useState(false);
  const [inspectionMode, setInspectionMode] = React.useState<BrowserInspectionMode>(null);
  const [inspectorMaximized, setInspectorMaximized] = React.useState(false);
  const [viewportControlsOpen, setViewportControlsOpen] = React.useState(false);
  const [stageSize, setStageSize] = React.useState({ width: 0, height: 0 });
  const [displayScale, setDisplayScale] = React.useState<number | null>(null);
  const inspectorButton = React.useRef<HTMLButtonElement>(null);
  const previousSelection = React.useRef({ sessionId, serverTargetId });

  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    const updateVisibility = () => {
      if (!visible || document.visibilityState === 'hidden') client.stop();
      else if (getRuntimeKey() === runtimeKey) void client.start();
    };
    const unsubscribe = subscribeRuntimeEndpointChanged((detail) => {
      client.stop();
      if (detail.runtimeKey === detail.previousRuntimeKey) updateVisibility();
    });
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', updateVisibility);
      client.stop();
    };
  }, [client, visible]);

  React.useEffect(() => {
    client.devtools.setOpen(inspectionMode === 'devtools');
    client.inspector.setOpen(inspectionMode === 'simple');
  }, [client, inspectionMode]);

  React.useEffect(() => {
    client.viewport.setVisible(visible && !inspectorMaximized);
  }, [client, inspectorMaximized, visible]);

  const changeInspectionMode = React.useCallback((mode: BrowserInspectionMode) => {
    setInspectionMode(mode);
    if (!mode) setInspectorMaximized(false);
  }, []);

  const changeDisplayScale = React.useCallback((next: number | null) => {
    setDisplayScale((current) => current === next ? current : next);
  }, []);

  React.useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { sessionId, serverTargetId };
    if (sessionId !== previous.sessionId && sessionId && sessionId !== client.getState().session?.id) {
      client.attachSession(sessionId);
    }
    if (serverTargetId !== previous.serverTargetId && serverTargetId && serverTargetId !== client.getState().activeTabId) {
      client.attachTab(serverTargetId);
    }
  }, [client, serverTargetId, sessionId]);

  const activeServerTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  React.useEffect(() => {
    if (!state.session || !state.activeTabId) return;
    onSelectRemoteTab?.(state.session.id, state.activeTabId);
    if (!tabID) return;
    setServerBrowser(directory, tabID, {
      browserSessionId: state.session.id,
      serverTargetId: state.activeTabId,
    });
    if (activeServerTab?.url) setTargetPath(directory, tabID, activeServerTab.url);
  }, [activeServerTab?.url, directory, onSelectRemoteTab, setServerBrowser, setTargetPath, state.activeTabId, state.session, tabID]);

  React.useEffect(() => {
    if (state.phase !== 'ended' || !tabID) return;
    setServerBrowser(directory, tabID, { browserSessionId: null, serverTargetId: null });
  }, [directory, setServerBrowser, state.phase, tabID]);

  const showChoice = state.phase === 'choosing';
  const showEnded = state.phase === 'ended';
  const showError = state.phase === 'error' || frameFailed;
  const showConnecting = state.phase === 'connecting' || state.phase === 'attaching';

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <RemoteBrowserChrome client={client} state={state} inspectionMode={inspectionMode} onInspectionModeChange={changeInspectionMode}
        inspectorButton={inspectorButton} viewportControlsOpen={viewportControlsOpen}
        onToggleViewportControls={() => setViewportControlsOpen((open) => !open)}
        pagePanelId={pagePanelId}
        savedSelections={savedSelections} onSelectSavedSelection={onSelectSavedSelection} />
      {state.session && viewportControlsOpen ? <RemoteBrowserViewportControls viewport={client.viewport}
        enabled={state.phase === 'attached'} stage={stageSize} displayScale={displayScale} /> : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div id={pagePanelId} role="tabpanel" aria-labelledby={activeServerTab ? `${pagePanelId}-tab-${encodeURIComponent(activeServerTab.id)}` : undefined}
        aria-label={activeServerTab ? undefined : t('contextPanel.browser.remote.canvasAria')}
        className={`relative min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--surface-muted)] ${inspectorMaximized ? 'hidden' : 'flex'}`}>
        <RemoteBrowserCanvas client={client} activeTabId={state.activeTabId}
          enabled={visible && state.phase === 'attached'} onFrameFailure={setFrameFailed}
          onOpenDevTools={() => changeInspectionMode('devtools')}
          onDisplayScaleChange={changeDisplayScale} onStageSize={setStageSize} />

        {showChoice ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <Icon name="server" className="size-10 text-muted-foreground/50" />
            <div className="typography-ui-header text-foreground">{t('contextPanel.browser.remote.chooseTitle')}</div>
            <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.remote.chooseHint')}</div>
            {state.sessions.length > 0 ? (
              <div className="flex w-full max-w-sm flex-col gap-2">
                {state.sessions.map((session) => (
                  <Button key={session.id} variant="outline" onClick={() => client.attachSession(session.id)}>
                    {session.persistence === 'ephemeral'
                      ? t('contextPanel.browser.remote.sessionEphemeral')
                      : t('contextPanel.browser.remote.sessionProject')}
                    <span className="ml-2 text-muted-foreground">{session.id.slice(0, 8)}</span>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="typography-micro text-muted-foreground">{t('contextPanel.browser.remote.noSessions')}</div>
            )}
            <Button onClick={() => client.createSession()}>{t('contextPanel.browser.remote.newSession')}</Button>
          </div>
        ) : null}

        {showConnecting ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.remote.connecting')}</span>
          </div>
        ) : null}

        {state.phase === 'reconnecting' ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-background/90 px-3 py-2 text-center typography-micro text-muted-foreground">
            {t('contextPanel.browser.remote.reconnecting')}
          </div>
        ) : null}

        {showError || showEnded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <Icon name="server" className="size-10 text-muted-foreground/50" />
            <div className="typography-ui-header text-foreground">
              {showEnded ? t('contextPanel.browser.remote.endedTitle') : t('contextPanel.browser.remote.errorTitle')}
            </div>
            {state.errorMessage ? <div className="max-w-sm typography-micro text-muted-foreground">{state.errorMessage}</div> : null}
            <Button variant="outline" onClick={() => {
              setFrameFailed(false);
              if (state.phase === 'attached' && state.activeTabId) client.attachTab(state.activeTabId);
              else void client.start();
            }}>{t('contextPanel.browser.remote.retry')}</Button>
          </div>
        ) : null}
      </div>
      {inspectionMode ? <RemoteBrowserInspectionPanel client={client} mode={inspectionMode} onModeChange={changeInspectionMode}
        maximized={inspectorMaximized} onMaximizedChange={setInspectorMaximized} returnFocus={inspectorButton} /> : null}
      </div>
    </div>
  );
};

export const RemoteBrowserPane: React.FC<RemoteBrowserPaneProps> = (props) => {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  return <RemoteBrowserView key={`${runtimeKey}\n${props.directory}`} {...props} />;
};
