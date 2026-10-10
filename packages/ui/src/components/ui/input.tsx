import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = React.ComponentProps<"input"> & {
  /**
   * `compact` (h-7) for toolbars and filter rows, where it sits beside
   * `size="sm"` buttons and compact dropdown triggers; `default` (h-8) for
   * forms and dialogs. Named apart from the native numeric `size` attribute.
   */
  inputSize?: "default" | "compact"
}

function Input({ className, type, inputSize = "default", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "oc-surface-elevated",
        "text-foreground file:text-foreground placeholder:text-muted-foreground selection:bg-interactive-selection selection:text-interactive-selection-foreground bg-[var(--surface-elevated)] appearance-none flex w-full min-w-0 rounded-md px-2.5 py-1 typography-markdown outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:typography-ui-label file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:typography-ui-label",
        inputSize === "compact" ? "h-7" : "h-8",
        // AlignUI-style ring border + transitions
        "ring-1 ring-inset ring-border/60 transition duration-200 ease-out",
        "hover:[&:not(:focus)]:[background-image:linear-gradient(var(--interactive-hover),var(--interactive-hover))]",
        "focus:ring-2 focus:ring-[var(--interactive-focus-ring)] focus-visible:outline-none",
        "aria-invalid:ring-[var(--status-error)] aria-invalid:focus:ring-[var(--status-error)]",
        className
      )}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      {...props}
    />
  )
}

export { Input }
