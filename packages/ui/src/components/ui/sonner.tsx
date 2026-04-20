"use client"

import * as React from "react"
import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"

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
function usePinnedToastStyles(shadow: string) {
  React.useEffect(() => {
    if (typeof document === "undefined") return

    const apply = (el: HTMLElement) => {
      el.style.setProperty("box-shadow", shadow, "important")
      el.style.setProperty("outline", "none", "important")
      if (el.getAttribute("tabindex") === "0") el.setAttribute("tabindex", "-1")
    }

    const applyToAll = () => {
      document
        .querySelectorAll<HTMLElement>("[data-sonner-toast]")
        .forEach(apply)
    }

    applyToAll()

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return
          if (node.matches?.("[data-sonner-toast]")) apply(node)
          node
            .querySelectorAll?.<HTMLElement>("[data-sonner-toast]")
            .forEach(apply)
        })
      }
      // Re-pin in case sonner mutates style.cssText on interactions.
      applyToAll()
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "tabindex", "data-expanded", "data-swiping"],
    })

    return () => observer.disconnect()
  }, [shadow])
}

const Toaster = ({ ...props }: ToasterProps) => {
  const isDark = useIsDarkTheme()
  const shadow = isDark ? SHADOW_DARK : SHADOW_LIGHT
  usePinnedToastStyles(shadow)

  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      closeButton={false}
      toastOptions={{
        classNames: {
          toast:
            "group/toast toast !rounded-[var(--radius-xl)] !border-0 !px-3.5 !py-3 !gap-2.5 !text-foreground",
          title: "typography-ui-label !font-medium !text-foreground",
          description: "typography-meta !text-muted-foreground !mt-0.5",
          actionButton:
            "!rounded-[var(--radius-md)] !bg-[var(--primary-base)] !text-white hover:!opacity-85 !px-2 !py-1 typography-meta !font-medium transition-opacity",
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
