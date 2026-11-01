import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

type SwitchProps = React.ComponentPropsWithoutRef<typeof BaseSwitch.Root> & {
  loading?: boolean;
  /** `sm` for dense panels and popovers, where the default reads too heavy. */
  size?: 'default' | 'sm';
};

const Switch = React.forwardRef<
  HTMLButtonElement,
  SwitchProps
>(({ className, loading = false, size = 'default', ...props }, ref) => (
  <BaseSwitch.Root
    className={cn(
      'peer inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 shadow-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-[var(--interactive-border)]',
      size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
      className
    )}
    {...props}
    aria-busy={loading || undefined}
    ref={ref}
  >
    <BaseSwitch.Thumb
      className={cn(
        'pointer-events-none flex items-center justify-center rounded-full bg-muted-foreground data-[checked]:bg-primary-foreground shadow-none ring-0 transition-transform data-[unchecked]:translate-x-0',
        size === 'sm'
          ? 'size-3 data-[checked]:translate-x-3 rtl:data-[checked]:-translate-x-3'
          : 'size-4 data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4',
        loading && 'bg-status-warning text-background',
      )}
    >
      {loading ? <Spinner className="size-3" /> : null}
    </BaseSwitch.Thumb>
  </BaseSwitch.Root>
));
Switch.displayName = 'Switch';

export { Switch };
