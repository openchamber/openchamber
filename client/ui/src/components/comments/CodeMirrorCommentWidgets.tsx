import React from 'react';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput } from './InlineCommentInput';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { BlockWidgetDef } from '@/components/ui/CodeMirrorEditor';

type LineRange = {
  start: number;
  end: number;
  side?: 'additions' | 'deletions';
};

interface CodeMirrorCommentWidgetsOptions {
  drafts: InlineCommentDraft[];
  editingDraftId: string | null;
  commentText: string;
  onTextChange: (text: string) => void;
  selection: LineRange | null;
  isDragging: boolean;
  fileLabel: string;
  newWidgetId: string;
  mapDraftToRange: (draft: InlineCommentDraft) => LineRange;
  onSave: (text: string, range?: LineRange) => void;
  onCancel: () => void;
  onEdit: (draft: InlineCommentDraft) => void;
  onDelete: (draft: InlineCommentDraft) => void;
}

export function buildCodeMirrorCommentWidgets(options: CodeMirrorCommentWidgetsOptions): BlockWidgetDef[] {
  const {
    drafts,
    editingDraftId,
    commentText,
    onTextChange,
    selection,
    isDragging,
    fileLabel,
    newWidgetId,
    mapDraftToRange,
    onSave,
    onCancel,
    onEdit,
    onDelete,
  } = options;

  const widgets: BlockWidgetDef[] = [];

  for (const draft of drafts) {
    const draftRange = mapDraftToRange(draft);
    if (draft.id === editingDraftId) {
      widgets.push({
        afterLine: draftRange.end,
        id: `edit-${draft.id}`,
        content: (
          <InlineCommentInput
            key={`edit-${draft.id}`}
            initialText={commentText}
            onTextChange={onTextChange}
            fileLabel={fileLabel}
            lineRange={draftRange}
            isEditing={true}
            onSave={onSave}
            onCancel={onCancel}
          />
        ),
      });
      continue;
    }

    widgets.push({
      afterLine: draftRange.end,
      id: `card-${draft.id}`,
      content: (
        <InlineCommentCard
          key={`card-${draft.id}`}
          draft={draft}
          onEdit={() => onEdit(draft)}
          onDelete={() => onDelete(draft)}
        />
      ),
    });
  }

  if (selection && !editingDraftId && !isDragging) {
    const normalizedSelection = {
      ...selection,
      start: Math.min(selection.start, selection.end),
      end: Math.max(selection.start, selection.end),
    };

    widgets.push({
      afterLine: normalizedSelection.end,
      id: newWidgetId,
      content: (
        <InlineCommentInput
          key={newWidgetId}
          initialText={commentText}
          onTextChange={onTextChange}
          fileLabel={fileLabel}
          lineRange={normalizedSelection}
          isEditing={false}
          onSave={onSave}
          onCancel={onCancel}
        />
      ),
    });
  }

  return widgets;
}
