import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SettingsInfoHintProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

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
      <TooltipTrigger
        asChild
        onPointerDown={(event) => event.preventBaseUIHandler()}
        onClick={(event) => {
          event.preventBaseUIHandler();
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('settings.common.infoAria')}
          aria-expanded={open}
          className={cn(
            'inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
