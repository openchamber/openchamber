import { cva } from 'class-variance-authority';

/**
 * Single source of truth for every dropdown-style trigger surface in the app:
 * native Select triggers, DropdownMenu trigger buttons, and custom pickers
 * (model/agent/project selectors, git branch pickers, …).
 *
 * Change shape, border, radius, or interaction colors HERE and every trigger
 * in every surface follows. Do not re-declare these classes at call sites —
 * call sites may only add layout (width/min-width/max-width, truncation).
 *
 * Look: a raised control (`oc-raised`), the same edge and shadow as the text
 * fields and the active tab pill. Light themes paint elevated darker than the
 * canvas, so the trigger takes the canvas colour there to stand up. Width
 * hugs the value, the chevron right after it; call sites cap it with a
 * max-width and long values truncate.
 *
 * Sizes:
 * - `default` — every desktop trigger: forms, dialogs, settings, toolbars,
 *               filter rows (h-7). One height, so pickers in one window never
 *               disagree; it matches `Button size="sm"`.
 * - `mobile`  — phone layouts that render the same trigger inline (h-8).
 * - `touch`   — mobile value pickers opening a sheet (h-11).
 */
export const dropdownTriggerVariants = cva(
  [
    'oc-surface-elevated oc-raised flex items-center justify-between gap-1.5 rounded-md bg-[var(--surface-background)] dark:bg-surface-elevated',
    'aria-invalid:[--oc-raised-edge:var(--status-error)]',
    'typography-ui-label whitespace-nowrap outline-none text-start',
    'hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] data-[popup-open]:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]',
    'focus-visible:outline-none',
    'disabled:cursor-not-allowed disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
  ].join(' '),
  {
    variants: {
      size: {
        default: "h-7 min-h-7 px-2.5 [&_svg:not([class*='size-'])]:size-4",
        mobile: "h-8 min-h-8 px-3 [&_svg:not([class*='size-'])]:size-4",
        touch: "h-11 min-h-11 px-3 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);
