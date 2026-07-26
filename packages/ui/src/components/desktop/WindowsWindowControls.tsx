import React, { useEffect } from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { invokeDesktop } from '@/lib/desktop';
import type { DesktopWindowControlsSide } from '@/lib/desktop';

type WindowsWindowControlsProps = {
  visible: boolean;
  position?: DesktopWindowControlsSide;
};

export const WindowsWindowControls = React.memo(function WindowsWindowControls({
  visible,
  position = 'right',
}: WindowsWindowControlsProps) {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = React.useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let disposed = false;
    void invokeDesktop<{ maximized?: boolean }>('desktop_get_current_window_state')
      .then((state) => {
        if (!disposed) {
          setIsMaximized(Boolean(state?.maximized));
        }
      })
      .catch(() => {});

    const handleMaximizedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ maximized?: boolean }>).detail;
      setIsMaximized(Boolean(detail?.maximized));
    };

    window.addEventListener('openchamber:window-maximized-changed', handleMaximizedChange);
    return () => {
      disposed = true;
      window.removeEventListener('openchamber:window-maximized-changed', handleMaximizedChange);
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  // Left-side controls sit in the same cluster as h-8 titlebar icon buttons
  // (app menu / sidebar / project actions). Match that size and avoid negative
  // margins so TitlebarLeftControls can publish an accurate reserved width —
  // otherwise the project-actions chevron overlaps the session title.
  // Right-side controls keep a taller Windows-style hit target.
  const isLeft = position === 'left';
  const buttonClassName = cn(
    'app-region-no-drag inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    isLeft ? 'h-8 w-8 rounded-md' : 'h-12 w-11',
  );
  const containerClassName = isLeft
    ? 'app-region-no-drag mr-1 flex h-8 shrink-0 items-center'
    : 'app-region-no-drag ml-1 flex h-12 shrink-0 items-center';

  return (
    <div className={containerClassName} aria-label={t('header.windowControls.groupAria')}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => { void invokeDesktop('desktop_minimize_current_window'); }}
        title={t('header.windowControls.minimize')}
        aria-label={t('header.windowControls.minimize')}
      >
        <Icon name="subtract" className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => {
          void invokeDesktop<{ maximized?: boolean }>('desktop_toggle_current_window_maximized')
            .then((state) => setIsMaximized(Boolean(state?.maximized)))
            .catch(() => {});
        }}
        title={isMaximized ? t('header.windowControls.restore') : t('header.windowControls.maximize')}
        aria-label={isMaximized ? t('header.windowControls.restore') : t('header.windowControls.maximize')}
      >
        <Icon name={isMaximized ? 'fullscreen-exit' : 'checkbox-blank'} className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cn(buttonClassName, 'hover:bg-status-error hover:text-status-error-foreground')}
        onClick={() => { void invokeDesktop('desktop_close_current_window'); }}
        title={t('header.windowControls.close')}
        aria-label={t('header.windowControls.close')}
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>
  );
});
