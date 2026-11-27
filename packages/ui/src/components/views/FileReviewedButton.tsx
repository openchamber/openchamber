import { Icon } from '@/components/icon/Icon';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface FileReviewedButtonProps {
  reviewed: boolean;
  onToggle: () => void;
  compact?: boolean;
  className?: string;
}

export function FileReviewedButton({
  reviewed,
  onToggle,
  compact = false,
  className,
}: FileReviewedButtonProps) {
  const { t } = useI18n();
  const label = reviewed
    ? t('diffView.actions.unmarkReviewed')
    : t('diffView.actions.markReviewed');

  return (
    <ButtonTooltip label={label} side="top">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={label}
        aria-pressed={reviewed}
        className={cn(
          compact ? 'w-6 px-0 has-[>svg]:px-0' : 'gap-1 px-1.5',
          reviewed
            ? 'text-[var(--status-success)] hover:bg-transparent hover:text-[var(--status-success)]'
            : 'text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:text-foreground',
          className,
        )}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Icon name={reviewed ? 'checkbox-circle' : 'checkbox-blank-circle'} className="size-3.5 shrink-0" />
        {!compact && (
          <span className="hidden typography-micro sm:inline">{t('diffView.reviewed.label')}</span>
        )}
      </Button>
    </ButtonTooltip>
  );
}
