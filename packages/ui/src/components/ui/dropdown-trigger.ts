import { cva, type VariantProps } from 'class-variance-authority';

/**
 * Single source of truth for every dropdown-style trigger surface in the app:
 * native Select triggers, DropdownMenu trigger buttons, and custom pickers
 * (model/agent/project selectors, git branch pickers, …).
 *
 * Change shape, border, radius, or interaction colors HERE and every trigger
 * in every surface follows. Do not re-declare these classes at call sites —
 * call sites may only add layout (width/min-width/max-width, truncation).
 *
 * Sizes:
 * - `sm`      — dense surfaces: chat composer, toolbars, list rows (h-6).
 * - `default` — forms, dialogs, and settings pages (h-8).
 */
export const dropdownTriggerVariants = cva(
  [
    'border-input flex items-center justify-between gap-2 rounded-md border bg-transparent',
    'typography-ui-label whitespace-nowrap shadow-none outline-none text-left',
    'hover:bg-interactive-hover data-[popup-open]:bg-interactive-active',
    'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
  ].join(' '),
  {
    variants: {
      size: {
        sm: "h-6 min-h-6 px-2 [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-8 min-h-8 px-3 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export type DropdownTriggerVariantProps = VariantProps<typeof dropdownTriggerVariants>;
export type DropdownTriggerSize = NonNullable<DropdownTriggerVariantProps['size']>;
