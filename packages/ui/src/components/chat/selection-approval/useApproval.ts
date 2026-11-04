import { useChatColumnActions } from '../chatColumnSession';
import { useMobileCommentComposerController } from '../composer/comment/MobileCommentComposerContext';
import type { SelectionActionProps } from '../selectionModule';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';

export function useApproval({ getSelection, onSuccess }: SelectionActionProps, focus: boolean) {
  const { t } = useI18n();
  const controller = useMobileCommentComposerController();
  const { focusInput } = useChatColumnActions();

  const approve = () => {
    const selection = getSelection();
    if (!selection?.markdownText) return;
    const target = controller?.getScope();
    if (!target || target.runtimeKey !== getRuntimeKey()) {
      toast.error(t('chat.textSelection.comment.attachFailed'));
      return;
    }
    const draftId = useInlineCommentDraftStore.getState().addDraft(
      { directory: target.directory, sessionKey: target.sessionKey },
      {
        source: 'chat-quote',
        fileLabel: selection.messageId ?? '',
        startLine: 1,
        endLine: 1,
        code: selection.markdownText,
        language: '',
        text: useUIStore.getState().selectionApprovalText.trim() || 'LGTM',
        anchor: selection.anchor ?? undefined,
      },
    );
    if (!draftId) {
      toast.error(t('chat.textSelection.comment.attachFailed'));
      return;
    }
    onSuccess();
    if (focus) queueMicrotask(() => focusInput());
  };

  return { approve, label: t('chat.selection.approve') };
}
