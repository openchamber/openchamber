import React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { viewerPointToFrameCss, type RemoteSurfaceClient, type SurfaceFrameHeader } from '@/lib/browser/remoteSurface';
import type { useRemoteBrowserClipboard } from './useRemoteBrowserClipboard';

type Props = {
  readonly client: RemoteSurfaceClient;
  readonly enabled: boolean;
  readonly canvas: React.RefObject<HTMLCanvasElement | null>;
  readonly frame: SurfaceFrameHeader | null;
  readonly clipboard: ReturnType<typeof useRemoteBrowserClipboard>;
  readonly onOpenDevTools?: () => void;
  readonly children: React.ReactElement;
};

export function RemoteBrowserContextMenu({ client, enabled, canvas, frame, clipboard, onOpenDevTools, children }: Props) {
  const { t } = useI18n();
  const state = React.useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const [outcome, setOutcome] = React.useState<'menu' | 'unavailable' | null>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const generation = React.useRef(0);
  const inputScope = React.useRef<() => boolean>(() => false);
  const ownsEscape = React.useRef(false);
  const dismiss = React.useCallback(() => {
    generation.current += 1;
    ownsEscape.current = false;
    client.contextMenu.cancel();
    setOutcome(null);
  }, [client]);

  React.useLayoutEffect(() => {
    dismiss();
    return client.subscribe(() => { if (!inputScope.current()) dismiss(); });
  }, [client, dismiss, enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ownsEscape.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (event.key === 'Tab') dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', dismiss);
    return () => {
      generation.current += 1;
      client.contextMenu.cancel();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [client, dismiss, enabled]);

  const request = (event: React.MouseEvent) => {
    dismiss();
    if (!enabled || !frame || !canvas.current) return;
    const rect = canvas.current.getBoundingClientRect();
    const point = viewerPointToFrameCss({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, frame);
    if (!point) return;
    const current = generation.current;
    const isCurrent = client.captureInputScope();
    inputScope.current = isCurrent;
    ownsEscape.current = true;
    void client.contextMenu.request(point).then((result) => {
      if (current !== generation.current || !isCurrent()) return;
      switch (result) {
        case 'menu': setOutcome('menu'); return;
        case 'unavailable':
          ownsEscape.current = false;
          setOutcome('unavailable');
          return;
        case 'page-handled':
        case 'cancelled':
          ownsEscape.current = false;
          return;
      }
    });
  };
  const navigate = (action: 'back' | 'forward' | 'reload') => {
    if (inputScope.current()) client.navigateHistory(action);
    dismiss();
  };

  return <>
    <ContextMenu open={enabled && outcome === 'menu'} onOpenChange={(open) => { if (!open) dismiss(); }}>
      <ContextMenuTrigger render={children} onContextMenu={request} />
      <ContextMenuContent ref={menu} className="bg-[var(--surface-elevated)]"
        onKeyDown={(event) => {
          if (!getDropdownNavigationKey(event)) event.stopPropagation();
        }}>
        <ContextMenuItem disabled={!activeTab?.canGoBack} onClick={() => navigate('back')}>{t('contextPanel.browser.back')}</ContextMenuItem>
        <ContextMenuItem disabled={!activeTab?.canGoForward} onClick={() => navigate('forward')}>{t('contextPanel.browser.forward')}</ContextMenuItem>
        <ContextMenuItem onClick={() => navigate('reload')}>{t('contextPanel.browser.reload')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={clipboard.busy} onClick={() => { if (inputScope.current()) void clipboard.copy(); dismiss(); }}>
          {t('contextPanel.browser.remote.clipboard.copy')}
        </ContextMenuItem>
        <ContextMenuItem disabled={clipboard.busy} onClick={() => { if (inputScope.current()) void clipboard.paste(); dismiss(); }}>
          {t('contextPanel.browser.remote.clipboard.paste')}
        </ContextMenuItem>
        {onOpenDevTools ? <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { if (inputScope.current()) onOpenDevTools(); dismiss(); }}>
            {t('contextPanel.browser.remote.openDevTools')}
          </ContextMenuItem>
        </> : null}
      </ContextMenuContent>
    </ContextMenu>
    {outcome === 'unavailable' ? <p role="status"
      className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/90 px-3 py-2 typography-micro text-muted-foreground">
      {t('contextPanel.browser.remote.contextMenuUnavailable')}
    </p> : null}
  </>;
}
