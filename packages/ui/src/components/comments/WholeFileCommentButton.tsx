import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

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
  const label = t('inlineComment.actions.commentOnFile');
  return (
    <button
      type="button"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none',
        className,
        active && 'text-foreground opacity-100',
      )}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Icon name="chat-1" className="size-3.5" />
    </button>
  );
}
