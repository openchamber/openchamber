import { describe, expect, test } from "bun:test"
import React from "react"
import { resolveSessionPlaceholder } from "./sessionPlaceholder"

const t = ((key: string) => key) as Parameters<typeof resolveSessionPlaceholder>[0]["t"]

const base = {
  t,
  draftOpen: false,
  draftPresentationExiting: false,
  useCompactDraftLayout: false,
  isDesktopExpandedInput: false,
  isSessionHydrating: true,
  messageCount: 0,
  sessionIsWorking: false,
  spaceStopped: false,
  effectiveSessionDirectory: "/repo",
  loadStatus: "loading",
  authSessionExpired: false,
  retrySessionLoad: () => undefined,
}

const elementProps = (node: React.ReactNode): Record<string, unknown>[] => {
  if (node === null || node === undefined || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return []
  if (Array.isArray(node)) return node.flatMap(elementProps)
  if (!React.isValidElement(node)) return []
  const props = node.props as { children?: React.ReactNode }
  return [props as Record<string, unknown>, ...elementProps(props.children)]
}

const collectText = (node: React.ReactNode): string[] => {
  if (node === null || node === undefined || typeof node === "boolean") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectText)
  if (!React.isValidElement(node)) return []
  return collectText((node.props as { children?: React.ReactNode }).children)
}

const showsSkeleton = (node: React.ReactNode) => elementProps(node)
  .some((props) => props["data-chat-hydration-skeleton"] !== undefined)

describe("resolveSessionPlaceholder", () => {
  test("a hydrating session with no messages shows the skeleton while it is idle", () => {
    expect(showsSkeleton(resolveSessionPlaceholder(base))).toBe(true)
  })

  test("a busy session with no messages shows the skeleton instead of an empty body", () => {
    const placeholder = resolveSessionPlaceholder({ ...base, sessionIsWorking: true })
    expect(placeholder).toBeDefined()
    expect(showsSkeleton(placeholder)).toBe(true)
  })

  test("a failed history read stays visible and retryable while the session is busy", () => {
    const placeholder = resolveSessionPlaceholder({
      ...base,
      sessionIsWorking: true,
      loadStatus: "error",
    })
    expect(collectText(placeholder)).toContain("chat.container.sessionLoadError.title")
  })

  test("a busy session that already shows messages keeps rendering its transcript", () => {
    expect(resolveSessionPlaceholder({
      ...base,
      sessionIsWorking: true,
      messageCount: 4,
    })).toBeUndefined()
  })

  test("a loaded session with no messages renders no loading or error surface", () => {
    const placeholder = resolveSessionPlaceholder({
      ...base,
      isSessionHydrating: false,
      messageCount: 0,
    })
    expect(showsSkeleton(placeholder)).toBe(false)
    expect(collectText(placeholder)).toEqual([])
  })
})
