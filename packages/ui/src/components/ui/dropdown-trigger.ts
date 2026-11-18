import { cva } from 'class-variance-authority';

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
