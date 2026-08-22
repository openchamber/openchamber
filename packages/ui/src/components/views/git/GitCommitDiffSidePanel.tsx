import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { GitCommitDiffPreview } from './GitCommitDiffPreview';
import type { GitCommitDetailsController } from './gitCommitDetailsController';

const COMMIT_DIFF_MIN_WIDTH = 320;
const COMMIT_DIFF_MAX_WIDTH = 900;

interface GitCommitDiffSidePanelProps {
  controller: GitCommitDetailsController;
  width: number;
  onWidthChange: (width: number) => void;
}

export const GitCommitDiffSidePanel: React.FC<GitCommitDiffSidePanelProps> = ({ controller, width, onWidthChange }) => {
  const { t } = useI18n();
  const subscribe = React.useCallback((listener: () => void) => controller.subscribePreview(listener), [controller]);
  const getSnapshot = React.useCallback(() => controller.getPreviewSnapshot(), [controller]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  const clampWidth = React.useCallback(
    (value: number) => Math.min(COMMIT_DIFF_MAX_WIDTH, Math.max(COMMIT_DIFF_MIN_WIDTH, Math.round(value))),
    [],
  );

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    panel.style.width = `${nextWidth}px`;
    panel.style.setProperty('--oc-commit-diff-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    // The panel sits to the left of the handle, so dragging the handle right
    // (away from the panel) widens it.
    const delta = event.clientX - startXRef.current;
    const nextWidth = clampWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    onWidthChange(finalWidth);
  };

  if (snapshot.status === 'idle') {
    return null;
  }

  const appliedWidth = isResizing ? (liveWidthRef.current ?? width) : width;

  return (
    <div
      ref={panelRef}
      data-git-commit-diff-side-panel="true"
      className="relative h-full shrink-0 overflow-hidden border-r border-border bg-background"
      style={{
        width: `${appliedWidth}px`,
        // SAFETY: CSS custom properties (--*) are valid inline style keys and must be set via string keys
        ['--oc-commit-diff-width' as string]: `${appliedWidth}px`,
      }}
    >
      <div
        className={cn(
          'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
          isResizing && 'bg-[var(--interactive-border)]',
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('gitView.preview.resizeAria')}
      />
      <div className="h-full" style={{ width: 'var(--oc-commit-diff-width)' }}>
        <GitCommitDiffPreview
          controller={controller}
          closeMode="close"
          autoFocusCloseButton={false}
          announceOverlayOpen={false}
        />
      </div>
    </div>
  );
};
