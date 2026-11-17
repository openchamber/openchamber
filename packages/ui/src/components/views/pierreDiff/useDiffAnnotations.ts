import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import {
  buildPierreLineAnnotations,
  buildPierreSelectionAnnotation,
  type ReviewLineItem,
  toPierreAnnotationId,
} from '@/components/comments';
import type { PatchHunkAnchor } from '@/lib/diff/patchFileDiff';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { getTrailingExpandAnnotation } from './contextExpansion';
import type { DiffAnnotation } from './types';

interface AnnotationRendererInput {
  diffContainerRef: RefObject<HTMLDivElement | null>;
  requestTrailingExpansionRef: RefObject<() => void>;
  showLinesBelowLabel: string;
}

export const useAnnotationRenderer = ({
  diffContainerRef,
  requestTrailingExpansionRef,
  showLinesBelowLabel,
}: AnnotationRendererInput) => {
  const commentHostsRef = useRef(new Map<string, HTMLDivElement>());
  const typingFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const holdTypingField = useCallback(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement && diffContainerRef.current?.contains(focused)) typingFieldRef.current = focused;
  }, [diffContainerRef]);
  useEffect(() => {
    const release = (event: Event) => {
      if (event.target !== typingFieldRef.current) typingFieldRef.current = null;
    };
    document.addEventListener('focusin', release, true);
    document.addEventListener('pointerdown', release, true);
    return () => {
      document.removeEventListener('focusin', release, true);
      document.removeEventListener('pointerdown', release, true);
    };
  }, []);
  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<DiffAnnotation>) => {
    const div = document.createElement('div');
    div.style.position = 'relative';

    if (annotation.metadata.type === 'hunk-action') {
      div.dataset.hunkActionTarget = String(annotation.metadata.index);
      div.style.height = '0px';
      return div;
    }

    if (annotation.metadata.type === 'trailing-expand') {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ocTrailingExpand = '';
      button.textContent = showLinesBelowLabel;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        requestTrailingExpansionRef.current();
      });
      div.append(button);
      return div;
    }

    // external: https://github.com/pierrecomputer/pierre Annotation index changes rebuild wrappers; stable portal nodes preserve mounted cards and layout height.
    const id = toPierreAnnotationId(annotation.metadata);
    const existing = commentHostsRef.current.get(id);
    if (existing) return existing;
    div.dataset.annotationId = id;
    div.dataset.annotationSide = annotation.side;
    div.dataset.annotationLine = String(annotation.lineNumber);
    commentHostsRef.current.set(id, div);
    return div;
  }, [requestTrailingExpansionRef, showLinesBelowLabel]);

  return { commentHostsRef, typingFieldRef, holdTypingField, renderAnnotation };
};

interface LineAnnotationsInput {
  enableComments: boolean;
  fileDrafts: InlineCommentDraft[];
  editingDraftId: string | null;
  reviewItems: ReviewLineItem[];
  hunkAnchors: readonly PatchHunkAnchor[];
  expandOnDemand: boolean;
  fileDiff: FileDiffMetadata | undefined;
  selection: SelectedLineRange | null;
  commentHostsRef: RefObject<Map<string, HTMLDivElement>>;
}

export const useLineAnnotations = ({
  enableComments,
  fileDrafts,
  editingDraftId,
  reviewItems,
  hunkAnchors,
  expandOnDemand,
  fileDiff,
  selection,
  commentHostsRef,
}: LineAnnotationsInput) => {
  const lineAnnotations = useMemo<DiffLineAnnotation<DiffAnnotation>[]>(() => {
    const annotations: DiffLineAnnotation<DiffAnnotation>[] = enableComments ? buildPierreLineAnnotations({
      drafts: fileDrafts,
      editingDraftId,
      reviewItems,
    }) : [];
    for (const anchor of hunkAnchors) {
      annotations.push({ side: anchor.side, lineNumber: anchor.lineNumber, metadata: { type: 'hunk-action', index: anchor.index } });
    }
    const trailingExpand = expandOnDemand && fileDiff ? getTrailingExpandAnnotation(fileDiff) : null;
    if (trailingExpand) annotations.push(trailingExpand);
    const selectionAnnotation = enableComments ? buildPierreSelectionAnnotation(selection, editingDraftId) : null;
    if (selectionAnnotation) annotations.push(selectionAnnotation);
    return annotations;
  }, [editingDraftId, enableComments, expandOnDemand, fileDiff, fileDrafts, hunkAnchors, reviewItems, selection]);

  const lineAnnotationsRef = useRef(lineAnnotations);

  useEffect(() => {
    lineAnnotationsRef.current = lineAnnotations;
    const current = new Set(lineAnnotations.flatMap(({ metadata }) => (
      metadata.type === 'hunk-action' || metadata.type === 'trailing-expand' ? [] : [toPierreAnnotationId(metadata)]
    )));
    for (const id of commentHostsRef.current.keys()) {
      if (!current.has(id)) commentHostsRef.current.delete(id);
    }
  }, [commentHostsRef, lineAnnotations]);

  return { lineAnnotations, lineAnnotationsRef };
};
