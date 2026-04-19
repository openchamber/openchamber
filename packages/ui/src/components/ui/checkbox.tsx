import * as React from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { RiCheckLine, RiSubtractLine } from '@remixicon/react';
import { cn } from '@/lib/utils';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
  /** @deprecated size is fixed; prop retained for backwards compatibility */
  size?: 'sm' | 'default';
}


export const Checkbox = React.memo<CheckboxProps>(function Checkbox({
  checked,
  onChange,
  disabled = false,
  indeterminate,
  ariaLabel,
  className,
  iconClassName,
}) {
  const boxSize = 'h-3.5 w-3.5 min-h-3.5 min-w-3.5';
  const iconSize = 'h-[10px] w-[10px] min-h-[10px] min-w-[10px]';
  const isOn = checked || indeterminate;
  return (
    <BaseCheckbox.Root
      checked={checked}
      onCheckedChange={(next) => onChange(Boolean(next))}
      disabled={disabled}
      indeterminate={indeterminate}
      aria-label={ariaLabel}
      className={cn(
        // AlignUI-style rounded box, no explicit border (rely on inset shadow for unchecked)
        'group/checkbox relative flex shrink-0 self-center items-center justify-center rounded-[4px] outline-none',
        boxSize,
        'transition-[background-color,box-shadow] duration-200 ease-out',
        // Drive fill directly from React props so the initial paint matches
        // the final state without waiting for Base UI to hydrate data attrs.
        isOn
          ? 'bg-[color-mix(in_srgb,var(--primary-base)_80%,transparent)] shadow-none hover:bg-[var(--primary-base)]'
          : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
        // focus
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        // disabled
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <BaseCheckbox.Indicator
        keepMounted
        className={cn(
          'flex items-center justify-center text-white',
          // hide when fully unchecked (no state)
          'data-[unchecked]:hidden',
          iconClassName,
        )}
      >
        {indeterminate ? (
          <RiSubtractLine className={cn(iconSize, 'text-white')} />
        ) : (
          <RiCheckLine className={cn(iconSize, 'text-white')} />
        )}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
});
