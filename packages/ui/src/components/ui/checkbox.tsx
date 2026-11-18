import * as React from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  ariaLabel?: string;
  className?: string;
  iconClassName?: string;
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
  const boxSize = 'size-3.5 min-h-3.5 min-w-3.5';
  const iconSize = 'size-2.5 min-h-2.5 min-w-2.5';
  const isOn = checked || indeterminate;
  return (
    <span className="contents" onClick={(event) => event.stopPropagation()}>
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(next) => onChange(Boolean(next))}
        disabled={disabled}
        indeterminate={indeterminate}
        aria-label={ariaLabel}
        className={cn(
          'group/checkbox relative flex shrink-0 self-center items-center justify-center rounded-[4px] border outline-none',
          boxSize,
          '[--choice-border:color-mix(in_srgb,var(--foreground)_40%,var(--interactive-border))]',
          'transition-[background-color,border-color,box-shadow] duration-200 ease-out',
          isOn
            ? 'border-[color:color-mix(in_srgb,var(--foreground)_60%,var(--interactive-border))] bg-transparent shadow-none hover:bg-[var(--interactive-hover)]'
            : 'border-[var(--choice-border)] bg-transparent shadow-none hover:bg-[var(--interactive-hover)] hover:border-[var(--choice-border)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <BaseCheckbox.Indicator
          keepMounted
          className={cn(
            'flex items-center justify-center text-foreground',
            'data-[unchecked]:hidden',
            iconClassName,
          )}
        >
          {indeterminate ? (
            <Icon name="subtract" className={iconSize} />
          ) : (
            <Icon name="check" className={iconSize} />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
    </span>
  );
});
