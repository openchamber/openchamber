import React from 'react';
import { RiRadioButtonFill, RiRadioButtonLine } from '@remixicon/react';
import { cn } from '@/lib/utils';

interface RadioProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
}

export const Radio = React.memo<RadioProps>(function Radio({
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
      if (!disabled && !checked) {
        onChange();
      }
    },
    [checked, disabled, onChange]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!disabled && !checked) {
          onChange();
        }
      }
    },
    [checked, disabled, onChange]
  );

  return (
    <button
      type="button"
      role="radio"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      aria-checked={checked}
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
        <RiRadioButtonFill className={cn('size-4 text-primary', iconClassName)} />
      ) : (
        <RiRadioButtonLine className={cn('size-4', iconClassName)} />
      )}
    </button>
  );
});
