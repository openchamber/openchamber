import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Slot } from "@/components/ui/slot"

// Matte solid buttons: thin inner top highlight + hairline inner border + soft drop.
// No full-surface gloss overlay — avoids the pillowy/bevel feel.
const SOLID_SHADOW =
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.14),inset_0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.18)]"

const SOLID_SHADOW_HOVER =
  "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_0_0_0_1px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.22)]"

const SOLID_SHADOW_ACTIVE =
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(0,0,0,0.10),0_1px_1px_rgba(0,0,0,0.20)]"

const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[7px] typography-ui-label font-medium lowercase tracking-[0.01em] shrink-0",
    "transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out outline-none",
    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: cn(
          "bg-[var(--primary-base)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ),
        destructive: cn(
          "bg-[var(--status-error)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
          "focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        ),
        neutral: cn(
          "bg-foreground text-background",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ),
        outline:
          "border border-border/60 bg-background text-foreground hover:bg-interactive-hover hover:text-foreground",
        secondary:
          "bg-interactive-hover text-foreground hover:bg-interactive-active",
        ghost:
          "text-foreground hover:bg-interactive-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-2.5 has-[>svg]:px-2 rounded-[6px]",
        xs: "h-6 gap-1 px-2 typography-micro has-[>svg]:px-1.5 rounded-[5px]",
        lg: "h-10 px-4 has-[>svg]:px-3.5 rounded-[8px]",
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
