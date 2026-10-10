import { opencodeClient } from '@/lib/opencode/client';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { switchRuntimeEndpoint } from "@/lib/runtime-switch"
import {
  flushPendingSessionWrites,
  persistGlobalSessionSnapshot,
  persistManagedChatSessions,
  persistSessions,
  readDirCache,
  readGlobalSessionSnapshot,
  readManagedChatSessions,
} from "./persist-cache"
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
// Writes are throttled to one per 2 s; lifecycle suspension flushes them.
const waitForPersistence = async () => flushPendingSessionWrites()

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
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: updated - 1, updated },
})

beforeEach(async () => {
  storage = new TestStorage()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-default.test", runtimeKey: "runtime-default" })
  const originalHomeInfo = opencodeClient.getFilesystemHomeInfo
  opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' })
  await ensureChatsRootDirectory()
  opencodeClient.getFilesystemHomeInfo = originalHomeInfo
})

afterEach(() => {
  setSyncPerformanceDiagnosticsEnabled(false)
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage })
})

describe("persisted directory sessions", () => {
  test("keeps one runtime-scoped startup snapshot for managed chats", async () => {
    const chat = session(1, 2, "Chat", "/home/user/.config/openchamber/chats/2026-08-21/session-a")
    persistManagedChatSessions([session(2, 3), chat])
    await waitForPersistence()

    expect(readManagedChatSessions().map((item) => item.id)).toEqual([chat.id])

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-other.test", runtimeKey: "runtime-other" })
    expect(readManagedChatSessions()).toEqual([])
  })

  test("coalesces a continuing burst into one trailing session write", async () => {
    persistSessions(directory, [session(1, 1)])
    await new Promise((resolve) => setTimeout(resolve, 30))
    persistSessions(directory, [session(1, 2)])
    await waitForPersistence()

    expect(storage.writes).toBe(1)
    expect(readDirCache(directory).sessions?.[0]?.time.updated).toBe(2)
  })

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

  test("drops cached records another build wrote without the fields the stores read", () => {
    const key = `${storage.key(0) ?? ""}`
    persistSessions(directory, [session(1, 1)])
    const written = [...storage.values.keys()].find((item) => item.endsWith(".sessions")) ?? key
    const stale = { ...session(2, 2), time: undefined }
    storage.setItem(written, JSON.stringify([session(1, 1), stale, { id: "ses_003" }, "junk"]))

    expect(readDirCache(directory).sessions?.map((item) => item.id)).toEqual(["ses_001"])
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

/** A session as OpenCode serves it: usage, a permission ruleset, and a session-assist recap. */
const fullSession = (index: number, updated: number, sessionDirectory = directory, parentID?: string): Session => ({
  id: `ses_${String(index).padStart(3, "0")}`,
  ...(parentID ? { parentID } : {}),
  projectID: "4f8e2a91c7d3b6e0a5f1c8d2e9b7a3f6c1d4e8b2",
  directory: sessionDirectory,
  title: `Fix the sidebar seed for worktree sessions ${index}`,
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-4-5", variant: "high" },
  cost: 1.234567,
  tokens: { input: 123456, output: 23456, reasoning: 3456, cache: { read: 456789, write: 56789 } },
  outcome: "succeeded",
  time: { created: updated - 1000, updated, idle: updated },
  metadata: {
    openchamber: {
      work: { state: "open", openedAt: updated - 900, openedBy: "user" },
      assist: {
        recap: "Investigated why the sidebar paints only managed chats on launch. ".repeat(6),
        suggestion: "Persist a bounded global snapshot and seed the store from it at module init.",
        forMessageID: "msg_0123456789abcdef",
        generatedAt: updated,
      },
    },
  },
  permissions: Array.from({ length: 40 }, (_, rule) => ({
    action: ["bash", "edit", "read", "webfetch", "task"][rule % 5] ?? "bash",
    resource: `/Users/someone/projects/repository-${rule}/**/*.{ts,tsx,js,jsx,json,md}`,
    effect: rule % 3 === 0 ? "deny" : "allow",
  })),
})

describe("persisted session projection", () => {
  test("writes only what the sidebar paints and reports the size saved", async () => {
    const sessions = Array.from({ length: 50 }, (_, index) => fullSession(index, 1_000_000 + index))
    const fullChars = JSON.stringify(sessions).length

    persistSessions(directory, sessions)
    await waitForPersistence()

    const written = [...storage.values.entries()].find(([key]) => key.endsWith(".sessions"))?.[1] ?? ""
    console.info(`[persist-cache] 50 sessions: full ${fullChars} chars, persisted ${written.length} chars`)
    expect(written.length).toBeLessThan(fullChars / 2)
    const [cached] = readDirCache(directory).sessions ?? []
    expect(cached).not.toHaveProperty("permissions")
    expect(cached).not.toHaveProperty("tokens")
    expect(cached).not.toHaveProperty("cost")
    expect(cached?.metadata).toEqual({ openchamber: { work: { state: "open", openedAt: 999_100, openedBy: "user" } } })
    expect(cached?.model).toEqual(sessions[0]?.model)
  })

  test("still reads full records an older build wrote", () => {
    persistSessions(directory, [session(1, 1)])
    flushPendingSessionWrites()
    const key = [...storage.values.keys()].find((item) => item.endsWith(".sessions")) ?? ""
    storage.setItem(key, JSON.stringify([fullSession(7, 7)]))

    expect(readDirCache(directory).sessions?.map((item) => item.id)).toEqual(["ses_007"])
  })

  test("writes at most once per throttle interval and skips an unchanged projection", async () => {
    persistSessions(directory, [session(1, 1)])
    persistSessions(directory, [session(1, 2)])
    expect(storage.writes).toBe(0)
    await waitForPersistence()
    expect(storage.writes).toBe(1)

    // Usage changes alone leave the persisted projection as it was.
    persistSessions(directory, [{ ...session(1, 2), cost: 5 }])
    await waitForPersistence()
    expect(storage.writes).toBe(1)
  })
})

describe("persisted global session snapshot", () => {
  test("keeps the most recent sessions and the ancestors of kept children", async () => {
    const oldParent = fullSession(0, 1, "/repo-a")
    const sessions = [
      oldParent,
      ...Array.from({ length: 249 }, (_, index) => fullSession(index + 1, 10 + index, `/repo-${index % 7}`)),
      fullSession(999, 100_000, "/repo-b", oldParent.id),
    ]

    persistGlobalSessionSnapshot(sessions)
    await waitForPersistence()

    const seeded = readGlobalSessionSnapshot()
    const ids = new Set(seeded.map((item) => item.id))
    expect(ids.has("ses_999")).toBe(true)
    expect(ids.has(oldParent.id)).toBe(true)
    expect(seeded).toHaveLength(201)
    const written = [...storage.values.entries()].find(([key]) => key.startsWith("oc.global-sessions."))?.[1] ?? ""
    console.info(`[persist-cache] global snapshot of 200 sessions: ${written.length} chars`)
  })

  test("leaves out archived sessions and managed chats", async () => {
    const chat = fullSession(1, 5, "/home/user/.config/openchamber/chats/2026-08-21/session-a")
    const archived = { ...fullSession(2, 6), time: { created: 1, updated: 6, archived: 7 } }
    persistGlobalSessionSnapshot([chat, archived, fullSession(3, 7, "/repo-worktree")])
    await waitForPersistence()

    expect(readGlobalSessionSnapshot().map((item) => item.id)).toEqual(["ses_003"])
  })

  test("is scoped to its runtime", async () => {
    persistGlobalSessionSnapshot([fullSession(1, 1)])
    await waitForPersistence()

    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-other.test", runtimeKey: "runtime-other" })
    expect(readGlobalSessionSnapshot()).toEqual([])
    switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-default.test", runtimeKey: "runtime-default" })
    expect(readGlobalSessionSnapshot().map((item) => item.id)).toEqual(["ses_001"])
  })

  test("drops a corrupt snapshot", async () => {
    persistGlobalSessionSnapshot([fullSession(1, 1)])
    await waitForPersistence()
    const key = [...storage.values.keys()].find((item) => item.startsWith("oc.global-sessions.")) ?? ""

    storage.setItem(key, "{not json")
    expect(readGlobalSessionSnapshot()).toEqual([])
    expect(storage.getItem(key)).toBeNull()

    storage.setItem(key, JSON.stringify({ version: 1, runtimeKey: "runtime-default", sessions: [{ id: "ses_x" }, fullSession(2, 2)] }))
    expect(readGlobalSessionSnapshot().map((item) => item.id)).toEqual(["ses_002"])
  })

  test("falls back to fewer sessions when quota is tight", async () => {
    storage.maxValueLength = 30_000
    persistGlobalSessionSnapshot(Array.from({ length: 200 }, (_, index) => fullSession(index, index + 1)))
    await waitForPersistence()

    const seeded = readGlobalSessionSnapshot()
    expect(seeded.length).toBeGreaterThan(0)
    expect(seeded.length).toBeLessThan(200)
    expect(seeded.every((item) => Number(item.id.slice(4)) >= 200 - seeded.length)).toBe(true)
  })
})
