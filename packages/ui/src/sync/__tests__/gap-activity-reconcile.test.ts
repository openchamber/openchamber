import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Session, SessionStatus } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "../child-store"
import { reconcileActivityAfterGap } from "../sync-context"
import { applyGlobalSessionStatusEvent, reconcileGlobalSessionStatusWithActive, replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from "../global-session-status"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"

// Only the directory being worked in has a store; every other project's rows
// read the cross-directory status index. A turn that ends while the stream is
// down sends its idle once, so after the gap that index has to be re-read.

const session = (id: string, directory: string): Session => ({
  id, directory, projectID: "project", title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const busy = (sessionID: string): SyncEvent => ({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
const idle = (sessionID: string): SyncEvent => ({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })

const SPACE = "/spaces/a1b2c3d4e5f6/app"
const originalActiveStatuses = opencodeClient.getActiveSessionStatuses
const originalHostSnapshot = opencodeClient.getHostSessionStatusSnapshot
const running = (): string[] => [...useGlobalSessionStatusStore.getState().activeSessionIds].sort()

describe("activity after a stream gap", () => {
  let childStores: ChildStoreManager
  let answer: () => Promise<Record<string, SessionStatus> | null>
  // Whether the host says a replaced OpenCode is still running the turns busy at its handoff.
  let openCodeDraining: boolean

  beforeEach(() => {
    childStores = new ChildStoreManager()
    useGlobalSessionsStore.getState().applySnapshot([
      session("ses_ended", "/far"),
      session("ses_still", "/far"),
      session("ses_started", "/other"),
      session("ses_space", SPACE),
    ], [], "ready")
    replaceGlobalSessionStatusById(new Map())
    applyGlobalSessionStatusEvent("/far", busy("ses_ended"))
    applyGlobalSessionStatusEvent("/far", busy("ses_still"))
    applyGlobalSessionStatusEvent(SPACE, busy("ses_space"))
    answer = async () => ({ ses_still: { type: "busy" }, ses_started: { type: "busy" } })
    opencodeClient.getActiveSessionStatuses = () => answer()
    openCodeDraining = false
    opencodeClient.getHostSessionStatusSnapshot = async () => ({ serverTime: 1, sessions: {}, openCodeDraining })
  })

  afterEach(() => {
    opencodeClient.getActiveSessionStatuses = originalActiveStatuses
    opencodeClient.getHostSessionStatusSnapshot = originalHostSnapshot
    childStores.disposeAll()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    replaceGlobalSessionStatusById(new Map())
  })

  test("settles turns that ended and raises turns that began in unopened directories", async () => {
    await reconcileActivityAfterGap(childStores)
    // One miss cannot end a turn: OpenCode leaves a turn it resumes after a
    // restart off the list until its drain starts again.
    expect(running()).toEqual(["ses_ended", "ses_space", "ses_started", "ses_still"])

    await reconcileActivityAfterGap(childStores)
    // The space's session is not in the host's list, which proves nothing about it.
    expect(running()).toEqual(["ses_space", "ses_started", "ses_still"])
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_started")?.directory).toBe("/other")
  })

  test("a status written while the list is read is newer than its answer", async () => {
    // A first read already missed ses_still, so the next miss would settle it.
    answer = async () => ({ ses_ended: { type: "busy" } })
    await reconcileActivityAfterGap(childStores)
    expect(running()).toEqual(["ses_ended", "ses_space", "ses_still"])

    let release: () => void = () => undefined
    const read = new Promise<void>((resolve) => { release = resolve })
    answer = async () => {
      await read
      return { ses_ended: { type: "busy" } }
    }

    const reconcile = reconcileActivityAfterGap(childStores)
    // ses_ended finished and ses_still started its next step after OpenCode answered.
    applyGlobalSessionStatusEvent("/far", idle("ses_ended"))
    applyGlobalSessionStatusEvent("/far", busy("ses_still"))
    release()
    await reconcile

    expect(running()).toEqual(["ses_space", "ses_still"])
  })

  test("raises turns that began during the gap while another running-list read is pending", async () => {
    let finishOther: () => void = () => undefined
    const other = reconcileGlobalSessionStatusWithActive(
      () => new Promise((resolve) => { finishOther = () => resolve(null) }),
      () => true,
    )
    await reconcileActivityAfterGap(childStores)
    expect(running()).toEqual(["ses_ended", "ses_space", "ses_started", "ses_still"])
    finishOther()
    await other
  })

  test("a draining OpenCode's list settles nothing", async () => {
    openCodeDraining = true
    await reconcileActivityAfterGap(childStores)
    expect(running()).toEqual(["ses_ended", "ses_space", "ses_still"])
  })

  test("a failed read changes nothing", async () => {
    answer = async () => null
    await reconcileActivityAfterGap(childStores)
    expect(running()).toEqual(["ses_ended", "ses_space", "ses_still"])
  })
})
