import React from 'react';
import { toast } from '@/components/ui';
import {
  EMPTY_INLINE_COMMENT_DRAFTS,
  getInlineCommentDraftKey,
  useInlineCommentDraftStore,
  type InlineCommentDraft,
  type InlineCommentSource,
} from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { diffCommentOriginKey, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { anchorComment, commentContext, type CommentAnchorInput, type CommentLineSource } from '@/lib/commentAnchor';

type LineRangeBase = {
  start: number;
  end: number;
};

type StoreRange = {
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified';
};

interface UseInlineCommentControllerOptions<TRange extends LineRangeBase> {
  source: InlineCommentSource;
  fileLabel: string | null;
  language: string;
  getCodeForRange: (range: TRange) => string;
  toStoreRange: (range: TRange) => StoreRange;
  fromDraftRange: (draft: InlineCommentDraft) => TRange;
  origin?: DiffCommentOrigin;
  lineSource?: (range: TRange) => CommentLineSource | null;
  contentVersion?: unknown;
  onSelectionMoved?: (range: TRange) => void;
}

const normalizeStoreRange = (range: StoreRange): StoreRange => {
  const startLine = Math.min(range.startLine, range.endLine);
  const endLine = Math.max(range.startLine, range.endLine);
  return {
    ...range,
    startLine,
    endLine,
  };
};

export const normalizeLineRange = <TRange extends LineRangeBase>(range: TRange): TRange => {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return {
    ...range,
    start,
    end,
  };
};

export function useInlineCommentController<TRange extends LineRangeBase>(
  options: UseInlineCommentControllerOptions<TRange>
) {
  const { t } = useI18n();
  const { source, fileLabel, language, getCodeForRange, toStoreRange, fromDraftRange, origin, contentVersion } = options;
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });
  const originKey = diffCommentOriginKey(origin);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory();
  const sessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => currentSessionId ? state.getDirectoryForSession(currentSessionId) : null,
      [currentSessionId],
    ),
  );

  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);
  const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);

  const [selection, setSelection] = React.useState<TRange | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null);

  const target = useComposerDraftTarget(sessionDirectory ?? effectiveDirectory);
  const targetKey = target
    ? getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey)
    : null;
  const sessionDrafts = useInlineCommentDraftStore(
    React.useCallback(
      (state) => targetKey ? state.drafts[targetKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS,
      [targetKey],
    ),
  );

  const drafts = React.useMemo(() => {
    if (!target || !fileLabel) return [];
    return sessionDrafts.filter((draft) => (
      draft.source === source && draft.fileLabel === fileLabel && (
        diffCommentOriginKey(draft.origin) === originKey
        || (draft.origin === undefined && (origin?.kind === 'working-tree' || origin?.kind === 'turn'))
      )
    ));
  }, [fileLabel, origin?.kind, originKey, sessionDrafts, source, target]);

  React.useEffect(() => {
    if (!target) return;
    const { lineSource, fromDraftRange: rangeOf } = optionsRef.current;
    if (!lineSource) return;
    for (const draft of drafts) {
      const lines = lineSource(rangeOf(draft));
      if (!lines) continue;
      const anchored = anchorComment(lines, draft);
      if (anchored.startLine === draft.startLine && anchored.endLine === draft.endLine && anchored.changedCode === draft.changedCode) continue;
      updateDraft(target, draft.id, { startLine: anchored.startLine, endLine: anchored.endLine, changedCode: anchored.changedCode });
    }
  }, [contentVersion, drafts, target, updateDraft]);

  const selectionAnchorRef = React.useRef<Omit<CommentAnchorInput, 'startLine' | 'endLine'> | null>(null);
  const movedSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
  React.useEffect(() => {
    const { lineSource, getCodeForRange: codeOf, toStoreRange: storeRangeOf } = optionsRef.current;
    const lines = selection ? lineSource?.(selection) : null;
    const moved = movedSelectionRef.current;
    movedSelectionRef.current = null;
    if (!selection || !lines) {
      selectionAnchorRef.current = null;
      return;
    }
    const range = normalizeLineRange(selection);
    if (moved && moved.start === range.start && moved.end === range.end && selectionAnchorRef.current) return;
    const stored = normalizeStoreRange(storeRangeOf(range));
    selectionAnchorRef.current = { code: codeOf(range), ...commentContext(lines, stored.startLine, stored.endLine) };
  }, [selection]);
  React.useEffect(() => {
    const anchor = selectionAnchorRef.current;
    const { lineSource, toStoreRange: storeRangeOf, onSelectionMoved } = optionsRef.current;
    const lines = selection ? lineSource?.(selection) : null;
    if (!selection || !anchor || !lines) return;
    const range = normalizeLineRange(selection);
    const stored = normalizeStoreRange(storeRangeOf(range));
    const anchored = anchorComment(lines, { ...anchor, startLine: stored.startLine, endLine: stored.endLine });
    if (anchored.startLine === stored.startLine && anchored.endLine === stored.endLine) return;
    movedSelectionRef.current = { start: anchored.startLine, end: anchored.endLine };
    (onSelectionMoved ?? setSelection)({ ...range, start: anchored.startLine, end: anchored.endLine });
  }, [contentVersion, selection]);

  const reset = React.useCallback(() => {
    setSelection(null);
    setCommentText('');
    setEditingDraftId(null);
  }, []);

  const cancel = React.useCallback(() => {
    reset();
  }, [reset]);

  const startEdit = React.useCallback((draft: InlineCommentDraft) => {
    const draftRange = normalizeLineRange(fromDraftRange(draft));
    setSelection(draftRange);
    setCommentText(draft.text);
    setEditingDraftId(draft.id);
  }, [fromDraftRange]);

  const deleteDraft = React.useCallback((draft: InlineCommentDraft) => {
    if (!target) return;
    removeDraft(target, draft.id);
    if (editingDraftId === draft.id) {
      reset();
    }
  }, [editingDraftId, removeDraft, reset, target]);

  const saveComment = React.useCallback((textToSave: string, rangeOverride?: TRange): boolean => {
    const targetRange = rangeOverride ?? selection;
    const trimmedText = textToSave.trim();
    if (!targetRange || !trimmedText || !fileLabel) return false;

    if (!target) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return false;
    }

    if (editingDraftId && !useInlineCommentDraftStore.getState().getDrafts(target).some((draft) => draft.id === editingDraftId)) {
      reset();
      return true;
    }

    const normalizedRange = normalizeLineRange(targetRange);
    const normalizedStoreRange = normalizeStoreRange(toStoreRange(normalizedRange));
    const code = getCodeForRange(normalizedRange);
    const lines = optionsRef.current.lineSource?.(normalizedRange);
    const context = lines ? commentContext(lines, normalizedStoreRange.startLine, normalizedStoreRange.endLine) : null;
    const anchor = {
      contextBefore: context?.contextBefore,
      contextAfter: context?.contextAfter,
      changedCode: undefined,
    };

    const isNewComment = !editingDraftId;
    const saved = editingDraftId
      ? updateDraft(target, editingDraftId, {
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        ...anchor,
        language,
        text: trimmedText,
        origin: drafts.find((draft) => draft.id === editingDraftId)?.origin ?? origin,
      })
      : addDraft(target, {
        source,
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        ...anchor,
        language,
        text: trimmedText,
        origin,
      }) !== null;
    if (!saved) {
      toast.error(t('inlineComment.toast.noRoom'));
      return false;
    }

    reset();
    if (isNewComment) {
      requestAnimationFrame(focusChatInput);
    }
    return true;
  }, [addDraft, drafts, editingDraftId, fileLabel, getCodeForRange, language, origin, reset, selection, source, t, target, toStoreRange, updateDraft]);

  return {
    drafts,
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    setEditingDraftId,
    reset,
    cancel,
    startEdit,
    deleteDraft,
    saveComment,
    fromDraftRange,
  };
}
