import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-interactive-hover transition-colors';

/**
 * Persistent top-left titlebar controls (app menu on frameless chrome + sidebar toggle).
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so the buttons never migrate / re-mount between the
 * two while the sidebar animates open or closed — the panels slide *underneath*
 * a fixed control cluster instead. Its height tracks `--oc-header-height` and
 * its left padding clears the OS window controls via `--oc-titlebar-left-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * so the header can reserve matching space when the sidebar is collapsed.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t, locale } = useI18n();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  // Starting a session shares the titlebar row with the sidebar toggle, so it
  // stays in one place whether the sidebar is open or collapsed.
  const handleNewSession = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().openNewSessionDraft();
  }, []);
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
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      document.documentElement.style.setProperty('--oc-titlebar-controls-width', `${Math.round(width)}px`);
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
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      className="app-region-no-drag absolute left-0 top-0 z-30 flex select-none items-center pr-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingLeft: 'var(--oc-titlebar-left-inset, 0.75rem)',
        // The overlay floats above the sidebar rather than inside it, so it is
        // sized by its own content: the icon buttons and the "New session" label
        // are rem-sized and grow with Interface Font Size, while the sidebar and
        // the macOS window-controls clearance are fixed pixels. Left uncapped the
        // cluster runs past the sidebar edge and paints over the chat pane, so
        // cap it here and let the label truncate.
        maxWidth: isSidebarOpen ? 'var(--oc-left-sidebar-width, 100%)' : undefined,
      }}
    >
      <div ref={clusterRef} className="flex min-w-0 items-center gap-2">
        {usesFramelessChrome && windowControlsSide === 'left' ? (
          <WindowsWindowControls visible position="left" />
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
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
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
              aria-label={t('header.actions.openSessionsAria')}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
            >
              <Icon name="layout-left" className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        {/* Labelled while the sidebar is open; collapses to an icon with a
            tooltip so the cluster stays compact over the header otherwise. */}
        {isSidebarOpen ? (
          <button
            type="button"
            onClick={handleNewSession}
            className={cn(ICON_BUTTON_CLASS, '-ml-1 w-auto min-w-0 px-2 font-normal')}
          >
            <Icon name="chat-new" className="h-[18px] w-[18px] shrink-0" />
            <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleNewSession}
                aria-label={t('sessions.sidebar.header.actions.newSession')}
                className={cn(ICON_BUTTON_CLASS, '-ml-1 shrink-0')}
              >
                <Icon name="chat-new" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('sessions.sidebar.header.actions.newSession')}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
