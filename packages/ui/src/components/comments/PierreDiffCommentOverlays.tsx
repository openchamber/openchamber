import React from 'react';
import { createPortal } from 'react-dom';
import type { SelectedLineRange } from '@pierre/diffs';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput, type InlineCommentInputProps } from './InlineCommentInput';
import { toPierreAnnotationId, type ReviewLineItem } from './PierreDiffCommentUtils';
import { ReviewDraftCard, ReviewThreadCard } from '@/components/review/ReviewCards';
import type { ChangeRequestReview } from '@/components/review/useChangeRequestReview';
import type { ReviewCommentExcerpt } from '@/lib/api/types';

interface PierreDiffCommentOverlaysProps {
  diffRootRef: React.RefObject<HTMLDivElement | null>;
  drafts: InlineCommentDraft[];
  selection: SelectedLineRange | null;
  editingDraftId: string | null;
  commentText: string;
  onTextChange: (text: string) => void;
  fileLabel: string;
  onSave: (text: string, range?: SelectedLineRange) => void;
  onCancel: () => void;
  onEdit: (draft: InlineCommentDraft) => void;
  onDelete: (draft: InlineCommentDraft) => void;
  /** Present on a change request's diff on a host that takes review comments. */
  review: ChangeRequestReview | null;
  reviewItems: readonly ReviewLineItem[];
  reviewField: InlineCommentInputProps['review'];
  excerptOf: (item: ReviewLineItem) => ReviewCommentExcerpt | null;
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
    onTextChange,
    fileLabel,
    onSave,
    onCancel,
    onEdit,
    onDelete,
    review,
    reviewItems,
    reviewField,
    excerptOf,
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
    for (const item of reviewItems) ids.push(toPierreAnnotationId({ type: 'review', id: item.id }));
    return ids;
  }, [drafts, editingDraftId, reviewItems, selectionAnnotationId]);

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

  // The comment band takes the fill of the selected rows it comments on, which
  // depends on the row type (an added row mixes the addition tint in). The
  // computed selected-line variable leaves out the hover tint the "+" click
  // leaves on the row.
  const resolveSelectedLineColor = (): string | undefined => {
    const shadowRoot = diffRootRef.current?.querySelector('diffs-container')?.shadowRoot;
    const line = shadowRoot ? Array.from(shadowRoot.querySelectorAll('[data-line][data-selected-line]')).at(-1) : undefined;
    if (!line) return undefined;
    return getComputedStyle(line).getPropertyValue('--diffs-computed-selected-line-bg').trim() || undefined;
  };

  void retryTick;

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
              onTextChange={onTextChange}
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
              bandColor={resolveSelectedLineColor()}
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
            forAgent={review !== null}
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
            onTextChange={onTextChange}
            fileLabel={fileLabel}
            lineRange={selection}
            isEditing={false}
            onSave={onSave}
            onCancel={onCancel}
            maxWidth={targetMaxWidth}
            bandColor={resolveSelectedLineColor()}
            review={reviewField}
          />,
          target,
          selectionAnnotationId
        );
      })()}

      {review ? reviewItems.map((item) => {
        const id = toPierreAnnotationId({ type: 'review', id: item.id });
        const target = resolveTarget(id);
        if (!target) return null;
        const maxWidth = resolveTargetMaxWidth(target);
        return createPortal(
          <div className="px-3 py-1.5">
            {item.kind === 'draft'
              ? <ReviewDraftCard comment={item.comment} review={review} excerpt={excerptOf(item)} fileLabel={fileLabel} maxWidth={maxWidth} />
              : <ReviewThreadCard thread={item.thread} review={review} excerpt={excerptOf(item)} maxWidth={maxWidth} />}
          </div>,
          target,
          id,
        );
      }) : null}
    </>
  );
}
