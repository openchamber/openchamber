import React, { useEffect } from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getDesktopWindowControlsOrder, invokeDesktop } from '@/lib/desktop';
import type { DesktopWindowControlAction, DesktopWindowControlsSide } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

// macOS chrome colors; intentionally theme-independent — these replicate a
// foreign platform's chrome, not OpenChamber's own status tokens, so the
// theme-system hex rule does not apply.
const TRAFFIC_LIGHT_FILL: Record<DesktopWindowControlAction, string> = {
  close: '#FF5F57',
  minimize: '#FEBC2E',
  maximize: '#28C940',
};
// Glyphs are a uniform translucent black, matching macOS — opacity lets the
// fill tint the symbol so it reads on all three fills without per-action colors.
const TRAFFIC_LIGHT_GLYPH = 'rgba(0, 0, 0, 0.7)';

const TrafficLightGlyph: React.FC<{ action: DesktopWindowControlAction }> = ({ action }) => {
  if (action === 'close') {
    return <Icon name="close" className="size-[10px]" />;
  }
  if (action === 'minimize') {
    return <Icon name="subtract" className="size-[10px]" />;
  }
  // Green maximize/restore: same `add` (+) glyph for both states. The label
  // (restore vs maximize) still flips via isMaximized in TrafficLightButton.
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
      // 24px-wide button wrapping a 14px circle centers it at a 24px interval
      // between neighbors, giving a 10px edge-to-edge gap. The 32px height
      // keeps the titlebar's vertical hit band.
      className="app-region-no-drag flex h-8 w-[24px] items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
  // Order is side-driven for both styles: close, minimize, maximize on the
  // left; minimize, maximize, close on the right.
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

  // Traffic-light chrome: macOS-style 14px circles in an h-8 band. Glyphs
  // reveal on any-cluster hover (group-hover/wctl). TitlebarLeftControls
  // measures and republishes the cluster width via ResizeObserver, so the
  // narrower footprint takes effect without touching reserved-width constants.
  if (desktopWindowControlsStyle === 'traffic-lights') {
    return (
      <div
        className={cn(
          'app-region-no-drag group/wctl flex h-8 shrink-0 items-center',
          isLeft ? 'mr-1' : 'ml-1',
        )}
        aria-label={t('header.windowControls.groupAria')}
      >
        {order.map((action) => (
          <TrafficLightButton key={action} action={action} isMaximized={isMaximized} onActivate={activate} />
        ))}
      </div>
    );
  }

  // Classic Windows-style square buttons. Left side matches the h-8 titlebar
  // icon cluster (app menu / sidebar / project actions) and avoids negative
  // margins so TitlebarLeftControls publishes an accurate reserved width —
  // otherwise the project-actions chevron overlaps the session title. Right
  // side keeps a taller h-12 Windows-style hit target.
  const buttonClassName = cn(
    'app-region-no-drag inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    isLeft ? 'h-8 w-8 rounded-md' : 'h-12 w-11',
  );
  const containerClassName = isLeft
    ? 'app-region-no-drag mr-1 flex h-8 shrink-0 items-center'
    : 'app-region-no-drag ml-1 flex h-12 shrink-0 items-center';

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
          'hover:bg-[var(--status-error-background)] hover:text-[var(--status-error-foreground)]',
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
    <div className={containerClassName} aria-label={t('header.windowControls.groupAria')}>
      {order.map(renderControl)}
    </div>
  );
});
