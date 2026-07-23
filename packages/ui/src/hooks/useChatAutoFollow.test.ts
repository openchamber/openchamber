import { describe, expect, test } from "bun:test"
import { isAutoFollowReleaseKey, isMiddleButtonAutoScrollIntent, shouldRepinReleasedAutoFollow } from "./useChatAutoFollow"

class MockElement {
  parent: MockElement | null = null
  scrollable = false

  appendChild(child: MockElement) {
    child.parent = this
  }

  closest(selector: string) {
    if (selector !== "[data-scrollable]") return null
    if (this.scrollable) return this
    let current = this.parent
    while (current) {
      if (current.scrollable) return current
      current = current.parent
    }
    return null
  }
}

globalThis.Element = MockElement as unknown as typeof Element
globalThis.HTMLElement = MockElement as unknown as typeof HTMLElement

const keyEvent = (key: string, overrides: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {}) => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

describe("useChatAutoFollow intent helpers", () => {
  test("releases auto-follow for upward and explicit pause keyboard intent", () => {
    expect(isAutoFollowReleaseKey(keyEvent("ArrowUp"))).toBe(true)
    expect(isAutoFollowReleaseKey(keyEvent("PageUp"))).toBe(true)
    expect(isAutoFollowReleaseKey(keyEvent("Home"))).toBe(true)
    expect(isAutoFollowReleaseKey(keyEvent(" ", { shiftKey: true }))).toBe(true)
    expect(isAutoFollowReleaseKey(keyEvent("Pause"))).toBe(true)
    expect(isAutoFollowReleaseKey(keyEvent("Break"))).toBe(true)
  })

  test("does not release auto-follow for keys that keep moving toward the bottom", () => {
    expect(isAutoFollowReleaseKey(keyEvent(" "))).toBe(false)
    expect(isAutoFollowReleaseKey(keyEvent("ArrowDown"))).toBe(false)
    expect(isAutoFollowReleaseKey(keyEvent("PageDown"))).toBe(false)
    expect(isAutoFollowReleaseKey(keyEvent("End"))).toBe(false)
  })

  test("ignores modified keyboard shortcuts", () => {
    expect(isAutoFollowReleaseKey(keyEvent("Home", { ctrlKey: true }))).toBe(false)
    expect(isAutoFollowReleaseKey(keyEvent("PageUp", { altKey: true }))).toBe(false)
    expect(isAutoFollowReleaseKey(keyEvent("ArrowUp", { metaKey: true }))).toBe(false)
  })

  test("detects middle-button pan intent in the chat scroll container", () => {
    const root = new MockElement()
    const child = new MockElement()
    root.appendChild(child)

    expect(isMiddleButtonAutoScrollIntent(root as unknown as HTMLElement, { button: 1, target: child as unknown as EventTarget })).toBe(true)
    expect(isMiddleButtonAutoScrollIntent(root as unknown as HTMLElement, { button: 0, target: child as unknown as EventTarget })).toBe(false)
  })

  test("lets nested scrollable regions consume middle-button pan intent", () => {
    const root = new MockElement()
    const nested = new MockElement()
    nested.scrollable = true
    const child = new MockElement()
    nested.appendChild(child)
    root.appendChild(nested)

    expect(isMiddleButtonAutoScrollIntent(root as unknown as HTMLElement, { button: 1, target: child as unknown as EventTarget })).toBe(false)
  })

  test("re-pins a released follower only when moving down or at the true bottom", () => {
    expect(shouldRepinReleasedAutoFollow(false, false)).toBe(false)
    expect(shouldRepinReleasedAutoFollow(true, false)).toBe(true)
    expect(shouldRepinReleasedAutoFollow(false, true)).toBe(true)
  })
})
