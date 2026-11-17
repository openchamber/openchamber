"use client"

import * as React from "react"
import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"
import { getLocaleDirection, useI18nStore } from "@/lib/i18n"

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
      // Skip the write when the pin already stands: this runs from a
      // MutationObserver that watches the style attribute, and a DOM
      // implementation that queues a mutation record for every
      // setProperty call — even one that changes nothing — would loop
      // forever on its own writes. The pin stands exactly when both
      // properties still carry the !important priority this function
      // sets (sonner resetting a toast's inline style drops it, which
      // is what the re-pin exists for) and tabindex is already -1.
      const pinned =
        el.style.getPropertyPriority("box-shadow") === "important" &&
        el.style.getPropertyPriority("outline") === "important" &&
        el.getAttribute("tabindex") === "-1"
      if (pinned) return
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

const Toaster = ({ position = "bottom-right", ...props }: ToasterProps) => {
  // Read from the store, so a Toaster rendered outside the provider still works.
  const direction = getLocaleDirection(useI18nStore((state) => state.locale))
  const isDark = useIsDarkTheme()
  const shadow = isDark ? SHADOW_DARK : SHADOW_LIGHT
  // State, not a ref: the observer attaches once sonner's section mounts.
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  usePinnedToastStyles(container, shadow)

  return (
    <Sonner
      ref={setContainer}
      theme={isDark ? "dark" : "light"}
      dir={direction}
      position={direction === "rtl" ? MIRRORED_POSITION[position] : position}
      className="toaster group"
      closeButton={false}
      toastOptions={{
        classNames: {
          toast:
            "oc-surface-elevated group/toast toast !rounded-[var(--radius-xl)] !border-0 !px-3.5 !py-3 !gap-2.5 !text-foreground [&_[data-cancel]+[data-button]]:!ms-2",
          title: "typography-ui-label !font-medium !text-foreground",
          description: "typography-meta !text-muted-foreground !mt-0.5",
          actionButton:
            "!rounded-[var(--radius-md)] !bg-[var(--primary-base)] !text-[var(--primary-foreground)] hover:!opacity-85 !px-2 !py-1 typography-meta !font-medium transition-opacity",
          cancelButton:
            "!rounded-[var(--radius-md)] !bg-[var(--interactive-hover)] !text-foreground hover:!bg-[var(--interactive-active)] !px-2 !py-1 typography-meta !font-medium transition-colors",
          closeButton:
            "!rounded-[var(--radius-md)] !bg-[var(--interactive-hover)] !text-foreground hover:!bg-[var(--interactive-active)]",
          icon: "!text-muted-foreground",
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
