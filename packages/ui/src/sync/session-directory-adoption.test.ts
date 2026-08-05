import { beforeEach, describe, expect, test } from "bun:test"

import { ChildStoreManager } from "./child-store"
import { setSyncRefs } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"

/**
 * Selecting a session whose directory this client has not indexed yet routes it
 * through the active directory as a deliberate guess. Nothing used to settle
 * that guess once the owning directory finished bootstrapping, so every fetch
 * stayed addressed to a directory that does not own the session and the session
 * never rendered.
 *
 * These tests pin both directions: a guess is promoted once the authoritative
 * directory becomes readable, and a confirmed selection is never rewritten.
 */

const PARENT = "/repo"
const WORKTREE = "/repo/.worktrees/feature"
const SESSION_ID = "ses_directory_adoption"

const indexSessionIn = (
  manager: ChildStoreManager,
  directory: string,
  recordDirectory: string = directory,
): void => {
  const store = manager.ensureChild(directory, { bootstrap: false })
  store.setState({
    session: [{ id: SESSION_ID, directory: recordDirectory, title: "test" } as never],
  })
}

let manager: ChildStoreManager

beforeEach(() => {
  manager = new ChildStoreManager()
  setSyncRefs({} as never, manager, PARENT)
  useSessionUIStore.getState().setCurrentSession(null)
})

describe("adoptAuthoritativeSessionDirectory", () => {
  test("promotes a guessed selection once the owning directory is indexed", () => {
    useSessionUIStore.getState().setCurrentSession(SESSION_ID)
    expect(useSessionUIStore.getState().currentSessionDirectory).not.toBe(WORKTREE)

    indexSessionIn(manager, WORKTREE)
    useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE)
  })

  test("believes the session record over the store that merely holds it", () => {
    // A project's session list includes the sessions of its worktrees so the
    // sidebar can group them, so the parent store holds this session while the
    // session itself reports the worktree. Ownership comes from the record.
    useSessionUIStore.getState().setCurrentSession(SESSION_ID)
    indexSessionIn(manager, PARENT, WORKTREE)

    useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE)
  })

  test("does nothing while the owning directory is still unknown", () => {
    useSessionUIStore.getState().setCurrentSession(SESSION_ID)
    const before = useSessionUIStore.getState().currentSessionDirectory

    useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(before)
  })

  test("never rewrites a selection that was confirmed at selection time", () => {
    useSessionUIStore.getState().setCurrentSession(SESSION_ID, WORKTREE)
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE)

    // A different directory claiming the session must not move a confirmed
    // selection: the confirmed value outranks anything sync learns later.
    indexSessionIn(manager, PARENT)
    useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()

    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE)
  })

  test("is a no-op for a session that is no longer selected", () => {
    useSessionUIStore.getState().setCurrentSession(SESSION_ID)
    indexSessionIn(manager, WORKTREE)
    useSessionUIStore.getState().setCurrentSession("ses_other")

    // Whatever the new selection resolved to, a late adoption for the previous
    // session must not touch it.
    const before = useSessionUIStore.getState().currentSessionDirectory
    useSessionUIStore.getState().adoptAuthoritativeSessionDirectory(SESSION_ID)

    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_other")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(before)
  })
})
