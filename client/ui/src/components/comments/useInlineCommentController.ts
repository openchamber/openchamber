import React from 'react';
import { toast } from '@/components/ui';
import { useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentSource } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';

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

  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);
  const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);
  const allDrafts = useInlineCommentDraftStore((state) => state.drafts);

  const [selection, setSelection] = React.useState<TRange | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null);

  const sessionKey = React.useMemo(() => {
    return currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
  }, [currentSessionId, newSessionDraftOpen]);

  const drafts = React.useMemo(() => {
    if (!sessionKey || !fileLabel) return [];
    const sessionDrafts = allDrafts[sessionKey] ?? [];
    return sessionDrafts.filter((draft) => draft.source === source && draft.fileLabel === fileLabel);
  }, [allDrafts, fileLabel, sessionKey, source]);

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
    removeDraft(draft.sessionKey, draft.id);
    if (editingDraftId === draft.id) {
      reset();
    }
  }, [editingDraftId, removeDraft, reset]);

  const saveComment = React.useCallback((textToSave: string, rangeOverride?: TRange) => {
    const targetRange = rangeOverride ?? selection;
    const trimmedText = textToSave.trim();
    if (!targetRange || !trimmedText || !fileLabel) return;

    if (!sessionKey) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return;
    }

    const normalizedRange = normalizeLineRange(targetRange);
    const normalizedStoreRange = normalizeStoreRange(toStoreRange(normalizedRange));
    const code = getCodeForRange(normalizedRange);

    if (editingDraftId) {
      updateDraft(sessionKey, editingDraftId, {
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        language,
        text: trimmedText,
      });
    } else {
      addDraft({
        sessionKey,
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
  }, [addDraft, editingDraftId, fileLabel, getCodeForRange, language, reset, selection, sessionKey, source, t, toStoreRange, updateDraft]);

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
