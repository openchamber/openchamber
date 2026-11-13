import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';

/**
 * The header's trigger, always visible like the header's other actions. It
 * toggles: pressed while the editor is open, a second click closes the editor.
 */
export function WholeFileCommentButton({
  onClick,
  active,
  className,
}: {
  onClick: () => void;
  active: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ToolbarTooltipButton
      label={t('inlineComment.actions.commentOnFile')}
      icon="chat-1"
      pressed={active}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
}
