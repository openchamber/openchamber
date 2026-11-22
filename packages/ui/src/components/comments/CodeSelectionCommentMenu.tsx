import React from 'react';

import { toast } from '@/components/ui';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import type { CodeSelectionComments } from './codeSelectionComments';
import { InlineCommentInput } from './InlineCommentInput';
import { SelectionCommentPopup } from './SelectionCommentPopup';

export function CodeSelectionCommentMenu({ comments, filePath }: { comments: CodeSelectionComments; filePath: string | null }) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const target = useComposerDraftTarget(useEffectiveDirectory());
  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const subscribe = React.useCallback((notify: () => void) => comments.attach(filePath, notify), [comments, filePath]);
  const shown = React.useSyncExternalStore(subscribe, comments.getSnapshot);

  const saveComment = (text: string): boolean => {
    if (!shown) return true;
    if (!target) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return false;
    }
    const draftId = addDraft(target, {
      source: 'file-quote',
      fileLabel: shown.filePath,
      startLine: shown.quote.startLine,
      endLine: shown.quote.endLine,
      code: shown.quote.code,
      language: '',
      text: text.trim(),
    });
    if (!draftId) {
      toast.error(t('inlineComment.toast.noRoom'));
      return false;
    }
    comments.hide();
    focusChatInput();
    return true;
  };

  if (!shown || (!shown.commentMode && !shown.anchor && !isMobile)) return null;

  const highlightOverlay = shown.commentMode && shown.highlightRects && shown.highlightRects.length > 0 ? (
    <div className="pointer-events-none fixed inset-0 z-40">
      {shown.highlightRects.map((rect, index) => (
        <div
          key={index}
          className="oc-chat-comment-rect absolute"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </div>
  ) : null;

  return (
    <SelectionCommentPopup
      anchor={shown.anchor ?? { x: 0, y: 0 }}
      commentMode={shown.commentMode}
      commentInput={(
        <InlineCommentInput
          fileLabel={shown.filePath}
          lineRange={{ start: shown.quote.startLine, end: shown.quote.endLine }}
          onSave={saveComment}
          onCancel={comments.hide}
          floating
        />
      )}
      highlightOverlay={highlightOverlay}
      menuRef={comments.setMenu}
      onComment={comments.openComment}
    />
  );
}
