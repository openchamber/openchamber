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

export const WORK_STATUS_PANEL_WIDTH = 300;

const WORK_STATUS_MIN_CHAT_WIDTH = 560;

const WORK_STATUS_PANEL_GUTTER = 8 + 16;

export const WORK_STATUS_COLUMN_WIDTH = WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER;

export const WORK_STATUS_REQUIRED_ROW_WIDTH = WORK_STATUS_COLUMN_WIDTH + WORK_STATUS_MIN_CHAT_WIDTH;

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
  const applyAreaWidth = React.useCallback((measured: number) => {
    areaWidthRef.current = measured;
    const width = measured + sidebarPendingWidth();
    setWideEnough(width >= WORK_STATUS_REQUIRED_ROW_WIDTH);
    setWideEnoughBesidePanel(width >= WORK_STATUS_REQUIRED_ROW_WIDTH + contextPanelWidthRef.current);
  }, []);

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
