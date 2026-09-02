import { afterEach, describe, expect, test } from "bun:test"

import { ChildStoreManager } from "./child-store"
import { setSyncRefs, subscribeToInitialScopedDirectoryLoad } from "./sync-refs"

const DIRECTORY = "/workspace"

const deferred = () => {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const settleMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const managers: ChildStoreManager[] = []

const createManager = (directory: string): ChildStoreManager => {
  const manager = new ChildStoreManager()
  managers.push(manager)
  // SAFETY: `setSyncRefs` stores the SDK for other readers and never calls it here.
  setSyncRefs({} as never, manager, directory)
  return manager
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll()
  // SAFETY: same unused SDK slot; clears the scoped directory between tests.
  setSyncRefs({} as never, new ChildStoreManager(), "")
})

describe("subscribeToInitialScopedDirectoryLoad", () => {
  test("settles immediately when no directory is scoped", () => {
    createManager("")
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })

    expect(settles).toBe(1)
  })

  test("settles immediately for a loaded store with no bootstrap scheduled", () => {
    const manager = createManager(DIRECTORY)
    manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({ status: "complete" })
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })

    expect(settles).toBe(1)
  })

  test("settles when the scoped directory has a loading store but no demand scheduled", () => {
    const manager = createManager(DIRECTORY)
    const child = manager.ensureChild(DIRECTORY, { bootstrap: false })
    expect(child.getState().status).toBe("loading")
    expect(manager.getBootstrapState(DIRECTORY)).toBe(undefined)
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })

    expect(settles).toBe(1)
  })

  test("settles when a queued bootstrap loses its demand", () => {
    const manager = createManager(DIRECTORY)
    manager.setBootstrapDemand("owner", [
      { directory: DIRECTORY, priority: "selected", reason: "current-directory" },
    ])
    expect(manager.getBootstrapState(DIRECTORY)).toBe("queued")
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })
    expect(settles).toBe(0)

    manager.clearBootstrapDemand("owner")

    expect(manager.getBootstrapState(DIRECTORY)).toBe(undefined)
    expect(settles).toBe(1)
  })

  test("waits for the scoped bootstrap to complete", async () => {
    const manager = createManager(DIRECTORY)
    const bootstrap = deferred()
    manager.configure({ onBootstrap: () => bootstrap.promise })
    manager.requestBootstrap({ directory: DIRECTORY, priority: "selected", reason: "current-directory" })
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })
    expect(settles).toBe(0)

    bootstrap.resolve()
    await settleMicrotasks()

    expect(settles).toBe(1)
  })

  test("keeps waiting while the running bootstrap already reports a complete store", async () => {
    const manager = createManager(DIRECTORY)
    const bootstrap = deferred()
    manager.configure({
      onBootstrap: () => {
        // Directory bootstrap marks the store complete after its critical phase,
        // while the authoritative session-list request is still in flight.
        manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({ status: "complete" })
        return bootstrap.promise
      },
    })
    manager.requestBootstrap({ directory: DIRECTORY, priority: "selected", reason: "current-directory" })
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })
    await settleMicrotasks()
    expect(settles).toBe(0)

    bootstrap.resolve()
    await settleMicrotasks()

    expect(settles).toBe(1)
  })

  test("settles on a failed scoped bootstrap so global coverage is never stranded", async () => {
    const manager = createManager(DIRECTORY)
    const bootstrap = deferred()
    manager.configure({ onBootstrap: () => bootstrap.promise })
    manager.requestBootstrap({ directory: DIRECTORY, priority: "selected", reason: "current-directory" })
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })

    bootstrap.reject(new Error("opencode unreachable"))
    await settleMicrotasks()

    expect(settles).toBe(1)
  })

  test("settles once even as later bootstraps keep notifying", async () => {
    const manager = createManager(DIRECTORY)
    const scoped = deferred()
    const other = deferred()
    manager.configure({
      onBootstrap: (context) => (context.directory === DIRECTORY ? scoped.promise : other.promise),
    })
    manager.requestBootstrap({ directory: DIRECTORY, priority: "selected", reason: "current-directory" })
    let settles = 0

    subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })

    scoped.resolve()
    await settleMicrotasks()
    expect(settles).toBe(1)

    manager.requestBootstrap({ directory: "/other", priority: "background", reason: "known-project" })
    other.resolve()
    await settleMicrotasks()

    expect(settles).toBe(1)
  })

  test("does not settle after the caller cancels", async () => {
    const manager = createManager(DIRECTORY)
    const bootstrap = deferred()
    manager.configure({ onBootstrap: () => bootstrap.promise })
    manager.requestBootstrap({ directory: DIRECTORY, priority: "selected", reason: "current-directory" })
    let settles = 0

    const cancel = subscribeToInitialScopedDirectoryLoad(() => {
      settles += 1
    })
    cancel()

    bootstrap.resolve()
    await settleMicrotasks()

    expect(settles).toBe(0)
  })
})
