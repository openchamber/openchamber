import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import { opencodeClient } from "@/lib/opencode/client"
import type { FormRequest, Session } from "@/lib/opencode/model"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"
import { getBackgroundNetworkState, runBackgroundNetworkTask } from "../lib/background-network"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

const location = spyOn(opencodeClient, "getLocation")
const config = spyOn(opencodeClient, "getConfig")
const statuses = spyOn(opencodeClient, "getActiveSessionStatuses")
const commands = spyOn(opencodeClient, "listCommands")
const mcp = spyOn(opencodeClient, "listMcpServers")
const vcs = spyOn(opencodeClient, "getVcs")
const forms = spyOn(opencodeClient, "listPendingForms")
const permissions = spyOn(opencodeClient, "listPendingPermissions")
// `commands` and `mcp` are spied so the regression test can assert bootstrap
// never touches them; they are not part of directory initialization.
const spies = [location, config, statuses, vcs, forms, permissions]

beforeEach(() => {
  for (const spy of [...spies, commands, mcp]) spy.mockReset()
  location.mockImplementation(async (directory) => ({
    directory: directory ?? "/repo",
    project: { id: "project-a", directory: directory ?? "/repo", canonical: directory ?? "/repo" },
  }))
  config.mockResolvedValue({})
  statuses.mockResolvedValue({})
  commands.mockResolvedValue([])
  mcp.mockResolvedValue([])
  vcs.mockResolvedValue({ branch: "main" })
  forms.mockResolvedValue([])
  permissions.mockResolvedValue([])
})

afterEach(() => {
  expect(getBackgroundNetworkState().active).toBe(0)
})

const inputFor = (state: Partial<State> = {}) => {
  const store = createStore<State>(() => ({ ...INITIAL_STATE, ...state }))
  return {
    directory: "/repo", store,
    set: (patch: Partial<State>) => { store.setState(patch) },
    global: { config: {}, projects: [], path: { directory: "", worktree: "", home: "/home" } },
    loadSessions: async () => undefined,
  }
}

const form = (id: string, title = "Pick"): FormRequest => ({
  id, sessionID: "session", title, fields: [{ key: "answer", type: "boolean" }],
})

