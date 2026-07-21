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
import { getRuntimeKey } from '@/lib/runtime-switch';

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
  const { source, fileLabel, language, getCodeForRange, toStoreRange, fromDraftRange } = options;

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
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

  const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
  const draftDirectory = sessionDirectory ?? effectiveDirectory;
  const target = React.useMemo(() => {
    if (!sessionKey || !draftDirectory) return null;
    return { directory: draftDirectory, sessionKey };
  }, [draftDirectory, sessionKey]);
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
    return sessionDrafts.filter((draft) => draft.source === source && draft.fileLabel === fileLabel);
  }, [fileLabel, sessionDrafts, source, target]);

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

  const saveComment = React.useCallback((textToSave: string, rangeOverride?: TRange) => {
    const targetRange = rangeOverride ?? selection;
    const trimmedText = textToSave.trim();
    if (!targetRange || !trimmedText || !fileLabel) return;

    if (!target) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return;
    }

    const normalizedRange = normalizeLineRange(targetRange);
    const normalizedStoreRange = normalizeStoreRange(toStoreRange(normalizedRange));
    const code = getCodeForRange(normalizedRange);

    if (editingDraftId) {
      updateDraft(target, editingDraftId, {
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        language,
        text: trimmedText,
      });
    } else {
      addDraft(target, {
        source,
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        language,
        text: trimmedText,
      });
    }

    reset();
  }, [addDraft, editingDraftId, fileLabel, getCodeForRange, language, reset, selection, source, t, target, toStoreRange, updateDraft]);

  return {
    sessionKey,
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
