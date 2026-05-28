import React from 'react';
import { createPortal } from 'react-dom';
import type { SelectedLineRange } from '@pierre/diffs';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput } from './InlineCommentInput';
import { toPierreAnnotationId } from './PierreDiffCommentUtils';
import { findRevertHunkActionForSelection, type RevertHunkAction } from '@/lib/gitDiffHunks';

interface PierreDiffCommentOverlaysProps {
  diffRootRef: React.RefObject<HTMLDivElement | null>;
  drafts: InlineCommentDraft[];
  selection: SelectedLineRange | null;
  editingDraftId: string | null;
  commentText: string;
  fileLabel: string;
  onSave: (text: string, range?: SelectedLineRange) => void;
  onCancel: () => void;
  onEdit: (draft: InlineCommentDraft) => void;
  onDelete: (draft: InlineCommentDraft) => void;
  hunkActions?: RevertHunkAction[];
  onRevertHunk?: (action: RevertHunkAction) => Promise<void> | void;
}

function parseCssWidth(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (trimmed.endsWith('px')) {
    const parsed = Number.parseFloat(trimmed.slice(0, -2));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function clampMaxWidth(value: number | null | undefined): number | undefined {
  if (!value || value <= 0) return undefined;
  return Math.max(200, Math.floor(value));
}

export function PierreDiffCommentOverlays(props: PierreDiffCommentOverlaysProps) {
  const {
    diffRootRef,
    drafts,
    selection,
    editingDraftId,
    commentText,
    fileLabel,
    onSave,
    onCancel,
    onEdit,
    onDelete,
    hunkActions = [],
    onRevertHunk,
  } = props;

  const [retryTick, setRetryTick] = React.useState(0);
  const [fallbackMaxWidth, setFallbackMaxWidth] = React.useState<number | null>(null);

  const selectionAnnotationId = React.useMemo(() => {
    if (!selection || editingDraftId) return null;
    return toPierreAnnotationId({ type: 'new', selection });
  }, [editingDraftId, selection]);

  const expectedTargetIds = React.useMemo(() => {
    const ids = drafts.map((draft) => toPierreAnnotationId({ type: draft.id === editingDraftId ? 'edit' : 'saved', draft }));
    if (selectionAnnotationId) {
      ids.push(selectionAnnotationId);
    }
    return ids;
  }, [drafts, editingDraftId, selectionAnnotationId]);

  const resolveTarget = React.useCallback((annotationId: string): HTMLElement | null => {
    const wrapper = diffRootRef.current;
    if (!wrapper) return null;

    const host = wrapper.querySelector('diffs-container');
    if (!(host instanceof HTMLElement)) return null;

    const lightDomTarget = host.querySelector(`[data-annotation-id="${annotationId}"]`);
    if (lightDomTarget instanceof HTMLElement) {
      return lightDomTarget;
    }

    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) return null;

    return shadowRoot.querySelector(`[data-annotation-id="${annotationId}"]`) as HTMLElement | null;
  }, [diffRootRef]);

  React.useEffect(() => {
    if (expectedTargetIds.length === 0) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 12;

    const checkTargets = () => {
      if (cancelled) return;
      const allResolved = expectedTargetIds.every((id) => Boolean(resolveTarget(id)));
      if (allResolved || attempts >= maxAttempts) {
        return;
      }
      attempts += 1;
      requestAnimationFrame(() => {
        if (cancelled) return;
        setRetryTick((tick) => tick + 1);
        checkTargets();
      });
    };

    checkTargets();
    return () => {
      cancelled = true;
    };
  }, [expectedTargetIds, resolveTarget]);

  React.useEffect(() => {
    const root = diffRootRef.current;
    if (!root) return;

    const computeMaxWidth = () => {
      const styles = getComputedStyle(root);
      const cssWidth = parseCssWidth(styles.getPropertyValue('--oc-context-panel-width'));
      const rootRect = root.getBoundingClientRect();
      const measured = cssWidth ?? rootRect.width;
      setFallbackMaxWidth(measured > 0 ? measured : null);
    };

    computeMaxWidth();

    const observer = new ResizeObserver(() => {
      computeMaxWidth();
    });
    observer.observe(root);

    window.addEventListener('resize', computeMaxWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', computeMaxWidth);
    };
  }, [diffRootRef]);

  const resolveTargetMaxWidth = React.useCallback((target: HTMLElement): number | undefined => {
    const root = diffRootRef.current;
    const rootRect = root?.getBoundingClientRect();

    const annotationContent = target.closest('[data-annotation-content]');
    const contentRect = annotationContent instanceof HTMLElement
      ? annotationContent.getBoundingClientRect()
      : target.getBoundingClientRect();

    const candidates = [contentRect.width];
    if (rootRect) {
      candidates.push(rootRect.right - contentRect.left);
    }

    const positiveCandidates = candidates.filter((value) => Number.isFinite(value) && value > 0);
    if (positiveCandidates.length > 0) {
      return clampMaxWidth(Math.min(...positiveCandidates));
    }

    return clampMaxWidth(fallbackMaxWidth);
  }, [diffRootRef, fallbackMaxWidth]);

  void retryTick;

  const selectedHunkAction = React.useMemo(
    () => findRevertHunkActionForSelection(hunkActions, selection),
    [hunkActions, selection]
  );

  return (
    <>
      {drafts.map((draft) => {
        const id = toPierreAnnotationId({ type: draft.id === editingDraftId ? 'edit' : 'saved', draft });
        const target = resolveTarget(id);
        if (!target) return null;
        const targetMaxWidth = resolveTargetMaxWidth(target);

        if (draft.id === editingDraftId) {
          return createPortal(
            <InlineCommentInput
              initialText={commentText}
              fileLabel={fileLabel}
              lineRange={{
                start: draft.startLine,
                end: draft.endLine,
                side: draft.side === 'original' ? 'deletions' : 'additions',
              }}
              isEditing={true}
              onSave={onSave}
              onCancel={onCancel}
              maxWidth={targetMaxWidth}
            />,
            target,
            `draft-edit-${draft.id}`
          );
        }

        return createPortal(
          <InlineCommentCard
            draft={draft}
            onEdit={() => onEdit(draft)}
            onDelete={() => onDelete(draft)}
            maxWidth={targetMaxWidth}
          />,
          target,
          `draft-card-${draft.id}`
        );
      })}

      {selection && !editingDraftId && selectionAnnotationId && (() => {
        const target = resolveTarget(selectionAnnotationId);
        if (!target) return null;
        const targetMaxWidth = resolveTargetMaxWidth(target);

        return createPortal(
          <InlineCommentInput
            initialText={commentText}
            fileLabel={fileLabel}
            lineRange={selection}
            isEditing={false}
            onSave={onSave}
            onCancel={onCancel}
            maxWidth={targetMaxWidth}
            canRevertHunk={Boolean(selectedHunkAction && onRevertHunk)}
            onRevertHunk={selectedHunkAction && onRevertHunk ? () => onRevertHunk(selectedHunkAction) : undefined}
          />,
          target,
          selectionAnnotationId
        );
      })()}
    </>
  );
}