describe("bootstrapDirectory", () => {
  test("finishes session loading while the config read is unresolved", async () => {
    const blocked = deferred<void>()
    config.mockImplementation(async () => { await blocked.promise; return {} })
    const input = inputFor()
    let initialized = false
    const bootstrap = bootstrapDirectory(input)
    void bootstrap.environment.then(() => { initialized = true })
    try {
      expect(await bootstrap.sessions).toBe("complete")
      expect(initialized).toBe(false)
      expect(input.store.getState().status).toBe("partial")
    } finally {
      blocked.resolve()
      expect(await bootstrap.environment).toBe("complete")
      expect(input.store.getState().status).toBe("complete")
    }
  })

  test("keeps session-list failure separate from successful environment initialization", async () => {
    const cached: Session[] = [{
      id: "cached", projectID: "project-a", directory: "/repo", title: "Cached",
      time: { created: 1, updated: 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }]
    const input = inputFor({ session: cached })
    const bootstrap = bootstrapDirectory({ ...input, loadSessions: async () => { throw new Error("unavailable") } })
    expect(await bootstrap.sessions).toBe("failed")
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().session).toBe(cached)
  })

  test("a config failure cannot suppress status or pending-form recovery", async () => {
    config.mockRejectedValue(Object.assign(new Error("invalid config"), { status: 400 }))
    const pending = form("pending")
    forms.mockResolvedValue([pending])
    const input = inputFor()
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("failed")
    expect(input.store.getState().form.session).toEqual([pending])
    expect(input.store.getState().sessionStatusReady).toBe(true)
  })

  test("a failed status snapshot preserves live state and does not grant idle authority", async () => {
    const previous: State["session_status"] = { session: { type: "busy" } }
    statuses.mockResolvedValue(null)
    const input = inputFor({ session_status: previous })
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("failed")
    expect(input.store.getState().session_status).toBe(previous)
    expect(input.store.getState().sessionStatusReady).toBeUndefined()
  })

  test("optional VCS failure preserves its previous state without failing core initialization", async () => {
    vcs.mockRejectedValue(Object.assign(new Error("VCS unavailable"), { status: 400 }))
    const previous: State["vcs"] = { branch: "main" }
    const input = inputFor({ vcs: previous })
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().vcs).toBe(previous)
  })

  test("never reads MCP-initializing endpoints during directory initialization", async () => {
    // Reading MCP status initializes the directory's entire stdio server
    // fleet, and listing commands enumerates MCP prompts, which touches the
    // same state. Bootstrap used to run for every known project directory, so
    // either read spawned a fleet per project at startup. MCP and command
    // surfaces fetch on demand instead.
    const input = inputFor()
    const bootstrap = bootstrapDirectory(input)
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("complete")
    expect(mcp.mock.calls).toHaveLength(0)
    expect(commands.mock.calls).toHaveLength(0)
  })

  test("rejects stale work before starting either phase", async () => {
    const input = inputFor()
    const state = input.store.getState()
    let lists = 0
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => true, loadSessions: async () => { lists += 1 } })
    expect(await bootstrap.sessions).toBe("stale")
    expect(await bootstrap.environment).toBe("stale")
    expect(lists).toBe(0)
    for (const spy of spies) expect(spy.mock.calls).toHaveLength(0)
    expect(input.store.getState()).toBe(state)
  })

  test("drops queued initialization reads after the directory generation changes", async () => {
    const blocked = Array.from({ length: getBackgroundNetworkState().limit }, () => deferred<void>())
    const occupied = blocked.map((task) => runBackgroundNetworkTask(() => task.promise))
    let stale = false
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => stale })
    expect(await bootstrap.sessions).toBe("complete")
    stale = true
    const state = input.store.getState()
    for (const task of blocked) task.resolve()
    await Promise.all(occupied)
    expect(await bootstrap.environment).toBe("stale")
    for (const spy of spies) expect(spy.mock.calls).toHaveLength(0)
    expect(input.store.getState()).toBe(state)
  })

  test("an in-flight response cannot commit after its initialization is superseded", async () => {
    const response = deferred<State["config"]>()
    const started = deferred<void>()
    let stale = false
    config.mockImplementation(() => { started.resolve(); return response.promise })
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, isStale: () => stale })
    await bootstrap.sessions
    await started.promise
    stale = true
    const state = input.store.getState()
    response.resolve({ instructions: ["old configuration"] })
    expect(await bootstrap.environment).toBe("stale")
    expect(input.store.getState()).toBe(state)
  })

  test("addresses directory reads explicitly and keeps v2 active-status discovery global", async () => {
    for (const directory of ["/workspace/Alpha", "C:/Users/Developer/Tree", "//Server/Share/Project", "C:/Users/Ірина/Project with spaces/100%", "C:/"]) {
      for (const spy of spies) spy.mock.calls.length = 0
      const input = { ...inputFor(), directory }
      const bootstrap = bootstrapDirectory(input)
      expect(await bootstrap.sessions).toBe("complete")
      expect(await bootstrap.environment).toBe("complete")
      for (const spy of [location, config, vcs]) expect(spy.mock.calls).toEqual([[directory]])
      for (const spy of [forms, permissions]) expect(spy.mock.calls).toEqual([[{ directories: [directory], includeGlobal: false }]])
      expect(statuses.mock.calls).toEqual([[]])
      expect(input.store.getState().path.directory).toBe(directory)
    }
  })

  test("an authoritative empty form list clears old records", async () => {
    const input = inputFor({ form: { session: [form("old")] } })
    const bootstrap = bootstrapDirectory(input)
    await bootstrap.sessions
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().form).toEqual({})
  })

  test("failed form recovery preserves previous forms", async () => {
    const previous = { session: [form("old")] }
    forms.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 400 }))
    const input = inputFor({ form: previous })
    const bootstrap = bootstrapDirectory(input)
    await bootstrap.sessions
    expect(await bootstrap.environment).toBe("failed")
    expect(input.store.getState().form).toBe(previous)
  })

  test("retries transient form failures without replaying the session list", async () => {
    let lists = 0
    const pending = form("pending")
    forms.mockRejectedValueOnce(Object.assign(new Error("warming up"), { status: 503 })).mockResolvedValue([pending])
    const input = inputFor()
    const bootstrap = bootstrapDirectory({ ...input, loadSessions: async () => { lists += 1 } })
    expect(await bootstrap.sessions).toBe("complete")
    expect(await bootstrap.environment).toBe("complete")
    expect(forms.mock.calls).toHaveLength(2)
    expect(lists).toBe(1)
    expect(input.store.getState().form.session).toEqual([pending])
  })

  test("fetched forms replace unchanged records and retain same-session live additions", async () => {
    const old = form("form-1")
    const added = form("form-2")
    const updated = form("form-1", "Updated")
    const input = inputFor({ form: { session: [old] } })
    forms.mockImplementation(async () => {
      input.store.setState({ form: { session: [old, added] } })
      return [updated]
    })
    const bootstrap = bootstrapDirectory(input)
    await bootstrap.sessions
    expect(await bootstrap.environment).toBe("complete")
    expect(input.store.getState().form.session).toEqual([updated, added])
  })
})
