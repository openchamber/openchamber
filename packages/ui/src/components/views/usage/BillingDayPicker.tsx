import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { Icon } from '@/components/icon/Icon';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const BILLING_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

/** Day of the month a billing cycle starts on, picked from a 7-column grid of days. */
export function BillingDayPicker({ value, onChange }: { value: number; onChange: (day: number) => void }): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<button type="button" aria-label={t('usageStats.billingDay.label')} className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-fit')} />}
      >
        <span className="typography-ui-label text-foreground">{t('usageStats.billingDay.value', { day: value })}</span>
        <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup className={cn(dropdownMenuPopupClass, 'w-fit p-3')} initialFocus={false}>
            <div className="grid grid-cols-7 gap-1">
              {BILLING_DAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={day === value}
                  onClick={() => {
                    onChange(day);
                    setOpen(false);
                  }}
                  className={cn(
                    'size-8 rounded-md typography-ui-label tabular-nums',
                    day === value
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : 'text-foreground hover:bg-interactive-hover',
                  )}
                >
                  {day}
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
