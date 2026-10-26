"use client"

import * as React from "react"
import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"
import { formatMessage, getLocaleDirection, useI18nStore } from "@/lib/i18n"
import { buttonVariants } from "@/components/ui/button-variants"
import { Spinner } from "@/components/ui/spinner"

type ToastPosition = NonNullable<ToasterProps["position"]>

// Corners mirror with the layout: a right-to-left app stacks toasts on the left.
const MIRRORED_POSITION = {
  "top-left": "top-right",
  "top-right": "top-left",
  "bottom-left": "bottom-right",
  "bottom-right": "bottom-left",
  "top-center": "top-center",
  "bottom-center": "bottom-center",
} as const satisfies Record<ToastPosition, ToastPosition>

const SHADOW_DARK =
  "inset 0 1px 0 0 rgba(255,255,255,0.12), inset 0 0 0 1px rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.36), 0 1px 1px -0.5px rgba(0,0,0,0.22), 0 3px 3px -1.5px rgba(0,0,0,0.20), 0 6px 6px -3px rgba(0,0,0,0.16)"

const SHADOW_LIGHT =
  "inset 0 1px 0 0 rgba(255,255,255,0.8), inset 0 0 0 1px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.10), 0 1px 2px -0.5px rgba(0,0,0,0.08), 0 4px 8px -2px rgba(0,0,0,0.08), 0 12px 20px -4px rgba(0,0,0,0.08)"

function useIsDarkTheme() {
  const getIsDark = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  const [isDark, setIsDark] = React.useState(getIsDark)

  React.useEffect(() => {
    const update = () => setIsDark(getIsDark())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    update()
    return () => observer.disconnect()
  }, [])

  return isDark
}

// Sonner makes each toast focusable (tabIndex=0) and defines a `:focus-visible`
// box-shadow that erases our custom elevation on click. We pin every toast's
// box-shadow as an !important inline style and strip tabIndex so the element
// can't receive focus-induced style swaps.
//
// Only the toaster's own section is observed: toasts render inside it, and
// observing the whole document ran a query on every DOM change in the app,
// including every streamed token.
function usePinnedToastStyles(container: HTMLElement | null, shadow: string) {
  React.useEffect(() => {
    if (!container) return

    const apply = (el: HTMLElement) => {
      el.style.setProperty("box-shadow", shadow, "important")
      el.style.setProperty("outline", "none", "important")
      if (el.getAttribute("tabindex") === "0") el.setAttribute("tabindex", "-1")
    }

    // Re-pins everything, in case sonner mutates style.cssText on interactions.
    const applyToAll = () => {
      container
        .querySelectorAll<HTMLElement>("[data-sonner-toast]")
        .forEach(apply)
    }

    applyToAll()

    const observer = new MutationObserver(applyToAll)

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "tabindex", "data-expanded", "data-swiping"],
    })

    return () => observer.disconnect()
  }, [container, shadow])
}

// The close cross, on a disc of its own over the toast's corner. A toast that
// closes by itself fills the ring around it (`.oc-toast-timed`), which runs down
// to the moment it goes and holds while the pointer rests on the toasts, as
// sonner's timer does.
const ToastCloseMark = ({ large = false }: { large?: boolean }) => (
  // `oc-raised` draws only the edge and shadow; the disc is opaque, as a
  // raised control is (canvas tone in light themes, elevated in dark).
  <span className={`oc-raised flex ${large ? "size-6" : "size-5"} items-center justify-center rounded-full bg-[var(--surface-background)] dark:bg-surface-elevated`}>
    <svg viewBox="0 0 24 24" className={large ? "size-6" : "size-5"} aria-hidden="true">
      <circle className="oc-toast-ring" cx="12" cy="12" r="10.5" pathLength="100" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(-90 12 12)" />
      <path d="M8.5 8.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
)

/**
 * Where the close cross sits and how the rest lines up. `corner` (desktop and
 * web): the cross on a disc over the toast's leading top corner, buttons
 * beside short text or on a row below long text. `banner` (the phone): one
 * row like a system banner, the text, then the buttons, then a larger cross
 * inside the toast's end, all centred on the text; nothing hangs off the
 * toast over the header behind it.
 */
type ToastLayout = "corner" | "banner"

const CORNER_CLASS_NAMES = {
  // Centered on the toast's leading top corner, whatever size touch gives
  // the button; the disc inside keeps its size. Sonner paints the button
  // itself (fill, edge) even unstyled; `!` keeps that paint off.
  closeButton:
    "absolute top-1 start-1 z-[1] flex -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2 items-center justify-center rounded-full !border-0 !bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none",
  toast:
    "oc-surface-elevated group/toast toast flex w-[var(--width)] flex-wrap items-start gap-2 rounded-[var(--radius-xl)] px-3.5 py-3 text-foreground data-[expanded=false]:data-[front=false]:[&>*]:opacity-0 [&_[data-button]]:self-center [&_[data-button]]:ms-auto [&_[data-cancel]+[data-button]]:ms-0",
  // Capped to the row beside the icon (its 1.25rem, its 0.125rem margin
  // and the 0.5rem gap): long text fills that row and pushes the buttons
  // onto a row of their own below, where the first one's auto margin
  // keeps them at the end. Text that fits leaves them beside it. Two
  // buttons stay together: a toast with a cancel button puts both below.
  content: "flex min-w-0 flex-col [[data-icon]+&]:max-w-[calc(100%-1.875rem)] [[data-sonner-toast]:has([data-cancel])_&]:w-full",
  // Padded to the buttons' height (`--toast-row`), so a one-line title
  // centers on the buttons beside it and the icon lines up with the
  // title's first line.
  title: "typography-ui-label font-medium text-foreground py-[calc((var(--toast-row)-1lh)/2)]",
  icon: "relative me-0.5 flex h-[var(--toast-row)] w-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5",
}

