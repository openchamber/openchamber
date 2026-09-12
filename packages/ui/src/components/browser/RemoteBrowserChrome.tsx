import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import type { RemoteSurfaceClient, RemoteSurfaceState } from '@/lib/browser/remoteSurface';
import { BLANK_URL, normalizeBrowserUrl } from '@/lib/browser/url';
import type { SavedServerBrowserSelection } from '@/stores/useUIStore';
import { BrowserToolbar } from './BrowserToolbar';

export type BrowserInspectionMode = 'devtools' | 'simple' | null;

type Props = {
  readonly client: RemoteSurfaceClient;
  readonly state: RemoteSurfaceState;
  readonly inspectionMode: BrowserInspectionMode;
  readonly onInspectionModeChange: (mode: BrowserInspectionMode) => void;
  readonly inspectorButton: React.RefObject<HTMLButtonElement | null>;
  readonly viewportControlsOpen: boolean;
  readonly onToggleViewportControls: () => void;
  readonly pagePanelId: string;
  readonly savedSelections?: readonly SavedServerBrowserSelection[];
  readonly onSelectSavedSelection?: (selection: SavedServerBrowserSelection) => void;
};

export function RemoteBrowserChrome({ client, state, inspectionMode, onInspectionModeChange,
  inspectorButton, viewportControlsOpen, onToggleViewportControls, pagePanelId, savedSelections = [], onSelectSavedSelection }: Props) {
  const { t } = useI18n();
  const [address, setAddress] = React.useState('');
  const tabRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const enabled = state.phase === 'attached';
  const moveTabFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.tabs.length === 0) return;
    const currentIndex = state.tabs.findIndex((tab) => tabRefs.current.get(tab.id) === event.target);
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? state.tabs.length - 1
        : event.key === 'ArrowLeft' ? (currentIndex - 1 + state.tabs.length) % state.tabs.length
          : (currentIndex + 1) % state.tabs.length;
    const nextTab = state.tabs[nextIndex];
    if (nextTab) tabRefs.current.get(nextTab.id)?.focus({ preventScroll: true });
  };
  React.useEffect(() => {
    setAddress(activeTab?.url === BLANK_URL ? '' : activeTab?.url ?? '');
  }, [activeTab?.url, state.activeTabId]);
  if (!state.session) return null;
  const knownSessionIds = new Set(savedSelections.map((selection) => selection.browserSessionId));
  const otherSessions = state.sessions.filter((session) => !knownSessionIds.has(session.id));

  return <>
    <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <DropdownMenu>
        <DropdownMenuTrigger className={dropdownTriggerVariants({ size: 'sm' })}
          aria-label={t('contextPanel.browser.remote.sessionsMenu')}>
          <Icon name="server" className="size-3.5" />
          <Icon name="arrow-down-s" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[min(24rem,calc(100vw-1rem))]">
          {savedSelections.length > 0 ? <DropdownMenuLabel>{t('contextPanel.browser.remote.savedSessions')}</DropdownMenuLabel> : null}
          {savedSelections.map((selection) => {
            const currentSessionOwnsTarget = state.tabs.some((tab) => tab.id === selection.serverTargetId);
            const sessionId = selection.browserSessionId ?? (currentSessionOwnsTarget ? state.session?.id : undefined);
            return <DropdownMenuItem key={`${selection.browserSessionId ?? ''}:${selection.serverTargetId ?? ''}`}
              disabled={!sessionId} onSelect={() => {
                if (!sessionId) return;
                if (onSelectSavedSelection) onSelectSavedSelection({ ...selection, browserSessionId: sessionId });
                else {
                  if (sessionId !== state.session?.id) client.attachSession(sessionId);
                  if (selection.serverTargetId) client.attachTab(selection.serverTargetId);
                }
              }}>
              <span className="min-w-0 truncate">{selection.targetPath || t('contextPanel.browser.remote.sessionProject')}</span>
              <span className="ml-auto shrink-0 typography-micro text-muted-foreground">{sessionId?.slice(0, 8)}</span>
            </DropdownMenuItem>;
          })}
          {otherSessions.length > 0 ? <DropdownMenuLabel>{t('contextPanel.browser.remote.availableSessions')}</DropdownMenuLabel> : null}
          {otherSessions.map((session) => <DropdownMenuItem key={session.id} onSelect={() => client.attachSession(session.id)}>
            {t(session.persistence === 'ephemeral' ? 'contextPanel.browser.remote.sessionEphemeral' : 'contextPanel.browser.remote.sessionProject')}
            <span className="ml-auto typography-micro text-muted-foreground">{session.id.slice(0, 8)}</span>
          </DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => client.createSession()}>{t('contextPanel.browser.remote.newSession')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist"
        aria-label={t('contextPanel.browser.remote.tabLabel')} onKeyDown={moveTabFocus}>
        {state.tabs.map((tab) => {
          const selected = tab.id === state.activeTabId;
          return <Button key={tab.id} ref={(node) => {
            if (node) tabRefs.current.set(tab.id, node);
            else tabRefs.current.delete(tab.id);
          }} id={`${pagePanelId}-tab-${encodeURIComponent(tab.id)}`} role="tab" variant={selected ? 'secondary' : 'chip'} size="xs"
            aria-selected={selected} aria-controls={pagePanelId} tabIndex={selected ? 0 : -1} disabled={!enabled}
            onClick={() => client.attachTab(tab.id)} className="max-w-48 shrink-0">
          <span className="truncate">{tab.title || tab.url || t('contextPanel.browser.remote.tabLabel')}</span>
          </Button>;
        })}
      </div>
      <Button variant="ghost" size="xs" disabled={!enabled} aria-label={t('contextPanel.browser.newTab')}
        onClick={() => client.createTab()}><Icon name="add" className="size-4" /></Button>
    </div>
    <BrowserToolbar address={address} onAddressChange={setAddress}
      onSubmit={(value) => client.navigate(value.trim() === BLANK_URL ? BLANK_URL : normalizeBrowserUrl(value))}
      onBack={() => client.navigateHistory('back')} onForward={() => client.navigateHistory('forward')}
      onReload={() => client.navigateHistory(activeTab?.isLoading ? 'stop' : 'reload')}
      canGoBack={enabled && activeTab?.canGoBack === true} canGoForward={enabled && activeTab?.canGoForward === true}
      isLoading={activeTab?.isLoading === true} agentControlling={state.agentControlling}
      onToggleDeviceBar={onToggleViewportControls} isDeviceBarOpen={viewportControlsOpen}
      devToolsButtonRef={inspectorButton} devToolsLabel={t('contextPanel.browser.remote.openDevTools')}
      devToolsPressed={inspectionMode === 'devtools'}
      onOpenDevTools={enabled ? () => onInspectionModeChange(inspectionMode === 'devtools' ? null : 'devtools') : undefined} />
  </>;
}
