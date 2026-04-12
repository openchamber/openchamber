import React from 'react';
import { RiCheckboxBlankLine, RiCheckboxLine } from '@remixicon/react';
import { cn } from '@/lib/utils';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
}

export const Checkbox = React.memo<CheckboxProps>(function Checkbox({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
  iconClassName,
}) {
  const handleClick = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) {
        onChange(!checked);
      }
    },
    [checked, disabled, onChange]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!disabled) {
          onChange(!checked);
        }
      }
    },
    [checked, disabled, onChange]
  );

  return (
    <div
      role="checkbox"
      tabIndex={disabled ? undefined : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded',
        'text-muted-foreground hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {checked ? (
        <RiCheckboxLine className={cn('size-4 text-primary', iconClassName)} />
      ) : (
        <RiCheckboxBlankLine className={cn('size-4', iconClassName)} />
      )}
    </div>
  );
});
