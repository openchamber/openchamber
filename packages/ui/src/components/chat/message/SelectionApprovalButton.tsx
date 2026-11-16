import { useChatColumnActions } from '../chatColumnSession';
import { useMobileCommentComposerController } from '../composer/comment/MobileCommentComposerContext';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { DEFAULT_SELECTION_APPROVAL_TEXT, useUIStore } from '@/stores/useUIStore';

interface SelectionApprovalButtonProps {
  mobile: boolean;
  /** Reads the selection when the user acts. */
  getSelection: () => { markdownText: string; messageId: string | null; anchor: ChatQuoteAnchor | null } | null;
  /** Dismisses the selection once the quote is attached. */
  onSuccess: () => void;
}

export function SelectionApprovalButton({ mobile, getSelection, onSuccess }: SelectionApprovalButtonProps) {
  const { t } = useI18n();
  const controller = useMobileCommentComposerController();
  const { focusInput } = useChatColumnActions();
  const label = t('chat.textSelection.title.approveSelection');

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
        text: useUIStore.getState().selectionApprovalText.trim() || DEFAULT_SELECTION_APPROVAL_TEXT,
        anchor: selection.anchor ?? undefined,
      },
    );
    if (!draftId) {
      toast.error(t('inlineComment.toast.noRoom'));
      return;
    }
    onSuccess();
    if (!mobile) queueMicrotask(() => focusInput());
  };

  if (mobile) {
    return (
      <button
        type="button"
        onClick={approve}
        aria-label={label}
        className="flex min-w-0 items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-start text-sm font-medium leading-tight text-foreground transition-opacity duration-150 active:opacity-80"
      >
        <Icon name="thumb-up" className="h-5 w-5 flex-shrink-0" />
        <span className="min-w-0 whitespace-normal">{label}</span>
      </button>
    );
  }

  return (
    <HoverTooltip label={label}>
      <Button type="button" variant="ghost" size="icon" onClick={approve} aria-label={label} className="rounded-full">
        <Icon name="thumb-up" className="size-4" />
      </Button>
    </HoverTooltip>
  );
}
