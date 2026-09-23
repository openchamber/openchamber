import React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { cn } from '@/lib/utils';
import { followWorkspaceLayoutOfOtherWindows, useUIStore } from '@/stores/useUIStore';
import {
  mainChatZone,
  WORKSPACE_CENTER_MIN_HEIGHT,
  WORKSPACE_CENTER_MIN_WIDTH,
  WORKSPACE_ZONE_MIN_SIZE,
} from '@/lib/workspace/layout';
import { ContextPanel } from '../ContextPanel';
import { FilesEditorHost, FilesEditorProvider } from './FilesEditorHost';
import { filesEditorMounted } from './filesSurfaceTabs';
import { isWorkspaceZoneVisible, useWorkspaceZones } from './useWorkspaceZones';
import { WorkspaceResizeHandle } from './WorkspaceResizeHandle';
import { useWorkspaceOpeners } from './useWorkspaceOpeners';

const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const renderFilesEditor = (visible: boolean) => <FilesView mode="editor-only" visible={visible} />;

type Props = {
  /** The session conversation, drawn in whichever zone the chat surface is docked in. */
  mainChat: React.ReactNode;
  /**
   * Full-page surfaces (Archive, Scheduled tasks, Worktrees, the multi-run
   * launcher, extension pages) that cover the center while open.
   */
  overlays: React.ReactNode;
  /** Whether one of those pages is open, which hides the center's own content. */
  isSurfacePageOpen: boolean;
};

type Size = { width: number; height: number };

/** Tracks an element's size; null until the first measurement. */
const useElementSize = (): [(node: HTMLElement | null) => void, Size | null] => {
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const [size, setSize] = React.useState<Size | null>(null);
  React.useLayoutEffect(() => {
    if (!node || !('ResizeObserver' in globalThis)) return undefined;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size];
};

/**
 * Modular Workspace V1: four fixed zones, composed here.
 *
 * Left, center and right share a row; the bottom zone spans beneath them. Each
 * zone draws its own surfaces through `ContextPanel`, so two of them can show
 * different surfaces at the same time. A zone with nothing docked in it
 * renders nothing. A collapsed zone stays mounted at zero size, so its panes
 * keep their state (a loaded page, the editor, a terminal) the way the single
 * context panel always did while closed.
 *
 * The right zone keeps sizing itself: its width is per-surface and animated,
 * behavior that predates the zones and that users have stored values for. It
 * measures against the center it shares a container with, not the whole row.
 * The left and bottom zones take their size from `workspaceZoneSizes`, capped
 * so the center keeps its usable minimum.
 */
export const WorkspaceLayout: React.FC<Props> = ({ mainChat, overlays, isSurfacePageOpen }) => {
  const view = useWorkspaceZones();
  useWorkspaceOpeners();
  // The layout is shared by every window; adopt changes made in the others.
  React.useEffect(() => followWorkspaceLayoutOfOtherWindows(), []);
  const zoneSizes = useUIStore((state) => state.workspaceZoneSizes);
  const setWorkspaceZoneSize = useUIStore((state) => state.setWorkspaceZoneSize);

  const [outerRef, outerSize] = useElementSize();
  const [centerRef, centerSize] = useElementSize();

  const chatZone = mainChatZone(view.layout);
  const leftMounted = view.occupied.has('left');
  const rightMounted = view.occupied.has('right');
  const bottomMounted = view.occupied.has('bottom');
  const leftOpen = isWorkspaceZoneVisible(view, 'left');
  const rightOpen = isWorkspaceZoneVisible(view, 'right');
  const bottomOpen = isWorkspaceZoneVisible(view, 'bottom');
  const showsCenter = view.occupied.has('center');

  // The size actually drawn is the stored preference, reduced when the window
  // is too small to give it and still leave the center (and a right zone at
  // its minimum) usable. The preference itself is kept for larger windows.
  const leftLimit = outerSize === null
    ? null
    : outerSize.width - WORKSPACE_CENTER_MIN_WIDTH - (rightOpen ? WORKSPACE_ZONE_MIN_SIZE.right : 0);
  const leftWidth = leftLimit === null
    ? zoneSizes.left
    : Math.max(WORKSPACE_ZONE_MIN_SIZE.left, Math.min(zoneSizes.left, leftLimit));
  const bottomLimit = outerSize === null ? null : outerSize.height - WORKSPACE_CENTER_MIN_HEIGHT;
  const bottomHeight = bottomLimit === null
    ? zoneSizes.bottom
    : Math.max(WORKSPACE_ZONE_MIN_SIZE.bottom, Math.min(zoneSizes.bottom, bottomLimit));

  // A drag can only take the center's spare room.
  const maxLeftWidth = centerSize === null ? null : leftWidth + (centerSize.width - WORKSPACE_CENTER_MIN_WIDTH);

  const renderZone = (zone: 'left' | 'center' | 'bottom') => (
    <ErrorBoundary>
      <ContextPanel zone={zone} mainChat={chatZone === zone ? mainChat : undefined} />
    </ErrorBoundary>
  );

  return (
    <FilesEditorProvider>
      <div ref={outerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Drawn once for every zone, so moving Files keeps its editor. */}
        <FilesEditorHost mounted={filesEditorMounted(view.panel)} renderEditor={renderFilesEditor} />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
          {leftMounted ? (
            <>
              {/* Zero width while collapsed; the inner box keeps its size so the
                  panes do not reflow and come back exactly as they were. */}
              <div className="relative h-full shrink-0 overflow-hidden bg-background" style={{ width: leftOpen ? leftWidth : 0 }}>
                <div className="absolute inset-y-0 left-0 flex flex-col" style={{ width: leftWidth }}>
                  {renderZone('left')}
                </div>
              </div>
              {leftOpen ? (
                <WorkspaceResizeHandle
                  zone="left"
                  size={leftWidth}
                  maxSize={maxLeftWidth}
                  onResize={(size) => setWorkspaceZoneSize('left', size)}
                />
              ) : null}
            </>
          ) : null}

          {/* The center and the right zone share this box: the right zone sizes
              itself against it, and the work-status panel measures it, so both
              see the space next to the left zone rather than the whole row. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
            <main ref={centerRef} className="relative flex min-w-0 flex-1 overflow-hidden bg-background" data-page-scroll-lock="true">
              {showsCenter ? (
                <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                  {renderZone('center')}
                </div>
              ) : null}
              {overlays}
            </main>

            {/* Self-sizing and self-collapsing: the right panel owns its width,
                its closed state, its expand-over-the-center state and its own
                resize handle. */}
            {rightMounted ? (
              <ErrorBoundary>
                <ContextPanel zone="right" mainChat={chatZone === 'right' ? mainChat : undefined} />
              </ErrorBoundary>
            ) : null}
          </div>
        </div>

        {bottomMounted ? (
          <>
            {bottomOpen ? (
              <WorkspaceResizeHandle
                zone="bottom"
                size={bottomHeight}
                maxSize={bottomLimit}
                onResize={(size) => setWorkspaceZoneSize('bottom', size)}
              />
            ) : null}
            <div className="relative w-full shrink-0 overflow-hidden bg-background" style={{ height: bottomOpen ? bottomHeight : 0 }}>
              <div className="absolute inset-x-0 top-0 flex flex-col" style={{ height: bottomHeight }}>
                {renderZone('bottom')}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </FilesEditorProvider>
  );
};
