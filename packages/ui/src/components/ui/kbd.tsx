import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Single keyboard keycap. Use for shortcut hints and chord previews.
 * Keep content short (one modifier or one key); wrap sequences with ShortcutKbd.
 */
export function Kbd({
  className,
  ...props
}: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 shrink-0 select-none items-center justify-center',
        'rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)]',
        'px-1.5 font-mono typography-micro font-medium leading-none',
        'text-[var(--surface-muted-foreground)] whitespace-nowrap',
        'shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.12)]',
        'dark:shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.08)]',
        className,
      )}
      {...props}
    />
  );
}

type ShortcutKbdProps = {
  /** Display string from formatShortcutForDisplay, e.g. "⌃ + X" or "Ctrl + Shift + M". */
  shortcut: string;
  className?: string;
  /** Optional keycap tone for the pending/active chord state. */
  tone?: 'default' | 'selection';
};

/**
 * Renders a shortcut as a horizontal row of keycaps joined by "+".
 * Splits on "+" so multi-key combos never wrap into a single tall kbd.
 */
export function ShortcutKbd({ shortcut, className, tone = 'default' }: ShortcutKbdProps) {
  const tokens = shortcut
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  return (
    <span
      data-slot="shortcut-kbd"
      className={cn('inline-flex items-center gap-0.5 whitespace-nowrap', className)}
    >
      {tokens.map((token, index) => (
        <React.Fragment key={`${token}-${index}`}>
          {index > 0 ? (
            <span className="px-0.5 typography-micro text-[var(--surface-muted-foreground)] opacity-70">
              +
            </span>
          ) : null}
          <Kbd
            className={cn(
              tone === 'selection' &&
                'border-[var(--interactive-selection)] bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
            )}
          >
            {token}
          </Kbd>
        </React.Fragment>
      ))}
    </span>
  );
}
