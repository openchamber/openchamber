import * as React from 'react';
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
  const boxSize = 'h-[14px] w-[14px] min-h-[14px] min-w-[14px]';
  const iconSize = 'h-[10px] w-[10px] min-h-[10px] min-w-[10px]';
  const isOn = checked || indeterminate;
  const handleClick = React.useCallback(() => {
    if (disabled) {
      return;
    }
    onChange(!checked);
  }, [checked, disabled, onChange]);
  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onChange(!checked);
    }
  }, [checked, disabled, onChange]);

  return (
    <div
      role="checkbox"
      tabIndex={disabled ? undefined : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className={cn(
        // AlignUI-style rounded box, no explicit border (rely on inset shadow for unchecked)
        'group/checkbox relative flex shrink-0 self-center items-center justify-center rounded-[4px] outline-none',
        boxSize,
        'transition-[background-color,box-shadow] duration-200 ease-out',
        // Drive fill directly from React props so the initial paint matches
        // the final state without waiting for Base UI to hydrate data attrs.
        isOn
          ? 'bg-transparent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary-base)_50%,transparent)] hover:bg-[var(--interactive-hover)]'
          : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
        // focus
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        // disabled
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center text-[var(--primary-base)]',
          !isOn && 'hidden',
          iconClassName,
        )}
      >
        {indeterminate ? (
          <RiSubtractLine className={cn(iconSize, 'text-[var(--primary-base)]')} />
        ) : (
          <RiCheckLine className={cn(iconSize, 'text-[var(--primary-base)]')} />
        )}
      </span>
    </div>
  );
});
