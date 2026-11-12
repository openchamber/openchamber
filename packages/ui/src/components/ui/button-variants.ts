import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Tinted buttons: very pale tinted fill (a desaturated version of the border
// tone) + saturated tinted border + saturated tinted text, lit like the other
// controls (`oc-raised-button`). Dark theme mixes into transparent over the
// surface so the tone sits atop the dark background.
const TINT_PRIMARY = [
  "oc-raised-button",
  "bg-[color-mix(in_srgb,var(--primary-base)_10%,var(--background))]",
  "text-[var(--primary-text)]",
  "border border-[color-mix(in_srgb,var(--primary-base)_12%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--primary-base)_16%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--primary-base)_22%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--primary-base)_16%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--primary-base)_20%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--primary-base)_22%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--primary-base)_30%,transparent)]",
].join(" ")

const TINT_DESTRUCTIVE = [
  "oc-raised-button",
  "bg-[color-mix(in_srgb,var(--status-error)_7%,var(--background))]",
  "text-[var(--error-text)]",
  "border border-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--status-error)_11%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--status-error)_16%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--status-error)_20%,transparent)]",
].join(" ")

const TINT_INFO = [
  "oc-raised-button",
  "bg-[color-mix(in_srgb,var(--status-info)_4%,var(--background))]",
  "text-[var(--info-text)]",
  "border border-[color-mix(in_srgb,var(--status-info)_8%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--status-info)_7%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--status-info)_10%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--status-info)_7%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--status-info)_12%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--status-info)_10%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--status-info)_14%,transparent)]",
].join(" ")

export const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md typography-ui-label font-medium shrink-0 select-none",
    "transition-[background-color,border-color,color,opacity] duration-150 ease-out outline-none",
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: TINT_PRIMARY,
        destructive: TINT_DESTRUCTIVE,
        info: TINT_INFO,
         neutral:
           "oc-raised bg-secondary text-secondary-foreground hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] active:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]",
        outline:
           // Raised like the dropdown triggers: canvas-coloured in light themes,
           // where elevated is darker than the page.
           "oc-surface-elevated oc-raised bg-[var(--surface-background)] dark:bg-surface-elevated text-foreground hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] active:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]",
         // A chip represents selection, independently of the primary action.
        chip: cn(
          // Flat by tone, no border: a filter or a toggle, not a raised control.
          "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] text-foreground hover:bg-interactive-hover hover:text-foreground",
           "aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground",
           "aria-pressed:hover:bg-interactive-selection aria-pressed:hover:text-interactive-selection-foreground",
        ),
         secondary:
           "bg-secondary text-secondary-foreground hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] active:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]",
        ghost:
          "text-foreground hover:bg-interactive-hover hover:text-foreground",
         link: "text-[var(--primary-text)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        xs: "h-6 gap-1 px-2 typography-micro has-[>svg]:px-1.5 rounded-[5px]",
        lg: "h-9 px-4 has-[>svg]:px-3.5 rounded-lg",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
