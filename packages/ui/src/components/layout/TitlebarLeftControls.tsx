import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { isChatCoveredByPage, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { publishTitlebarControlsWidth } from './titlebarControlsWidth';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-6 w-6 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors';

export const TitlebarLeftControls: React.FC = () => {
  const { t, locale, direction } = useI18n();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const handleNewSession = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().openNewSessionDraft();
  }, []);
  const tabsShown = useUIStore((state) => state.sessionTabsEnabled && !isChatCoveredByPage(state));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
      locale,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, [locale]);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      publishTitlebarControlsWidth(width);
    };

    publishWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      data-titlebar-left-controls=""
      className="app-region-no-drag absolute inset-s-0 top-0 z-30 flex select-none items-center pe-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingInlineStart: 'var(--oc-titlebar-start-inset, 0.75rem)',
        maxWidth: isSidebarOpen ? 'var(--oc-left-sidebar-width, 100%)' : undefined,
      }}
    >
      <div ref={clusterRef} className="flex min-w-0 items-center gap-2">
        {usesFramelessChrome && windowControlsSide === getInlineStartSide(direction) ? (
          <WindowsWindowControls visible position={windowControlsSide} />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              data-sidebar-toggle=""
              aria-label={t('header.actions.openSessionsAria')}
              aria-pressed={isSidebarOpen}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0', isSidebarOpen && 'text-foreground')}
            >
              <Icon name="panel-left" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        {tabsShown ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleNewSession}
                aria-label={t('sessions.sidebar.header.actions.newSession')}
                className={cn(ICON_BUTTON_CLASS, '-ms-1 shrink-0')}
              >
                <Icon name="edit-box" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <TooltipLabelWithShortcut label={t('sessions.sidebar.header.actions.newSession')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('new_chat', shortcutOverrides), '')} />
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
