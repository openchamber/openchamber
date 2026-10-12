import * as React from "react"

const GUARD_ATTRIBUTE = "data-glass-redraw-guard"

let openPopups = 0

/**
 * Rendered inside a glass popup (menu, select, tooltip): while any is open,
 * <html> carries data-glass-redraw-guard and design-system.css mounts the
 * full-viewport blurred layer that keeps Chromium from repainting glass under
 * the popup from a stale blur. Only open popups pay for that layer.
 */
function GlassRedrawGuard(): null {
  React.useLayoutEffect(() => {
    openPopups += 1
    document.documentElement.setAttribute(GUARD_ATTRIBUTE, "")
    return () => {
      openPopups -= 1
      if (openPopups === 0) {
        document.documentElement.removeAttribute(GUARD_ATTRIBUTE)
      }
    }
  }, [])
  return null
}

export { GlassRedrawGuard }
