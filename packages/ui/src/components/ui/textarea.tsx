import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollableOverlay } from "./ScrollableOverlay"

type TextareaProps = React.ComponentProps<"textarea"> & {
  outerClassName?: string;
  scrollbarClassName?: string;
  fillContainer?: boolean;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
};

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, outerClassName, scrollbarClassName, fillContainer = false, useScrollShadow = false, scrollShadowSize, ...props }, ref) => {
    return (
      <ScrollableOverlay
        as="textarea"
        ref={ref as React.Ref<HTMLTextAreaElement>}
        disableHorizontal
        fillContainer={fillContainer}
        useScrollShadow={useScrollShadow}
        scrollShadowSize={scrollShadowSize}
        outerClassName={cn(
          "w-full rounded-lg focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary/50",
          useScrollShadow && "border border-border/80 hover:border-input",
          outerClassName
        )}
        scrollbarClassName={scrollbarClassName}
        className={cn(
          "text-foreground placeholder:text-muted-foreground appearance-none dark:bg-input/30 flex min-h-16 w-full rounded-lg bg-transparent px-3 py-2 typography-markdown outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:typography-ui-label",
          useScrollShadow ? "border-0" : "border border-border/80 hover:border-input focus:border-primary/70",
          fillContainer ? "[field-sizing:fixed]" : "field-sizing-content",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
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
