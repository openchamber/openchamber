import type { AnnotationSide, DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { ReviewDraftComment, ReviewThread } from '@/lib/source-control/types';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

export type PierreAnnotationData =
  | { type: 'saved' | 'edit'; draft: InlineCommentDraft }
  | { type: 'new'; selection: SelectedLineRange }
  | { type: 'review'; id: string };

export const toPierreAnnotationId = (meta: PierreAnnotationData): string => {
  if (meta.type === 'review') return `review-${meta.id}`;
  if (meta.type === 'new') {
    const start = Math.min(meta.selection.start, meta.selection.end);
    const end = Math.max(meta.selection.start, meta.selection.end);
    const side = meta.selection.side ?? 'additions';
    return `new-comment-${side}-${start}-${end}`;
  }

  return `draft-${meta.draft.id}`;
};

interface BuildPierreLineAnnotationsOptions {
  drafts: InlineCommentDraft[];
  editingDraftId: string | null;
  /** The change request review's comments and threads on this file's lines. */
  reviewItems?: readonly ReviewLineItem[];
}

/** One card of a change request's review, under the last line it sits on. */
export type ReviewLineItem = { id: string; lineNumber: number; side: AnnotationSide } & (
  | { kind: 'draft'; comment: ReviewDraftComment }
  | { kind: 'thread'; thread: ReviewThread }
);

/**
 * The open comment field's annotation. It goes last in the list: Pierre keys
 * its annotations by index, so one that comes and goes in the middle would
 * rebuild every annotation after it.
 */
export const buildPierreSelectionAnnotation = (
  selection: SelectedLineRange | null,
  editingDraftId: string | null,
): DiffLineAnnotation<PierreAnnotationData> | null => (selection && !editingDraftId ? {
  lineNumber: Math.max(selection.start, selection.end),
  side: selection.side ?? 'additions',
  metadata: { type: 'new', selection },
} : null);

export const buildPierreLineAnnotations = (
  options: BuildPierreLineAnnotationsOptions
): DiffLineAnnotation<PierreAnnotationData>[] => {
  const { drafts, editingDraftId, reviewItems = [] } = options;
  const annotations: DiffLineAnnotation<PierreAnnotationData>[] = [];

  for (const draft of drafts) {
    if (!Number.isFinite(draft.endLine)) {
      continue;
    }

    const lineNumber = Math.max(1, Math.floor(draft.endLine));
    const side: AnnotationSide = draft.side === 'original' ? 'deletions' : 'additions';
    annotations.push({
      lineNumber,
      side,
      metadata: {
        type: draft.id === editingDraftId ? 'edit' : 'saved',
        draft,
      },
    });
  }

  for (const item of reviewItems) {
    annotations.push({ lineNumber: item.lineNumber, side: item.side, metadata: { type: 'review', id: item.id } });
  }

  return annotations;
};
