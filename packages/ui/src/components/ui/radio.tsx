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
        'group/radio relative flex size-3.5 min-h-3.5 min-w-3.5 shrink-0 self-center items-center justify-center rounded-full outline-none',
        // Match checkbox outlines without strengthening borders across the app.
        '[--choice-border:color-mix(in_srgb,var(--foreground)_40%,var(--interactive-border))]',
        'transition-[background-color,box-shadow] duration-200 ease-out',
        // fill driven from props so first paint is correct
        // Checked state stays neutral, matching the checkbox.
        checked
          ? 'bg-transparent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_60%,var(--interactive-border))] hover:bg-[var(--interactive-hover)]'
          : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--choice-border)] hover:bg-[var(--interactive-hover)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'block size-1.5 rounded-full bg-foreground',
          !checked && 'opacity-0',
          iconClassName,
        )}
      />
    </button>
  );
});
