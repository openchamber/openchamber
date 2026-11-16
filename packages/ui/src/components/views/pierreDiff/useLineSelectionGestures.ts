import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type {
  AnnotationSide,
  FileDiff as PierreFileDiff,
  OnDiffLineClickProps,
  SelectedLineRange,
} from '@pierre/diffs';
import { isMacOS } from '@/lib/utils';
import { findWordAtPoint } from './findHighlights';
import type { DiffAnnotation, DiffFindWordRequest } from './types';

interface LineSelectionGesturesInput {
  enableComments: boolean;
  onFindWordRequest: ((request: DiffFindWordRequest) => void) | undefined;
  diffRootRef: RefObject<HTMLDivElement | null>;
  diffContainerRef: RefObject<HTMLDivElement | null>;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
  selectionRef: RefObject<SelectedLineRange | null>;
  commentTextRef: RefObject<string>;
  editingDraftIdRef: RefObject<string | null>;
  isApplyingSelectionRef: RefObject<boolean>;
  setSelection: (range: SelectedLineRange | null) => void;
  setCommentText: (text: string) => void;
  applySelection: (range: SelectedLineRange) => void;
}

export const useLineSelectionGestures = ({
  enableComments,
  onFindWordRequest,
  diffRootRef,
  diffContainerRef,
  diffInstanceRef,
  selectionRef,
  commentTextRef,
  editingDraftIdRef,
  isApplyingSelectionRef,
  setSelection,
  setCommentText,
  applySelection,
}: LineSelectionGesturesInput) => {
  // True for the gesture that dragged across lines, so the click ending it
  // does not read as a find-word request.
  const dragSelectionRef = useRef(false);
  const onFindWordRequestRef = useRef(onFindWordRequest);

  useEffect(() => {
    onFindWordRequestRef.current = onFindWordRequest;
  }, [onFindWordRequest]);

  // Multi-line text selection over diff CONTENT highlights the same line
  // range Pierre paints for number-column selection — without opening the
  // comment editor. The "+" utility then targets the highlighted range.
  const contentSelectionRef = useRef<SelectedLineRange | null>(null);
  const contentSelectionClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enableComments) return;
    const root = diffRootRef.current;
    if (!root) return;

    const getShadowRoot = (): ShadowRoot | null => {
      const host = root.querySelector('diffs-container');
      return host instanceof HTMLElement ? host.shadowRoot : null;
    };

    const setDragAttribute = (active: boolean) => {
      const host = root.querySelector('diffs-container');
      if (!(host instanceof HTMLElement)) return;
      if (active) host.setAttribute('data-oc-comment-drag', '');
      else host.removeAttribute('data-oc-comment-drag');
    };

    const lineFromPoint = (clientX: number, clientY: number): { line: number; side: AnnotationSide; numberColumn: boolean } | null => {
      const shadowRoot = getShadowRoot();
      const element = shadowRoot?.elementFromPoint(clientX, clientY) ?? document.elementFromPoint(clientX, clientY);
      if (!(element instanceof Element)) return null;
      const numberColumn = Boolean(element.closest('[data-column-number]'));
      const row = element.closest('[data-line]');
      if (!(row instanceof HTMLElement)) return null;
      const line = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
      if (!Number.isFinite(line) || line <= 0) return null;
      const side: AnnotationSide = row.getAttribute('data-line-type') === 'change-deletion'
        || row.closest('[data-code][data-deletions]') != null
        ? 'deletions'
        : 'additions';
      return { line, side, numberColumn };
    };

    let anchor: { line: number; side: AnnotationSide } | null = null;
    let engaged = false;
    let pointerId: number | null = null;

    const highlight = (range: SelectedLineRange) => {
      contentSelectionRef.current = range;
      const instance = diffInstanceRef.current;
      if (!instance) return;
      try {
        isApplyingSelectionRef.current = true;
        instance.setSelectedLines(range);
      } catch {
        // ignore
      } finally {
        isApplyingSelectionRef.current = false;
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      dragSelectionRef.current = false;
      const hit = lineFromPoint(event.clientX, event.clientY);
      // Number-column drags belong to Pierre's own selection handling.
      if (!hit || hit.numberColumn) {
        anchor = null;
        return;
      }
      anchor = { line: hit.line, side: hit.side };
      engaged = false;
      pointerId = event.pointerId;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (anchor == null || event.pointerId !== pointerId) return;
      const hit = lineFromPoint(event.clientX, event.clientY);
      if (!hit) return;
      if (!engaged) {
        if (hit.line === anchor.line) return;
        // The drag crossed into another line: from here it is a line
        // selection, not a text selection. Drop the native selection and
        // block new one from forming for the rest of the drag.
        engaged = true;
        dragSelectionRef.current = true;
        setDragAttribute(true);
        window.getSelection()?.removeAllRanges();
        const shadowRoot = getShadowRoot();
        if (shadowRoot && 'getSelection' in shadowRoot) {
          // SAFETY: getSelection on ShadowRoot is a Chromium extension absent
          // from lib.dom; the `in` check gates the call.
          (shadowRoot as ShadowRoot & { getSelection: () => Selection | null }).getSelection()?.removeAllRanges();
        }
      }
      highlight({
        start: Math.min(anchor.line, hit.line),
        end: Math.max(anchor.line, hit.line),
        side: anchor.side,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (anchor == null || event.pointerId !== pointerId) return;
      const wasEngaged = engaged;
      anchor = null;
      engaged = false;
      pointerId = null;
      setDragAttribute(false);
      if (!wasEngaged) return;
      const range = contentSelectionRef.current;
      contentSelectionRef.current = null;
      if (!range) return;
      // A half-written comment survives an accidental selection elsewhere.
      if (selectionRef.current && commentTextRef.current.trim() && !editingDraftIdRef.current) return;
      applySelection(range);
      if (!editingDraftIdRef.current) {
        setCommentText('');
      }
    };

    root.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      root.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      setDragAttribute(false);
    };
  }, [applySelection, commentTextRef, diffInstanceRef, diffRootRef, editingDraftIdRef, enableComments, isApplyingSelectionRef, selectionRef, setCommentText]);

  // The gutter "+" utility: pressing it (or dragging from it) yields a line
  // range; select it so the comment editor opens under the lines.
  const handleGutterUtilityClick = useCallback((range: SelectedLineRange) => {
    if (!enableComments) return;
    // A content-drag highlight is the intended target when the pressed line
    // falls inside it.
    const highlighted = contentSelectionRef.current;
    const withinHighlight = highlighted
      && range.start >= highlighted.start
      && range.end <= highlighted.end
      && (range.side == null || range.side === highlighted.side);
    if (contentSelectionClearTimerRef.current !== null) {
      window.clearTimeout(contentSelectionClearTimerRef.current);
      contentSelectionClearTimerRef.current = null;
    }
    contentSelectionRef.current = null;
    applySelection(withinHighlight && highlighted ? highlighted : range);
    if (!editingDraftIdRef.current) {
      setCommentText('');
    }
  }, [applySelection, editingDraftIdRef, enableComments, setCommentText]);

  // Clicking anywhere on a diff line (not only its number cell) toggles a
  // single-line comment selection, matching the "+" utility's target.
  const handleLineClick = useCallback((props: OnDiffLineClickProps) => {
    const { event } = props;
    const primaryModifier = isMacOS() ? event.metaKey : event.ctrlKey;
    // Where find is wired, a primary-modifier click on a word is a find
    // request, never a comment.
    const requestFindWord = onFindWordRequestRef.current;
    if (primaryModifier && requestFindWord) {
      if (!event.shiftKey && !event.altKey && event.button === 0 && !props.numberColumn && !dragSelectionRef.current) {
        const hit = findWordAtPoint(props.lineElement, event.clientX, event.clientY);
        if (hit) requestFindWord({ word: hit.word, lineNumber: props.lineNumber, side: props.annotationSide, spanStart: hit.spanStart });
      }
      return;
    }
    if (!enableComments || props.numberColumn) return;
    // Ignore when the user selected text on the way to this click (copying
    // code must not pop the comment editor).
    if (window.getSelection()?.toString().trim()) return;
    const side: SelectedLineRange['side'] = props.annotationSide;
    const range: SelectedLineRange = { start: props.lineNumber, end: props.lineNumber, side };
    const current = selectionRef.current;
    if (current && current.start === range.start && current.end === range.end && current.side === range.side) {
      if (!commentTextRef.current.trim()) {
        setSelection(null);
        const instance = diffInstanceRef.current;
        try {
          isApplyingSelectionRef.current = true;
          instance?.setSelectedLines(null);
        } finally {
          isApplyingSelectionRef.current = false;
        }
      }
      return;
    }
    if (current && commentTextRef.current.trim() && !editingDraftIdRef.current) {
      // A half-written comment survives an accidental click elsewhere.
      return;
    }
    applySelection(range);
    if (!editingDraftIdRef.current) {
      setCommentText('');
    }
  }, [applySelection, commentTextRef, diffInstanceRef, editingDraftIdRef, enableComments, isApplyingSelectionRef, selectionRef, setCommentText, setSelection]);

  useEffect(() => {
    if (!enableComments) return;
    const container = diffContainerRef.current;
    if (!container) return;

    const handleNumberPointerDown = (event: PointerEvent) => {
      if (event.shiftKey || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const current = selectionRef.current;
      if (!current || current.start !== current.end || !current.side
          || (current.endSide && current.endSide !== current.side)
          || commentTextRef.current.trim()) return;

      // The capture listener sees the original number cell across the shadow
      // boundary, before Pierre handles pointerdown on its pre element.
      const numberCell = event.composedPath().find((node): node is HTMLElement =>
        node instanceof HTMLElement && node.hasAttribute('data-column-number'));
      if (!numberCell || Number(numberCell.dataset.columnNumber) !== current.start) return;
      const side: AnnotationSide = numberCell.dataset.lineType === 'change-deletion'
        || numberCell.closest('[data-code][data-deletions]') != null
        ? 'deletions'
        : 'additions';
      if (side === current.side) return;

      // Pierre toggles a single line by number alone. Clear that selection so
      // this gesture can select the same number on the other side normally.
      try {
        isApplyingSelectionRef.current = true;
        diffInstanceRef.current?.setSelectedLines(null);
      } finally {
        isApplyingSelectionRef.current = false;
      }
    };

    container.addEventListener('pointerdown', handleNumberPointerDown, true);
    return () => container.removeEventListener('pointerdown', handleNumberPointerDown, true);
  }, [commentTextRef, diffContainerRef, diffInstanceRef, enableComments, isApplyingSelectionRef, selectionRef]);

  return { handleGutterUtilityClick, handleLineClick };
};
