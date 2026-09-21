import React from "react"
import { cn } from "@/lib/utils"
import { iconSpriteData } from "./sprite"
import type { IconName } from "./icons"

const SPRITE_ID = "openchamber-icon-sprite"

let spriteInjected = false

function ensureSpriteOnce() {
  if (spriteInjected) return
  if (typeof document === "undefined") return
  const body = document.body
  if (!body) return

  const existing = document.getElementById(SPRITE_ID)
  if (existing) {
    spriteInjected = true
    return
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = SPRITE_ID
  svg.setAttribute("aria-hidden", "true")
  svg.style.display = "none"
  svg.innerHTML = Object.entries(iconSpriteData)
    .map(([name, content]) => `<symbol id="oc-${name}" viewBox="0 0 24 24">${content}</symbol>`)
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInjected = true
}

/**
 * Append a single missing symbol. Needed when the sprite was injected before a
 * newly generated icon landed (HMR / late sprite regenerate) — a one-shot inject
 * would otherwise leave `<use href="#oc-…"/>` pointing at nothing.
 */
function ensureSpriteSymbol(name: IconName) {
  if (typeof document === "undefined") return
  ensureSpriteOnce()
  if (document.getElementById(`oc-${name}`)) return

  const content = iconSpriteData[name]
  if (typeof content !== "string") return

  const sprite = document.getElementById(SPRITE_ID)
  if (!sprite) return

  const symbol = document.createElementNS("http://www.w3.org/2000/svg", "symbol")
  symbol.id = `oc-${name}`
  symbol.setAttribute("viewBox", "0 0 24 24")
  symbol.innerHTML = content
  sprite.appendChild(symbol)
}

export interface IconProps extends React.ComponentPropsWithoutRef<"svg"> {
  name: IconName
}

export const Icon = React.memo(({ name, className, ...rest }: IconProps) => {
  // Inline sprite injection during render – must run before <use> tries
  // to resolve the #oc-* reference during the same commit.
  if (typeof document !== "undefined") {
    ensureSpriteSymbol(name)
  }

  return (
    <svg
      className={cn("remixicon", className)}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <use href={`#oc-${name}`} />
    </svg>
  )
})

Icon.displayName = "Icon"
