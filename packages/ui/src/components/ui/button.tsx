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
  "text-[var(--primary-base)]",
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
  "text-[var(--status-error)]",
  "border border-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--status-error)_11%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--status-error)_16%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--status-error)_20%,transparent)]",
].join(" ")

const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] typography-ui-label font-medium lowercase tracking-[0.01em] shrink-0 select-none",
    "transition-[background-color,border-color,color,opacity] duration-150 ease-out outline-none",
    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
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
        neutral:
          "bg-interactive-hover text-foreground border border-border/60 hover:bg-interactive-active",
        outline:
          "bg-[var(--surface-elevated)] text-foreground border border-border/60 hover:bg-interactive-hover hover:text-foreground",
        // Flat chip for "one-of-N" toggles. Unselected: hairline border + hover
        // fill. Selected (aria-pressed): same tinted palette as the default
        // button (pale primary fill + primary text + soft primary border).
        chip: cn(
          "border border-border/60 bg-transparent text-foreground hover:bg-interactive-hover hover:text-foreground",
          "aria-pressed:bg-[color-mix(in_srgb,var(--primary-base)_10%,var(--background))]",
          "aria-pressed:text-[var(--primary-base)]",
          "aria-pressed:border-[color-mix(in_srgb,var(--primary-base)_12%,transparent)]",
          "aria-pressed:hover:bg-[color-mix(in_srgb,var(--primary-base)_16%,var(--background))]",
          "aria-pressed:hover:text-[var(--primary-base)]",
          "dark:aria-pressed:bg-[color-mix(in_srgb,var(--primary-base)_16%,transparent)]",
          "dark:aria-pressed:border-[color-mix(in_srgb,var(--primary-base)_20%,transparent)]",
          "dark:aria-pressed:hover:bg-[color-mix(in_srgb,var(--primary-base)_22%,transparent)]",
        ),
        secondary:
          "bg-interactive-hover text-foreground hover:bg-interactive-active",
        ghost:
          "text-foreground hover:bg-interactive-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
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
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants }
