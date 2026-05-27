import { describe, expect, test } from "bun:test"
import { tagServerEvent, unwrapServerEvent, type ServerTagged } from "./server-tagged"

describe("tagServerEvent", () => {
  test("wraps payload with serverId", () => {
    const event = { type: "session.created", foo: 1 }
    const tagged = tagServerEvent(event, "remote-1")
    expect(tagged.serverId).toBe("remote-1")
    expect(tagged.type).toBe("session.created")
    expect(tagged.foo).toBe(1)
  })

  test("returns distinct object without mutating original", () => {
    const event = { type: "test" }
    const tagged = tagServerEvent(event, "s1")
    expect(tagged === (event as unknown)).toBe(false)
    expect((event as Record<string, unknown>).serverId === undefined).toBe(true)
  })
})

describe("unwrapServerEvent", () => {
  test("extracts serverId + event from ServerTagged", () => {
    const tagged: ServerTagged<{ type: string }> = { type: "hello", serverId: "srv-1" }
    const { serverId, event } = unwrapServerEvent(tagged)
    expect(serverId).toBe("srv-1")
    expect(event.type).toBe("hello")
  })

  test("does not include serverId in extracted event", () => {
    const tagged: ServerTagged<Record<string, unknown>> = { type: "x", serverId: "srv-2", extra: true }
    const { event } = unwrapServerEvent(tagged)
    expect((event as Record<string, unknown>).serverId === undefined).toBe(true)
  })

  test("throws on missing serverId", () => {
    const tagged = { type: "nope" } as unknown as ServerTagged<{ type: string }>
    let threw = false
    try { unwrapServerEvent(tagged) } catch { threw = true }
    expect(threw).toBe(true)
  })

  test("throws on null input", () => {
    let threw = false
    try { unwrapServerEvent(null as unknown as ServerTagged<unknown>) } catch { threw = true }
    expect(threw).toBe(true)
  })

  test("throws on undefined input", () => {
    let threw = false
    try { unwrapServerEvent(undefined as unknown as ServerTagged<unknown>) } catch { threw = true }
    expect(threw).toBe(true)
  })

  test("throws on non-object input", () => {
    let threw = false
    try { unwrapServerEvent("string" as unknown as ServerTagged<unknown>) } catch { threw = true }
    expect(threw).toBe(true)
  })

  test("throws on non-ServerTagged object (no serverId property)", () => {
    const plain = { type: "plain" } as unknown as ServerTagged<{ type: string }>
    let threw = false
    try { unwrapServerEvent(plain) } catch { threw = true }
    expect(threw).toBe(true)
  })
})
