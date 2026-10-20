import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type SwitchProps = React.ComponentPropsWithoutRef<typeof BaseSwitch.Root> & {
  loading?: boolean;
};

const Switch = React.forwardRef<
  HTMLButtonElement,
  SwitchProps
>(({ className, loading = false, ...props }, ref) => (
  <BaseSwitch.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 shadow-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-[var(--interactive-border)]',
      className
    )}
    {...props}
    aria-busy={loading || undefined}
    ref={ref}
  >
    <BaseSwitch.Thumb
      className={cn(
        'pointer-events-none flex size-4 items-center justify-center rounded-full bg-muted-foreground data-[checked]:bg-primary-foreground shadow-none ring-0 transition-transform data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4 data-[unchecked]:translate-x-0',
        loading && 'bg-status-warning text-background',
      )}
    >
      {loading ? <Icon name="loader" className="size-3 animate-spin" /> : null}
    </BaseSwitch.Thumb>
  </BaseSwitch.Root>
));
Switch.displayName = 'Switch';

export { Switch };
