import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export type ThinkingPillProps = {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
};

export const ThinkingPill = ({ value, options, disabled, onChange }: ThinkingPillProps) => {
  const { t } = useI18n();
  const label = value || t('rightSidebar.contextNotesTodo.sendDialog.variant.default');

  const trigger = (
    <div
      className={cn(
        'flex h-6 w-fit items-center gap-1.5 rounded-lg border border-border/20 bg-interactive-selection/20 px-2',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-interactive-hover/30',
      )}
    >
      <span className="typography-micro whitespace-nowrap font-medium capitalize">{label}</span>
      <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
    </div>
  );

  if (disabled) return trigger;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[220px]" portalToBody>
        <DropdownMenuItem className="typography-meta" onSelect={() => onChange('')}>
          <span className={cn('font-medium', !value && 'text-primary')}>
            {t('rightSidebar.contextNotesTodo.sendDialog.variant.default')}
          </span>
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            className="typography-meta"
            onSelect={() => onChange(option)}
          >
            <span className={cn('font-medium capitalize', value === option && 'text-primary')}>
              {option}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
