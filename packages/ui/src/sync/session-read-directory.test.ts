import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { resolveSessionReadDirectory, type SessionReadDirectorySources } from "./session-read-directory"

type Adoption = { sessionID: string; from: string; to: string }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const sources = (input: {
  known?: string | null
  read?: () => Promise<Pick<Session, "directory"> | null>
}) => {
  const adopted: Adoption[] = []
  let reads = 0
  const value: SessionReadDirectorySources = {
    knownDirectory: () => input.known ?? null,
    readUnscoped: () => {
      reads += 1
      return input.read ? input.read() : Promise.resolve(null)
    },
    adopt: (sessionID, from, to) => { adopted.push({ sessionID, from, to }) },
  }
  return { value, adopted, reads: () => reads }
}

// Mirrors captureRuntimeInstance: an owner survives neither a switch away nor
// a round trip back to the same runtime key.
const runtime = () => {
  let key = "A"
  let generation = 0
  return {
    capture: () => {
      const owner = { key, generation }
      return () => owner.key === key && owner.generation === generation
    },
    switchTo: (next: string) => {
      if (next !== key) generation += 1
      key = next
    },
  }
}

describe("resolveSessionReadDirectory", () => {
  test("adopts the directory the global record names when the caller selected another", async () => {
    const s = sources({ known: "/repo/moved" })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => true, s.value)).toBe("/repo/moved")
    expect(s.adopted).toEqual([{ sessionID: "ses_1", from: "/repo", to: "/repo/moved" }])
    expect(s.reads()).toBe(0)
  })

  test("adopts the directory the unscoped read names for a session the record does not list", async () => {
    const s = sources({ read: async () => ({ directory: "/repo/moved" }) })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => true, s.value)).toBe("/repo/moved")
    expect(s.adopted).toEqual([{ sessionID: "ses_1", from: "/repo", to: "/repo/moved" }])
  })

  test("adopts nothing when the directories differ only in their spelling", async () => {
    const known = sources({ known: "/repo/" })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => true, known.value)).toBe("/repo")
    expect(known.adopted).toEqual([])

    const read = sources({ read: async () => ({ directory: "/repo/" }) })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => true, read.value)).toBe("/repo")
    expect(read.adopted).toEqual([])
  })

  test("keeps the selected directory when the unscoped read fails", async () => {
    const s = sources({ read: async () => { throw new Error("offline") } })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => true, s.value)).toBe("/repo")
    expect(s.adopted).toEqual([])
  })

  test("a read that finishes after a switch to another runtime adopts nothing", async () => {
    const r = runtime()
    const pending = deferred<Pick<Session, "directory"> | null>()
    const s = sources({ read: () => pending.promise })
    const result = resolveSessionReadDirectory("ses_1", "/repo", r.capture(), s.value)

    r.switchTo("B")
    pending.resolve({ directory: "/repo/moved" })

    expect(await result).toBeNull()
    expect(s.adopted).toEqual([])
  })

  test("a read that finishes after a round trip back to the same runtime adopts nothing", async () => {
    const r = runtime()
    const pending = deferred<Pick<Session, "directory"> | null>()
    const s = sources({ read: () => pending.promise })
    const result = resolveSessionReadDirectory("ses_1", "/repo", r.capture(), s.value)

    r.switchTo("B")
    r.switchTo("A")
    pending.resolve({ directory: "/repo/moved" })

    expect(await result).toBeNull()
    expect(s.adopted).toEqual([])
  })

  test("a retired caller neither adopts nor reads", async () => {
    const s = sources({ known: "/repo/moved" })
    expect(await resolveSessionReadDirectory("ses_1", "/repo", () => false, s.value)).toBeNull()
    expect(s.adopted).toEqual([])
    expect(s.reads()).toBe(0)
  })
})
