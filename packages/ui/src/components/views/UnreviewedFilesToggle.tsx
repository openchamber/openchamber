import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

export function UnreviewedFilesToggle({ enabled, onChange, compact }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const label = t('diffView.reviewed.unreviewedOnly');
  const button = (
    <Button
      type="button"
      variant="chip"
      size={compact ? 'sm' : 'default'}
      className="shrink-0"
      aria-label={label}
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
    >
      <Icon name="filter-3" className="size-4" />
      {!compact && label}
    </Button>
  );
  return compact ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  ) : button;
}
