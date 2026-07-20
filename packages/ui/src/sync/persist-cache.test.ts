import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { persistSessions, readDirCache } from "./persist-cache"
import { getSyncPerformanceDiagnostics, setSyncPerformanceDiagnosticsEnabled } from "./performance-diagnostics"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  maxValueLength = Number.POSITIVE_INFINITY
  writes = 0

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    if (value.length > this.maxValueLength) throw new DOMException("Quota exceeded", "QuotaExceededError")
    this.writes += 1
    this.values.set(key, value)
  }
}

const originalLocalStorage = globalThis.localStorage
const directory = "/repo"
let storage: TestStorage
const waitForPersistence = () => new Promise((resolve) => setTimeout(resolve, 70))

const hashCode = (value: string): string => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

const legacySessionKey = (value: string): string => {
  const head = value.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.${head}.${hashCode(value)}.sessions`
}

const session = (
  index: number,
  updated: number,
  title = `Session ${index}`,
  sessionDirectory = directory,
): Session => ({
  id: `ses_${String(index).padStart(3, "0")}`,
  projectID: "project",
  directory: sessionDirectory,
  title,
  version: "1",
  time: { created: updated - 1, updated },
} as Session)

beforeEach(() => {
  storage = new TestStorage()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-default.test", runtimeKey: "runtime-default" })
})

afterEach(() => {
  setSyncPerformanceDiagnosticsEnabled(false)
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage })
})

describe("persisted directory sessions", () => {
  test("keeps the 50 most recently updated sessions across restart reads", async () => {
    const sessions = Array.from({ length: 60 }, (_, updated) => session(59 - updated, updated))

    persistSessions(directory, sessions)
    await waitForPersistence()

    const cached = readDirCache(directory).sessions ?? []
    const cachedIds = new Set(cached.map((item) => item.id))
    const expectedIds = new Set(Array.from({ length: 50 }, (_, index) => session(index, index).id))
    expect(cached).toHaveLength(50)
    expect(cachedIds).toEqual(expectedIds)
  })

  test("persists authoritative empty instead of resurrecting legacy sessions", () => {
    const legacyKey = legacySessionKey(directory)
    storage.setItem(legacyKey, JSON.stringify([session(1, 1)]))

    persistSessions(directory, [])

    expect(readDirCache(directory).sessions).toEqual([])
    expect(storage.getItem(legacyKey)).toBeNull()
  })

  test("replaces stale data with a smaller recent snapshot when quota is tight", async () => {
    persistSessions(directory, [session(1, 1, "old")])
    await waitForPersistence()
    storage.maxValueLength = 700
    const sessions = Array.from({ length: 50 }, (_, index) => session(index + 10, index + 10, "x".repeat(80)))

    persistSessions(directory, sessions)
    await waitForPersistence()

    const cached = readDirCache(directory).sessions ?? []
    expect(cached.length).toBeGreaterThan(0)
    expect(cached.length).toBeLessThan(50)
    expect(cached.some((item) => item.title === "old")).toBe(false)
    expect(cached.map((item) => item.id)).toEqual(sessions.slice(-cached.length).map((item) => item.id))
  })

  test("isolates snapshots by runtime and directory", async () => {
    const otherDirectory = "/other-repo"
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-a.test", runtimeKey: "runtime-a" })
    persistSessions(directory, [session(1, 1, "runtime A")])
    persistSessions(otherDirectory, [session(2, 2, "other directory", otherDirectory)])
    await waitForPersistence()

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-b.test", runtimeKey: "runtime-b" })
    persistSessions(directory, [session(3, 3, "runtime B")])
    await waitForPersistence()

    expect(readDirCache(directory).sessions?.map((item) => item.title)).toEqual(["runtime B"])
    expect(readDirCache(otherDirectory).sessions).toBe(undefined)

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-a.test", runtimeKey: "runtime-a" })
    expect(readDirCache(directory).sessions?.map((item) => item.title)).toEqual(["runtime A"])
    expect(readDirCache(otherDirectory).sessions?.map((item) => item.title)).toEqual(["other directory"])
  })

  test("coalesces burst updates per runtime and directory while serving the latest pending value", async () => {
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-coalesce.test", runtimeKey: "runtime-coalesce" })
    const writesBefore = storage.writes
    setSyncPerformanceDiagnosticsEnabled(true)

    for (let index = 0; index < 100; index += 1) {
      persistSessions(directory, [session(index, index)])
    }

    expect(readDirCache(directory).sessions?.[0]?.id).toBe(session(99, 99).id)
    expect(storage.writes).toBe(writesBefore)
    await waitForPersistence()
    expect(storage.writes - writesBefore).toBe(1)
    expect(readDirCache(directory).sessions?.[0]?.id).toBe(session(99, 99).id)
    expect(getSyncPerformanceDiagnostics()?.persistenceSerializations).toBe(1)
    expect(getSyncPerformanceDiagnostics()?.persistenceStorageWrites).toBe(1)
  })

  test("writes authoritative empty immediately and prevents an older pending snapshot from returning", async () => {
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-empty.test", runtimeKey: "runtime-empty" })
    persistSessions(directory, [session(1, 1)])
    persistSessions(directory, [])

    expect(readDirCache(directory).sessions).toEqual([])
    await waitForPersistence()
    expect(readDirCache(directory).sessions).toEqual([])
  })

  test("does not commit a pending snapshot after its runtime is no longer active", async () => {
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-stale-a.test", runtimeKey: "runtime-stale-a" })
    persistSessions(directory, [session(1, 1, "runtime stale A")])
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-stale-b.test", runtimeKey: "runtime-stale-b" })

    await waitForPersistence()
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-stale-a.test", runtimeKey: "runtime-stale-a" })
    expect(readDirCache(directory).sessions).toBe(undefined)
  })
})
