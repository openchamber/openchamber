import React from 'react';
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
        'group/radio relative flex h-[14px] w-[14px] min-h-[14px] min-w-[14px] shrink-0 self-center items-center justify-center rounded-full outline-none',
        'transition-[background-color,box-shadow] duration-200 ease-out',
        // fill driven from props so first paint is correct
        checked
          ? 'bg-[color-mix(in_srgb,var(--primary-base)_80%,transparent)] shadow-none hover:bg-[var(--primary-base)]'
          : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {checked ? (
        <span
          aria-hidden
          className={cn(
            'block h-[5px] w-[5px] rounded-full bg-white',
            iconClassName,
          )}
        />
      ) : null}
    </button>
  );
});
