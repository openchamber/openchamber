import React from 'react';
import { useDroppable } from '@dnd-kit/core';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore, type ContextPanelTab } from '@/stores/useUIStore';
import { ContextTileBody } from '../ContextPanel';
import { buildContextTabItems } from '../contextPanelShared';
import { SplitAnchors } from './SplitAnchors';
import { isSoleTileSourceRegion } from './tileGroupIds';
import { useTileDragState } from './tileDragContext';
import type { TabGroupLeaf } from './splitTree';

type TabGroupRegionProps = {
  group: TabGroupLeaf;
  tabsById: Map<string, ContextPanelTab>;
  directoryKey: string;
  effectiveDirectory: string;
  visibleTileIds?: ReadonlySet<string>;
  headerAccessory?: React.ReactNode;
  tiled?: boolean;
  isFocused?: boolean;
  onChatSlotChange?: (groupID: string, node: HTMLDivElement | null) => void;
};

// One tiled region: its own tab strip (group.tileIds) over the shared ContextTileBody.
// T8 owns per-tile visibility/content-visibility; this renders read-only geometry only.
export const TabGroupRegion: React.FC<TabGroupRegionProps> = ({
  group,
  tabsById,
  directoryKey,
  effectiveDirectory,
  visibleTileIds,
  headerAccessory,
  tiled = false,
  isFocused = false,
  onChatSlotChange,
}) => {
  const { t } = useI18n();
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const setFocusedContextPanelRegion = useUIStore((state) => state.setFocusedContextPanelRegion);

  const { activeTileId } = useTileDragState();
  const isDragActive = activeTileId !== null;
  // Suppress this region's split anchors when the dragged tile is its SOLE tile:
  // dropping a lone tile on its own region's anchor is a guaranteed splitLeaf no-op,
  // and closestCenter would otherwise pick it and swallow the drag.
  const showSplitAnchors = isDragActive && !isSoleTileSourceRegion(group.tileIds, activeTileId);
  const { setNodeRef: setStripDropRef } = useDroppable({
    id: `strip:${group.id}`,
    data: { type: 'strip', groupId: group.id },
  });

  const handleFocusRegion = React.useCallback(() => {
    if (!tiled || !directoryKey) return;
    setFocusedContextPanelRegion(directoryKey, group.id);
  }, [directoryKey, group.id, setFocusedContextPanelRegion, tiled]);

  const groupTabs = React.useMemo(
    () => group.tileIds.map((id) => tabsById.get(id)).filter((tab): tab is ContextPanelTab => tab !== undefined),
    [group.tileIds, tabsById],
  );
  const activeTab = groupTabs.find((tab) => tab.id === group.activeTileId) ?? groupTabs[groupTabs.length - 1] ?? null;

  const tabItems = React.useMemo(
    () => buildContextTabItems(groupTabs, t, effectiveDirectory),
    [effectiveDirectory, groupTabs, t],
  );

  return (
    // ponytail: same-origin iframe throttling has a UA ceiling; suspend embedded timeline rendering if CPU cost becomes material.
    <div
      data-context-tile-wrapper={group.id}
      data-region-focused={tiled && isFocused ? 'true' : undefined}
      role={tiled ? 'group' : undefined}
      aria-label={tiled ? t('contextPanel.region.aria') : undefined}
      onPointerDownCapture={tiled ? handleFocusRegion : undefined}
      className={cn(
        'relative flex h-full min-h-0 flex-col bg-background',
        tiled && 'ring-inset transition-shadow',
        tiled && (isFocused
          ? 'ring-1 ring-[var(--primary-base)]/60'
          : 'ring-0 ring-transparent'),
      )}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '300px 400px' }}
    >
      <header
        ref={setStripDropRef}
        aria-label={isDragActive ? t('tiling.region.moveTarget') : undefined}
        className="flex h-10 items-stretch border-b border-transparent"
      >
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) return;
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) return;
            closeContextPanelTab(directoryKey, tabID);
          }}
          dndMode="shared"
          groupId={group.id}
          layoutMode="scrollable"
          variant="default"
        />
        {headerAccessory}
      </header>
      <div
        ref={(node) => onChatSlotChange?.(group.id, node)}
        data-chat-slot={group.id}
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <ContextTileBody
          tabs={groupTabs}
          activeTab={activeTab}
          directoryKey={directoryKey}
          effectiveDirectory={effectiveDirectory}
          visibleTileIds={visibleTileIds}
          renderChatFrames={!tiled}
        />
      </div>
      {showSplitAnchors ? <SplitAnchors groupId={group.id} /> : null}
    </div>
  );
};
