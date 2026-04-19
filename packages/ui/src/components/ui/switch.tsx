import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';

import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>
>(({ className, ...props }, ref) => (
  <BaseSwitch.Root
    className={cn(
      'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-[var(--interactive-border)]',
      className
    )}
    style={{ width: '36px', height: '20px', minWidth: '36px', minHeight: '20px' }}
    {...props}
    ref={ref}
  >
    <BaseSwitch.Thumb
      className={cn(
        'pointer-events-none block rounded-full bg-background shadow-none ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0'
      )}
      style={{ width: '16px', height: '16px', minWidth: '16px', minHeight: '16px' }}
    />
  </BaseSwitch.Root>
));
Switch.displayName = 'Switch';

export { Switch };
