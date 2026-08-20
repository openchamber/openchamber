import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
  DEFAULT_GIT_REPOSITORY_PANE_STATE,
  gitRepositoryPanePreferenceKey,
} from '@/stores/useUIStore';
import { GitCommitDiffPreview } from './GitCommitDiffPreview';
import type { GitCommitDetailsController } from './gitCommitDetailsController';

const WORKSPACE_HORIZONTAL_PADDING = 16;
const PREVIEW_MIN_WIDTH = 360;
const PREVIEW_DEFAULT_WIDTH = 360;
const GRAPH_MIN_WIDTH = 320;
const PREVIEW_GAP = 8;
const PREVIEW_KEYBOARD_STEP = 24;

const clampPreviewWidth = (requestedWidth: number, usableWidth: number): number => {
  const maxPreviewWidth = Math.max(PREVIEW_MIN_WIDTH, usableWidth - PREVIEW_GAP - GRAPH_MIN_WIDTH);
  const normalized = Number.isFinite(requestedWidth) ? Math.round(requestedWidth) : PREVIEW_DEFAULT_WIDTH;
  return Math.min(maxPreviewWidth, Math.max(PREVIEW_MIN_WIDTH, normalized));
};

const hasResizeObserver = (): boolean => 'ResizeObserver' in globalThis;

const getFocusableElement = (value: EventTarget | Element | null): HTMLElement | null => {
  if (value instanceof HTMLElement) {
    return value;
  }

  return null;
};

type GitGraphWorkspaceProps = {
  directory: string;
  controller: GitCommitDetailsController;
  graph: React.ReactNode;
};

export const GitGraphWorkspace: React.FC<GitGraphWorkspaceProps> = ({ directory, controller, graph }) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const paneState = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey] ?? DEFAULT_GIT_REPOSITORY_PANE_STATE);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const [contentWidth, setContentWidth] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const previousSelectionActiveRef = React.useRef(false);
  const focusReturnTargetRef = React.useRef<HTMLElement | null>(null);
  const dragStateRef = React.useRef<{ startX: number; startWidth: number } | null>(null);

  const subscribe = React.useCallback((listener: () => void) => controller.subscribePreview(listener), [controller]);
  const getSnapshot = React.useCallback(() => controller.getPreviewSnapshot(), [controller]);
  const previewSnapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const hasSelection = previewSnapshot.status !== 'idle';

  React.useLayoutEffect(() => {
    if (!rootRef.current || !hasResizeObserver()) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setContentWidth(Math.max(0, Math.round(entry.contentRect.width) - (WORKSPACE_HORIZONTAL_PADDING * 2)));
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  const layoutMode: 'full' | 'split' | 'overlay' = !hasSelection
    ? 'full'
    : contentWidth >= PREVIEW_MIN_WIDTH + PREVIEW_GAP + GRAPH_MIN_WIDTH
      ? 'split'
      : 'overlay';

  const effectivePreviewWidth = layoutMode === 'split'
    ? clampPreviewWidth(paneState.previewWidth, contentWidth)
    : PREVIEW_DEFAULT_WIDTH;

  const clearSelectionAndRestoreFocus = React.useCallback(() => {
    const focusTarget = rootRef.current?.querySelector<HTMLElement>('[data-graph-focus-target]') ?? focusReturnTargetRef.current;
    controller.clearSelection();
    focusTarget?.focus();
  }, [controller]);

  React.useEffect(() => {
    if (layoutMode === 'split' && paneState.previewWidth !== effectivePreviewWidth) {
      setPaneState(directory, { previewWidth: effectivePreviewWidth });
    }
  }, [directory, effectivePreviewWidth, layoutMode, paneState.previewWidth, setPaneState]);

  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current || layoutMode !== 'split') {
        return;
      }

      const delta = dragStateRef.current.startX - event.clientX;
      setPaneState(directory, {
        previewWidth: clampPreviewWidth(dragStateRef.current.startWidth + delta, contentWidth),
      });
    };

    const handlePointerEnd = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [contentWidth, directory, layoutMode, setPaneState]);

  React.useLayoutEffect(() => {
    if (!hasSelection) {
      focusReturnTargetRef.current = getFocusableElement(document.activeElement);
    }

    if (!hasSelection && previousSelectionActiveRef.current) {
      focusReturnTargetRef.current?.focus();
    }

    previousSelectionActiveRef.current = hasSelection;
  }, [hasSelection]);

  React.useEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (hasSelection) {
        return;
      }
      focusReturnTargetRef.current = getFocusableElement(event.target);
    };

    node.addEventListener('focusin', handleFocusIn);
    return () => node.removeEventListener('focusin', handleFocusIn);
  }, [hasSelection]);

  React.useEffect(() => {
    const node = rootRef.current;
    if (!node || layoutMode !== 'overlay') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearSelectionAndRestoreFocus();
    };

    node.addEventListener('keydown', handleKeyDown, true);
    return () => node.removeEventListener('keydown', handleKeyDown, true);
  }, [clearSelectionAndRestoreFocus, layoutMode]);

  const previewController = React.useMemo<GitCommitDetailsController>(() => ({
    ...controller,
    clearSelection: clearSelectionAndRestoreFocus,
  }), [clearSelectionAndRestoreFocus, controller]);

  const previewPane = hasSelection ? (
    <GitCommitDiffPreview
      controller={previewController}
      closeMode={layoutMode === 'overlay' ? 'back' : 'close'}
      autoFocusCloseButton={layoutMode === 'overlay'}
      announceOverlayOpen={layoutMode === 'overlay'}
    />
  ) : null;

  return (
    <section
      id="git-graph-workspace"
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col bg-[var(--surface-background)] px-4 py-3"
      data-git-graph-workspace-layout={layoutMode}
    >
      {layoutMode === 'split' ? (
        <div className="flex min-h-0 min-w-0 flex-1 items-stretch">
          <div className="min-h-0 min-w-0 flex-1">{graph}</div>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('gitView.preview.resizeAria')}
            data-git-graph-workspace-separator="true"
            className="mx-0 shrink-0 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            style={{ width: `${PREVIEW_GAP}px` }}
            onPointerDown={(event) => {
              dragStateRef.current = { startX: event.clientX, startWidth: paneState.previewWidth };
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setPaneState(directory, { previewWidth: clampPreviewWidth(paneState.previewWidth - PREVIEW_KEYBOARD_STEP, contentWidth) });
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setPaneState(directory, { previewWidth: clampPreviewWidth(paneState.previewWidth + PREVIEW_KEYBOARD_STEP, contentWidth) });
              }
            }}
          />
          <div className="min-h-0 shrink-0" style={{ width: `${effectivePreviewWidth}px` }}>
            {previewPane}
          </div>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1">{graph}</div>
      )}

      {layoutMode === 'overlay' ? (
        <div className="absolute inset-4 min-h-0 rounded-xl shadow-xl">
          {previewPane}
        </div>
      ) : null}
    </section>
  );
};
