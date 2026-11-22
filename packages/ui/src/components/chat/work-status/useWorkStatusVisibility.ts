import React from 'react';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { sidebarPendingWidth } from '@/components/layout/sidebarPendingWidth';
import {
  CONTEXT_ZONE_DEFAULT_WIDTH,
  isZoneShown,
  resolveZoneActiveTab,
  showsFileTreeOnly,
  sideZoneWidth,
} from '@/lib/workspace/zones';

/**
 * The card's width at 100% interface size. The panel is not user-resizable:
 * it is an object inside the chat rather than a docked pane, so it has no
 * resizer and no persisted width.
 */
const WORK_STATUS_PANEL_BASE_WIDTH = 300;

/**
 * Widest the card grows with the interface size: the 300px card at 150%. Up to there
 * it grows with the text inside it, so it cuts no more than at 100%. The cap
 * keeps the chat from losing more: above 150% the rows' fixed parts still
 * fit, since the Context row with its switch, percentage and cost needs 432px
 * at 200% before its label is cut (measured in Chrome with the app's CSS).
 */
const WORK_STATUS_PANEL_MAX_WIDTH = 450;

const WORK_STATUS_MIN_CHAT_WIDTH = 560;

const WORK_STATUS_PANEL_GUTTER = 8 + 16;

/** The column at 100% interface size, for layouts that do not follow the interface size. */
export const WORK_STATUS_COLUMN_WIDTH = WORK_STATUS_PANEL_BASE_WIDTH + WORK_STATUS_PANEL_GUTTER;

type WorkStatusWidths = {
  /** The card. */
  panel: number;
  column: number;
  /** Row width below which the panel gives its space back to the transcript. */
  requiredRow: number;
};

/** Widths at an interface size in percent (`useUIStore` `fontSize`, 100 by default). */
export const getWorkStatusWidths = (interfaceSize: number): WorkStatusWidths => {
  const scale = interfaceSize / 100;
  const panel = Math.min(
    WORK_STATUS_PANEL_MAX_WIDTH,
    Math.max(WORK_STATUS_PANEL_BASE_WIDTH, Math.round(WORK_STATUS_PANEL_BASE_WIDTH * scale)),
  );
  const column = panel + WORK_STATUS_PANEL_GUTTER * scale;
  return { panel, column, requiredRow: column + WORK_STATUS_MIN_CHAT_WIDTH };
};

export const useWorkStatusWidths = (): WorkStatusWidths => {
  const interfaceSize = useUIStore((state) => state.fontSize);
  return React.useMemo(() => getWorkStatusWidths(interfaceSize), [interfaceSize]);
};

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
};

type Result = {
  fits: boolean;
  roomy: boolean;
  roomyBesidePanel: boolean;
  rowRef: (node: HTMLDivElement | null) => void;
  visible: boolean;
};

export const useWorkStatusVisibility = ({ isMobile, isVSCode }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  const [wideEnough, setWideEnough] = React.useState<boolean | null>(null);
  const [wideEnoughBesidePanel, setWideEnoughBesidePanel] = React.useState(false);
  const rowRef = React.useCallback((node: HTMLDivElement | null) => { setRowNode(node); }, []);

  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );

  const contextPanelOpen = useUIStore(
    React.useCallback(
      (state) => isZoneShown(
        directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined,
        state.contextSurfaceZones,
        'right',
      ),
      [directoryKey],
    ),
  );

  const contextPanelWidth = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        const tab = panel ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right') : null;
        return panel && tab ? sideZoneWidth(panel, tab, 'right', state) : CONTEXT_ZONE_DEFAULT_WIDTH;
      },
      [directoryKey],
    ),
  );
  const contextPanelExpanded = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        if (!panel?.expanded) return false;
        const tab = isZoneShown(panel, state.contextSurfaceZones, 'right')
          ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right')
          : null;
        return tab !== null && !showsFileTreeOnly(panel, tab, state);
      },
      [directoryKey],
    ),
  );

  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);

  const areaWidthRef = React.useRef<number | null>(null);
  const contextPanelWidthRef = React.useRef(contextPanelWidth);
  contextPanelWidthRef.current = contextPanelWidth;
  // The card widens with the interface size, so the width it needs does too.
  const { requiredRow } = useWorkStatusWidths();
  const applyAreaWidth = React.useCallback((measured: number) => {
    areaWidthRef.current = measured;
    const width = measured + sidebarPendingWidth();
    setWideEnough(width >= requiredRow);
    setWideEnoughBesidePanel(width >= requiredRow + contextPanelWidthRef.current);
  }, [requiredRow]);
  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;

    const measured = rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    applyAreaWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyAreaWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [applyAreaWidth, rowNode]);

  const sidebarOpen = useUIStore((state) => panelEnabled && state.isSidebarOpen);
  React.useLayoutEffect(() => {
    if (areaWidthRef.current !== null) applyAreaWidth(areaWidthRef.current);
  }, [applyAreaWidth, contextPanelWidth, sidebarOpen]);

  const roomy = !isMobile && wideEnough === true;
  const roomyBesidePanel = roomy && wideEnoughBesidePanel && !contextPanelExpanded;
  const fits = contextPanelOpen && !isVSCode ? roomyBesidePanel : roomy;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits, roomy, roomyBesidePanel };
};
