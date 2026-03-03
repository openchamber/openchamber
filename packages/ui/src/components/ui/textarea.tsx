import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollableOverlay } from "./ScrollableOverlay"

type TextareaProps = React.ComponentProps<"textarea"> & {
  outerClassName?: string;
  scrollbarClassName?: string;
};

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, outerClassName, scrollbarClassName, ...props }, ref) => {
    return (
      <ScrollableOverlay
        as="textarea"
        ref={ref as React.Ref<HTMLTextAreaElement>}
        disableHorizontal
        fillContainer={false}
        outerClassName={cn("w-full rounded-lg focus-within:ring-1 focus-within:ring-primary/50", outerClassName)}
        scrollbarClassName={scrollbarClassName}
        className={cn(
          "text-foreground border border-border/80 placeholder:text-muted-foreground appearance-none dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-lg bg-transparent px-3 py-2 typography-markdown outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:typography-ui-label",
          "hover:border-input aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          "focus:border-primary/70",
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
)

Textarea.displayName = "Textarea"

export { Textarea }
