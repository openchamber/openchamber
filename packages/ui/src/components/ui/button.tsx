import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Slot } from "@/components/ui/slot"

// Flat tinted buttons: very pale tinted fill (a desaturated version of the
// border tone) + saturated tinted border + saturated tinted text. No
// elevation. Dark theme mixes into transparent over the surface so the tone
// sits atop the dark background.
const TINT_PRIMARY = [
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

const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] typography-ui-label font-medium lowercase tracking-[0.01em] shrink-0 select-none",
    "transition-[background-color,border-color,color,opacity] duration-150 ease-out outline-none",
    "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-[3px]",
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: TINT_PRIMARY,
        destructive: cn(
          TINT_DESTRUCTIVE,
          "focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        ),
        info: TINT_INFO,
         neutral:
           "bg-secondary text-secondary-foreground border border-border/60 hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] active:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]",
        outline:
           "oc-surface-elevated bg-surface-elevated text-foreground border border-border/60 hover:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))] active:[background-image:linear-gradient(var(--interactive-active),var(--interactive-active))]",
         // A chip represents selection, independently of the primary action.
        chip: cn(
          "border border-border/60 bg-transparent text-foreground hover:bg-interactive-hover hover:text-foreground",
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
        default: "h-9 px-3.5 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-2.5 has-[>svg]:px-2 rounded-[9px] supports-[corner-shape:squircle]:rounded-[50px]",
        xs: "h-6 gap-1 px-2 typography-micro has-[>svg]:px-1.5 rounded-[7px] supports-[corner-shape:squircle]:rounded-[50px]",
        lg: "h-10 px-4 has-[>svg]:px-3.5 rounded-[12px] supports-[corner-shape:squircle]:rounded-[50px]",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"
  const typeProps = asChild
    ? (type === undefined ? {} : { type })
    : { type: type ?? "button" }

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...typeProps}
      {...props}
    />
  )
}

export { Button }
