import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SettingsInfoHintProps {
  children: React.ReactNode;
  className?: string;
  /** Tooltip panel width cap. @default 'max-w-sm' */
  contentClassName?: string;
}

/**
 * Info icon revealing helper text on hover or click (click covers touch
 * devices, where hover tooltips never open). Clicking outside closes it.
 * Settings pages hide secondary descriptions behind this to keep the
 * default view quiet.
 */
export const SettingsInfoHint: React.FC<SettingsInfoHintProps> = ({
  children,
  className,
  contentClassName,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const trigger = triggerRef.current;
      if (trigger && event.target instanceof Node && trigger.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('settings.common.infoAria')}
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          className={cn(
            'inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            className,
          )}
        >
          <Icon name="information" className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8} className={cn('max-w-sm', contentClassName)}>
        {children}
      </TooltipContent>
    </Tooltip>
  );
};
