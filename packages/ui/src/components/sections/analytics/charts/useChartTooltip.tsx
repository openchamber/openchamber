import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TooltipWithBounds, defaultStyles, useTooltip } from '@visx/tooltip';

export interface TooltipDatum {
  key?: string | number;
  content: ReactNode;
}

export interface ChartTooltipApi {
  tooltipOpen: boolean;
  tooltipData: TooltipDatum | null | undefined;
  /**
   * Attach to a positioned element that wraps the chart. Used for hit-testing
   * (e.g. nearest-point lookup). The tooltip itself renders in a fixed-position
   * portal attached to `document.body`, so it is never clipped by ancestor
   * `overflow` containers (the analytics cards live inside a `ScrollableOverlay`
   * with `overflow-hidden`/`overflow-auto`) nor overlapped by sibling cards.
   */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** clientX/clientY are viewport coords; passed straight to the fixed tooltip. */
  showTooltip: (datum: TooltipDatum, clientX: number, clientY: number) => void;
  hideTooltip: () => void;
  TooltipPortal: (props: { children: ReactNode }) => ReactNode;
}

/**
 * z-index for the chart tooltip portal. App overlays top out at z-60 (mobile
 * panels); dialogs/tooltips sit at z-50. The tooltip must clear all of them so
 * it stays visible above the settings overlay that hosts the analytics page.
 */
const TOOLTIP_Z_INDEX = 70;

export function useChartTooltip(): ChartTooltipApi {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    tooltipOpen,
    tooltipData,
    tooltipLeft,
    tooltipTop,
    showTooltip: show,
    hideTooltip,
  } = useTooltip<TooltipDatum>();

  const showTooltip = (datum: TooltipDatum, clientX: number, clientY: number) => {
    // Viewport coords are used directly: the tooltip is position:fixed, so it
    // is positioned relative to the viewport (not the chart container).
    show({ tooltipData: datum, tooltipLeft: clientX, tooltipTop: clientY });
  };

  const TooltipPortal = ({ children }: { children: ReactNode }): ReactNode =>
    tooltipOpen && tooltipData && typeof document !== 'undefined'
      ? createPortal(
          <TooltipWithBounds
            left={tooltipLeft}
            top={tooltipTop}
            style={{
              ...defaultStyles,
              position: 'fixed',
              zIndex: TOOLTIP_Z_INDEX,
              backgroundColor: 'var(--popover, white)',
              color: 'var(--popover-foreground)',
              border: '1px solid var(--border)',
              borderRadius: '0.375rem',
              padding: '0.25rem 0.5rem',
              fontSize: '0.75rem',
              boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
              maxWidth: 320,
            }}
          >
            {children}
          </TooltipWithBounds>,
          document.body,
        )
      : null;

  return {
    tooltipOpen,
    tooltipData,
    containerRef,
    showTooltip,
    hideTooltip,
    TooltipPortal,
  };
}
