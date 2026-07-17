import React from 'react';
import { Allotment } from 'allotment';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore, type ContextPanelTab } from '@/stores/useUIStore';
import {
  CONTEXT_PANEL_DEFAULT_WIDTH,
  CONTEXT_PANEL_MIN_WIDTH,
  CONTEXT_TILE_MIN_HEIGHT,
  CONTEXT_TILE_MIN_WIDTH,
  clampWidth,
  clampWidthToAvailableSpace,
  normalizeDirectoryKey,
} from '../contextPanelShared';
import { TabGroupRegion } from './TabGroupRegion';
import { TileDragProvider } from './useTileDrag';
import { branchToDefaultSizes } from './layoutToAllotment';
import type { SplitNode } from './splitTree';
import { computeVisibleTileIds } from './visibleTileIds';
import {
  EmbeddedSessionFrames,
  type EmbeddedSessionFramesHandle,
} from '../EmbeddedSessionFrames';
import { mapTileIdsToGroupIds } from './tileGroupIds';

// Tiled Side Panel shell (Wave-3 T7). Renders layout.root recursively into nested
// allotment panes: SplitBranch -> <Allotment>, TabGroupLeaf -> <TabGroupRegion>.
// A single-group layout renders with no splitter, pixel-identical to ContextPanel.
// The panel shell (resize/width/expand/close) mirrors ContextPanel intentionally;
// T8/T9/T10 evolve this component while ContextPanel stays the legacy fallback.
export const TiledPanel: React.FC = () => {
  const { t } = useI18n();
  useThemeSystem();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setContextPanelLayoutSizes = useUIStore((state) => state.setContextPanelLayoutSizes);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const layout = panelState?.layout ?? null;
  const tabsById = React.useMemo(() => {
    const map = new Map<string, ContextPanelTab>();
    for (const tab of tabs) map.set(tab.id, tab);
    return map;
  }, [tabs]);

  const isOpen = Boolean(panelState?.isOpen && layout && tabs.length > 0);
  const visibleTileIds = React.useMemo(() => computeVisibleTileIds(layout, isOpen), [isOpen, layout]);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);

  const [isResizing, setIsResizing] = React.useState(false);
  const [suppressWidthTransition, setSuppressWidthTransition] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);
  const previousIsOpenRef = React.useRef(isOpen);
  const suppressWidthTransitionFrameRef = React.useRef<number | null>(null);
  const chatSlotElementsRef = React.useRef<Map<string, HTMLElement>>(new Map());
  const embeddedFramesRef = React.useRef<EmbeddedSessionFramesHandle | null>(null);
  const chatTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'chat'), [tabs]);
  const tileGroupIds = React.useMemo(() => layout ? mapTileIdsToGroupIds(layout.root) : new Map<string, string>(), [layout]);

  const scheduleChatGeometrySync = React.useCallback(() => {
    embeddedFramesRef.current?.scheduleGeometrySync();
  }, []);

  const handleChatSlotChange = React.useCallback((groupID: string, node: HTMLDivElement | null) => {
    const previous = chatSlotElementsRef.current.get(groupID);
    if (previous && previous !== node) embeddedFramesRef.current?.unobserveSlot(previous);
    if (node) {
      chatSlotElementsRef.current.set(groupID, node);
      embeddedFramesRef.current?.observeSlot(node);
    } else {
      chatSlotElementsRef.current.delete(groupID);
    }
  }, []);

  const suppressWidthTransitionForFrame = React.useCallback(() => {
    setSuppressWidthTransition(true);
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
    suppressWidthTransitionFrameRef.current = window.requestAnimationFrame(() => {
      suppressWidthTransitionFrameRef.current = null;
      setSuppressWidthTransition(false);
    });
  }, []);

  React.useEffect(() => () => {
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
  }, []);

  React.useLayoutEffect(() => {
    const wasOpen = previousIsOpenRef.current;
    previousIsOpenRef.current = isOpen;

    if (!isOpen) {
      setSuppressWidthTransition(false);
      return;
    }

    if (wasOpen) {
      return;
    }

    suppressWidthTransitionForFrame();
  }, [isOpen, suppressWidthTransitionForFrame]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    panel.style.setProperty('--oc-context-panel-width', `${clampWidthToAvailableSpace(nextWidth, panel)}px`);
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore; fallback listeners still handle drag
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    applyLiveWidth(width);
    event.preventDefault();
  }, [applyLiveWidth, directoryKey, isExpanded, isOpen, width]);

  const handleResizeMove = React.useCallback((event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampWidthToAvailableSpace(startWidthRef.current + delta, panelRef.current);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
    scheduleChatGeometrySync();
  }, [applyLiveWidth, isResizing, scheduleChatGeometrySync]);

  const handleResizeEnd = React.useCallback((event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = clampWidthToAvailableSpace(resizingWidthRef.current ?? width, panelRef.current);
    suppressWidthTransitionForFrame();
    applyLiveWidth(finalWidth);
    resizingWidthRef.current = finalWidth;
    setContextPanelWidth(directoryKey, finalWidth);
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [applyLiveWidth, directoryKey, setContextPanelWidth, suppressWidthTransitionForFrame, width]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) return;
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) return;
    toggleContextPanelExpanded(directoryKey);
    scheduleChatGeometrySync();
  }, [directoryKey, scheduleChatGeometrySync, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

  const panelControls = (
    <div className="flex items-center gap-1 px-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleToggleExpanded}
        className="h-7 w-7 p-0"
        title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
      >
        {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClose}
        className="h-7 w-7 p-0"
        title={t('contextPanel.actions.closePanel')}
        aria-label={t('contextPanel.actions.closePanel')}
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const renderNode = React.useCallback((node: SplitNode, path: number[]): React.ReactNode => {
    if (node.kind === 'group') {
      return (
        <TabGroupRegion
          group={node}
          tabsById={tabsById}
          directoryKey={directoryKey}
          effectiveDirectory={effectiveDirectory}
          visibleTileIds={visibleTileIds}
          tiled
          isFocused={layout?.focusedGroupId === node.id}
          onChatSlotChange={handleChatSlotChange}
        />
      );
    }

    return (
      <Allotment
        vertical={node.direction === 'vertical'}
        defaultSizes={branchToDefaultSizes(node.sizes)}
        onChange={scheduleChatGeometrySync}
        onDragEnd={(sizes) => setContextPanelLayoutSizes(directoryKey, path, sizes)}
      >
        {node.children.map((child, index) => (
          <Allotment.Pane
            key={child.kind === 'group' ? child.id : `split-${[...path, index].join('-')}`}
            minSize={node.direction === 'vertical' ? CONTEXT_TILE_MIN_HEIGHT : CONTEXT_TILE_MIN_WIDTH}
          >
            {renderNode(child, [...path, index])}
          </Allotment.Pane>
        ))}
      </Allotment>
    );
  }, [directoryKey, effectiveDirectory, handleChatSlotChange, layout?.focusedGroupId, scheduleChatGeometrySync, setContextPanelLayoutSizes, tabsById, visibleTileIds]);

  const interior = layout
    ? (
      <TileDragProvider directoryKey={directoryKey} layout={layout}>
        {layout.root.kind === 'group'
          ? (
            <TabGroupRegion
              group={layout.root}
              tabsById={tabsById}
              directoryKey={directoryKey}
              effectiveDirectory={effectiveDirectory}
              visibleTileIds={visibleTileIds}
              headerAccessory={panelControls}
              onChatSlotChange={handleChatSlotChange}
              tiled
            />
          )
          : (
            <div className="flex h-full min-h-0 flex-col">
              <header className="flex h-10 items-stretch justify-end border-b border-transparent">
                {panelControls}
              </header>
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {renderNode(layout.root, [])}
              </div>
            </div>
          )}
      </TileDragProvider>
    )
    : null;

  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        width: 0,
        minWidth: 0,
        maxWidth: 0,
        opacity: 0,
        overflow: 'hidden',
        visibility: 'hidden',
      }
    : isExpanded
      ? {
          ['--oc-context-panel-width' as string]: '100%',
          width: '100%',
          minWidth: '100%',
          maxWidth: '100%',
        }
      : {
          width: 'min(var(--oc-context-panel-width), 100%)',
          minWidth: `min(${CONTEXT_PANEL_MIN_WIDTH}px, 100%)`,
          maxWidth: '100%',
          ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-context-panel-tiled="true"
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        !isExpanded && 'border-l border-border/40',
        isExpanded
          ? 'absolute inset-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        isResizing || !isOpen || suppressWidthTransition ? 'transition-none' : 'transition-[width] duration-200 ease-in-out'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {interior}
        {layout ? (
          <EmbeddedSessionFrames
            ref={embeddedFramesRef}
            mode="tiled"
            tabs={chatTabs}
            directoryKey={directoryKey}
            visibleTileIds={visibleTileIds}
            tileGroupIds={tileGroupIds}
            slotElements={chatSlotElementsRef}
          />
        ) : null}
      </div>
    </aside>
  );
};
