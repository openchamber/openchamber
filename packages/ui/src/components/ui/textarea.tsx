import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollableOverlay } from "./ScrollableOverlay"

type TextareaProps = React.ComponentProps<"textarea"> & {
  outerClassName?: string;
  scrollbarClassName?: string;
  fillContainer?: boolean;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
  hasError?: boolean;
  /**
   * AlignUI "simple" mode: render a bare textarea (no compound wrapper).
   * Used for chat composer or anywhere the textarea is embedded inside an
   * existing styled container.
   */
  simple?: boolean;
  /**
   * Slot rendered in the bottom-right (next to the resize handle).
   * Typically a `<TextareaCharCounter />`.
   */
  endSlot?: React.ReactNode;
};

function ResizeHandle({ onResizeStart }: { onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize textarea"
      onPointerDown={onResizeStart}
      // generous hit area; SVG renders centered in the bottom-right corner
      className="pointer-events-auto -m-2 flex size-7 cursor-ns-resize items-end justify-end p-2 touch-none select-none"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <path
          d="M9.11111 2L2 9.11111M10 6.44444L6.44444 10"
          className="stroke-muted-foreground"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      outerClassName,
      scrollbarClassName,
      fillContainer = false,
      useScrollShadow = false,
      scrollShadowSize,
      hasError,
      disabled,
      simple,
      endSlot,
      ...props
    },
    ref,
  ) => {
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
    const [resizedHeight, setResizedHeight] = React.useState<number | null>(null);

    const handleResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      dragStateRef.current = {
        startY: event.clientY,
        startHeight: wrapper.getBoundingClientRect().height,
      };
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state) return;
        const next = state.startHeight + (moveEvent.clientY - state.startY);
        setResizedHeight(Math.max(82, next));
      };
      const onUp = () => {
        dragStateRef.current = null;
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
      event.preventDefault();
    }, []);

    const focusInnerTextarea = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      // Clicking the wrapper chrome (below/around the textarea) should focus it.
      const target = event.target as HTMLElement;
      if (target.closest('textarea, button, [role="separator"]')) return;
      const textarea = wrapperRef.current?.querySelector('textarea');
      if (textarea && document.activeElement !== textarea) {
        event.preventDefault();
        textarea.focus();
      }
    }, []);

    // Simple mode: bare textarea, caller owns the wrapper.
    if (simple) {
      return (
        <ScrollableOverlay
          as="textarea"
          ref={ref as React.Ref<HTMLTextAreaElement>}
          disableHorizontal
          fillContainer={fillContainer}
          useScrollShadow={useScrollShadow}
          scrollShadowSize={scrollShadowSize}
          outerClassName={outerClassName}
          scrollbarClassName={scrollbarClassName}
          className={cn(
            "block w-full appearance-none resize-none bg-transparent text-foreground typography-markdown outline-none",
            "px-3 py-2 md:typography-ui-label",
            "placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            fillContainer ? "[field-sizing:fixed]" : "field-sizing-content",
            className,
          )}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          disabled={disabled}
          {...props}
        />
      );
    }

    return (
      <div
        ref={wrapperRef}
        onPointerDown={focusInnerTextarea}
        style={resizedHeight !== null ? { height: `${resizedHeight}px` } : undefined}
        className={cn(
          "group/textarea relative flex w-full flex-col rounded-[var(--radius-xl)] bg-[var(--surface-elevated)] pb-2.5",
          "ring-1 ring-inset ring-border/60 transition duration-200 ease-out",
          "hover:[&:not(:focus-within)]:bg-[var(--surface-subtle)]",
          "has-[[disabled]]:pointer-events-none has-[[disabled]]:bg-[var(--surface-subtle)] has-[[disabled]]:ring-transparent",
          !hasError && [
            "hover:[&:not(:focus-within)]:ring-transparent",
            "focus-within:ring-2 focus-within:ring-[var(--interactive-focus-ring)]",
          ],
          hasError && [
            "ring-[var(--status-error)]",
            "focus-within:ring-2 focus-within:ring-[var(--status-error)]",
          ],
          outerClassName,
        )}
      >
        <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
          <textarea
              ref={ref}
              className={cn(
                "block w-full flex-1 min-h-0 appearance-none resize-none bg-transparent text-foreground typography-markdown outline-none",
                "min-h-[82px] pl-3 pr-2.5 pt-2.5 md:typography-ui-label",
                "focus-visible:outline-none disabled:cursor-not-allowed",
                !disabled && [
                  "placeholder:select-none placeholder:text-muted-foreground placeholder:transition placeholder:duration-200 placeholder:ease-out",
                  "group-hover/textarea:placeholder:text-foreground/80",
                  "focus:placeholder:text-foreground/80",
                ],
                disabled && "text-muted-foreground/60 placeholder:text-muted-foreground/60",
                className,
              )}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              disabled={disabled}
              {...props}
            />
          <div className="flex items-center justify-end gap-1.5 pl-3 pr-2.5">
            {endSlot}
            <ResizeHandle onResizeStart={handleResizeStart} />
          </div>
        </div>
      </div>
    )
  }
)

Textarea.displayName = "Textarea"

function TextareaCharCounter({
  current,
  max,
  className,
}: {
  current?: number;
  max?: number;
  className?: string;
}) {
  if (current === undefined || max === undefined) return null;
  const isError = current > max;
  return (
    <span
      className={cn(
        "typography-meta text-muted-foreground",
        "group-has-[[disabled]]/textarea:text-muted-foreground/60",
        isError && "text-[var(--status-error)]",
        className,
      )}
    >
      {current}/{max}
    </span>
  );
}

export { Textarea, TextareaCharCounter }
