import * as React from "react"

const GUARD_ATTRIBUTE = "data-glass-redraw-guard"

let openPopups = 0

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