const BANNER_CLASS_NAMES = {
  // In the row, last whatever sonner's order, a thumb-sized target around
  // the larger disc. Sonner positions the button absolutely; `!` undoes it.
  closeButton:
    "order-last !static -me-1 flex size-9 shrink-0 !transform-none items-center justify-center self-center rounded-full !border-0 !bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none",
  toast:
    "oc-surface-elevated group/toast toast flex w-[var(--width)] items-center gap-2 rounded-[var(--radius-xl)] py-2.5 ps-3.5 pe-2 text-foreground data-[expanded=false]:data-[front=false]:[&>*]:opacity-0 [&_[data-button]]:shrink-0",
  content: "flex min-w-0 flex-1 flex-col",
  title: "typography-ui-label font-medium text-foreground",
  // On the title's first line: the icon takes the title's type so `1lh` is
  // that line's height.
  icon: "relative me-0.5 flex h-[1lh] w-5 shrink-0 items-center justify-center self-start typography-ui-label text-muted-foreground [&>svg]:size-5",
}

const Toaster = ({ position = "bottom-right", layout = "corner", ...props }: ToasterProps & { layout?: ToastLayout }) => {
  // Read from the store, so a Toaster rendered outside the provider still works.
  const direction = getLocaleDirection(useI18nStore((state) => state.locale))
  const closeLabel = formatMessage(useI18nStore((state) => state.dictionary), "dialog.common.actions.close")
  const isDark = useIsDarkTheme()
  const shadow = isDark ? SHADOW_DARK : SHADOW_LIGHT
  // State, not a ref: the observer attaches once sonner's section mounts.
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  usePinnedToastStyles(container, shadow)
  const layoutClassNames = layout === "banner" ? BANNER_CLASS_NAMES : CORNER_CLASS_NAMES

  return (
    <Sonner
      ref={setContainer}
      theme={isDark ? "dark" : "light"}
      dir={direction}
      position={direction === "rtl" ? MIRRORED_POSITION[position] : position}
      className="toaster group font-sans"
      closeButton
      // Sonner's own spinner is a fixed 16px box pinned to the icon slot's
      // corner; the app's spinner is centered in the slot and scales with it.
      icons={{ loading: <Spinner className="size-5" />, close: <ToastCloseMark large={layout === "banner"} /> }}
      toastOptions={{
        // Sonner's built-in look is written in px (width, text, button height)
        // and its own font stack, so it ignores the interface font and size.
        // Unstyled drops that look; the classes below draw the whole toast in
        // rem and give its buttons the shared Button's look.
        unstyled: true,
        closeButtonAriaLabel: closeLabel,
        classNames: {
          ...layoutClassNames,
          // `!`: sonner colours dark-theme descriptions even when unstyled.
          description: "typography-meta !text-muted-foreground",
          actionButton: buttonVariants({ size: "xs" }),
          cancelButton: buttonVariants({ variant: "secondary", size: "xs" }),
          success: "[&_[data-icon]]:!text-[var(--status-success)]",
          error: "[&_[data-icon]]:!text-[var(--status-error)]",
          warning: "[&_[data-icon]]:!text-[var(--status-warning)]",
          info: "[&_[data-icon]]:!text-[var(--status-info)]",
        },
        style: {
          borderRadius: "var(--radius-xl)",
          backgroundColor: "var(--surface-elevated)",
        },
      }}
      style={
        {
          // Sonner sets 356px; in rem the toast grows with the interface size,
          // up to the window less sonner's 24px offset on each side.
          "--width": "min(22.25rem, calc(100vw - 48px))",
          // The xs button's height; mobile.css raises it with the buttons.
          "--toast-row": "1.5rem",
          "--normal-bg": "var(--surface-elevated)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "transparent",
          "--error-bg": "var(--surface-elevated)",
          "--error-text": "var(--foreground)",
          "--error-border": "transparent",
          "--success-bg": "var(--surface-elevated)",
          "--success-text": "var(--foreground)",
          "--success-border": "transparent",
          "--warning-bg": "var(--surface-elevated)",
          "--warning-text": "var(--foreground)",
          "--warning-border": "transparent",
          "--info-bg": "var(--surface-elevated)",
          "--info-text": "var(--foreground)",
          "--info-border": "transparent",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
