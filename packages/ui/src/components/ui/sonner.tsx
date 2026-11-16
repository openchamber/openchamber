"use client"

import * as React from "react"
import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"
import { formatMessage, getLocaleDirection, useI18nStore } from "@/lib/i18n"
import { buttonVariants } from "@/components/ui/button-variants"
import { Spinner } from "@/components/ui/spinner"

type ToastPosition = NonNullable<ToasterProps["position"]>

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

// external: https://github.com/emilkowalski/sonner/blob/main/src/styles.css Sonner focus-visible shadows override app elevation; pin the shadow and remove toast focusability.
function usePinnedToastStyles(container: HTMLElement | null, shadow: string) {
  React.useEffect(() => {
    if (!container) return

    const probe = document.createElement("div").style
    const pinned = ([["box-shadow", shadow], ["outline", "none"]] as const).map(([property, value]) => {
      probe.setProperty(property, value)
      return [property, probe.getPropertyValue(property) || value] as const
    })
    const apply = (el: HTMLElement) => {
      for (const [property, value] of pinned) {
        if (el.style.getPropertyValue(property) === value && el.style.getPropertyPriority(property) === "important") continue
        el.style.setProperty(property, value, "important")
      }
      if (el.getAttribute("tabindex") === "0") el.setAttribute("tabindex", "-1")
    }

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

const ToastCloseMark = ({ large = false }: { large?: boolean }) => (
  <span className={`oc-raised flex ${large ? "size-6" : "size-5"} items-center justify-center rounded-full bg-[var(--surface-background)] dark:bg-surface-elevated`}>
    <svg viewBox="0 0 24 24" className={large ? "size-6" : "size-5"} aria-hidden="true">
      <circle className="oc-toast-ring" cx="12" cy="12" r="10.5" pathLength="100" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(-90 12 12)" />
      <path d="M8.5 8.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
)

type ToastLayout = "corner" | "banner"

const CORNER_CLASS_NAMES = {
  closeButton:
    "absolute top-1 start-1 z-[1] flex -translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2 items-center justify-center rounded-full !border-0 !bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none",
  toast:
    "oc-surface-elevated group/toast toast flex w-[var(--width)] flex-wrap items-start gap-2 rounded-[var(--radius-xl)] px-3.5 py-3 text-foreground data-[expanded=false]:data-[front=false]:[&>*]:opacity-0 [&_[data-button]]:self-center [&_[data-button]]:ms-auto [&_[data-cancel]+[data-button]]:ms-0",
  content: "flex min-w-0 flex-col [[data-icon]+&]:max-w-[calc(100%-1.875rem)] [[data-sonner-toast]:has([data-cancel])_&]:w-full",
  title: "typography-ui-label font-medium text-foreground py-[calc((var(--toast-row)-1lh)/2)]",
  icon: "relative me-0.5 flex h-[var(--toast-row)] w-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5",
}

const BANNER_CLASS_NAMES = {
  closeButton:
    "order-last !static -me-1 flex size-9 shrink-0 !transform-none items-center justify-center self-center rounded-full !border-0 !bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none",
  toast:
    "oc-surface-elevated group/toast toast flex w-[var(--width)] items-start gap-2 rounded-[var(--radius-xl)] py-2.5 ps-3.5 pe-2 text-foreground data-[expanded=false]:data-[front=false]:[&>*]:opacity-0 [&_[data-button]]:shrink-0 [&_[data-button]]:self-center",
  content: "flex min-w-0 flex-1 flex-col",
  title: "typography-ui-label font-medium text-foreground py-[calc((2.25rem-1lh)/2)]",
  icon: "relative me-0.5 flex h-9 w-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5",
}

const Toaster = ({ position = "bottom-right", layout = "corner", ...props }: ToasterProps & { layout?: ToastLayout }) => {
  const direction = getLocaleDirection(useI18nStore((state) => state.locale))
  const closeLabel = formatMessage(useI18nStore((state) => state.dictionary), "dialog.common.actions.close")
  const isDark = useIsDarkTheme()
  const shadow = isDark ? SHADOW_DARK : SHADOW_LIGHT
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
      icons={{ loading: <Spinner className="size-5" />, close: <ToastCloseMark large={layout === "banner"} /> }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: closeLabel,
        classNames: {
          ...layoutClassNames,
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
          "--width": "min(22.25rem, calc(100vw - 48px))",
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
