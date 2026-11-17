import React, { useEffect } from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getDesktopWindowControlsOrder, invokeDesktop } from '@/lib/desktop';
import type { DesktopWindowControlAction, DesktopWindowControlsSide } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

const TRAFFIC_LIGHT_FILL: Record<DesktopWindowControlAction, string> = {
  close: '#FF5F57',
  minimize: '#FEBC2E',
  maximize: '#28C940',
};
const TRAFFIC_LIGHT_GLYPH = 'rgba(0, 0, 0, 0.7)';

const TrafficLightGlyph: React.FC<{ action: DesktopWindowControlAction }> = ({ action }) => {
  if (action === 'close') {
    return <Icon name="close" className="size-[10px]" />;
  }
  if (action === 'minimize') {
    return <Icon name="subtract" className="size-[10px]" />;
  }
  return <Icon name="add" className="size-[10px]" />;
};

type TrafficLightButtonProps = {
  action: DesktopWindowControlAction;
  isMaximized: boolean;
  onActivate: (action: DesktopWindowControlAction) => void;
};

const TrafficLightButton: React.FC<TrafficLightButtonProps> = ({ action, isMaximized, onActivate }) => {
  const { t } = useI18n();
  const fill = TRAFFIC_LIGHT_FILL[action];
  const label =
    action === 'close'
      ? t('header.windowControls.close')
      : action === 'minimize'
        ? t('header.windowControls.minimize')
        : isMaximized
          ? t('header.windowControls.restore')
          : t('header.windowControls.maximize');
  return (
    <button
      type="button"
      onClick={() => onActivate(action)}
      title={label}
      aria-label={label}
      className="app-region-no-drag flex h-8 w-[24px] items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className="flex size-3.5 items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.28)] transition-[filter] duration-75 active:brightness-90"
        style={{ backgroundColor: fill, color: TRAFFIC_LIGHT_GLYPH }}
      >
        <span className="flex items-center justify-center opacity-0 transition-opacity duration-75 group-hover/wctl:opacity-100">
          <TrafficLightGlyph action={action} />
        </span>
      </span>
    </button>
  );
};

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
  const desktopWindowControlsStyle = useUIStore((state) => state.desktopWindowControlsStyle);

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

  const isLeft = position === 'left';
  const order = getDesktopWindowControlsOrder(position);

  const activate = (action: DesktopWindowControlAction) => {
    if (action === 'close') {
      void invokeDesktop('desktop_close_current_window');
      return;
    }
    if (action === 'minimize') {
      void invokeDesktop('desktop_minimize_current_window');
      return;
    }
    void invokeDesktop<{ maximized?: boolean }>('desktop_toggle_current_window_maximized')
      .then((state) => setIsMaximized(Boolean(state?.maximized)))
      .catch(() => {});
  };

  if (desktopWindowControlsStyle === 'traffic-lights') {
    return (
      <div
        dir="ltr"
        className={cn(
          'app-region-no-drag group/wctl flex h-8 shrink-0 items-center',
          isLeft ? 'me-1' : 'ms-1 me-3',
        )}
        aria-label={t('header.windowControls.groupAria')}
      >
        {order.map((action) => (
          <TrafficLightButton key={action} action={action} isMaximized={isMaximized} onActivate={activate} />
        ))}
      </div>
    );
  }

  const buttonClassName = cn(
    'app-region-no-drag inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isLeft ? 'h-8 w-8 rounded-md' : 'h-12 w-11',
  );
  const containerClassName = isLeft
    ? 'app-region-no-drag me-1 flex h-8 shrink-0 items-center'
    : 'app-region-no-drag ms-1 flex h-12 shrink-0 items-center';

  const renderControl = (action: DesktopWindowControlAction) => {
    if (action === 'minimize') {
      return (
        <button
          key="minimize"
          type="button"
          className={buttonClassName}
          onClick={() => { void invokeDesktop('desktop_minimize_current_window'); }}
          title={t('header.windowControls.minimize')}
          aria-label={t('header.windowControls.minimize')}
        >
          <Icon name="subtract" className="h-4 w-4" />
        </button>
      );
    }

    if (action === 'maximize') {
      return (
        <button
          key="maximize"
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
      );
    }

    return (
      <button
        key="close"
        type="button"
        className={cn(
          buttonClassName,
          'hover:bg-[var(--status-error)] hover:text-[var(--status-error-foreground)]',
        )}
        onClick={() => { void invokeDesktop('desktop_close_current_window'); }}
        title={t('header.windowControls.close')}
        aria-label={t('header.windowControls.close')}
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    );
  };

  return (
    <div dir="ltr" className={containerClassName} aria-label={t('header.windowControls.groupAria')}>
      {order.map(renderControl)}
    </div>
  );
});
