import { normalizePath } from "@/lib/pathNormalization"
import { normalizeProjectPath } from "@/lib/projectResolution"
import type { WorktreeMetadata } from "@/types/worktree"
import { directoriesWithRunningShells } from "./background-shells"
import { useGlobalSessionStatusStore } from "./global-session-status"
import type { State } from "./types"

// OpenCode 2 keeps a location for every directory it serves, and each location
// runs its own copy of the user's local MCP servers until OpenCode's hour-long
// inactivity sweep. Once the user has left a managed chat or a worktree and
// nothing runs there, ask OpenCode to drop that location sooner. Project roots
// are never released: the user returns to them most, and the server keeps
// reading the last-used one.

/** Long enough that flicking between chats does not restart their MCP servers. */
export const CHAT_LOCATION_RELEASE_DELAY_MS = 30_000

/**
 * Worktrees are a place the user works in and comes back to through the day,
 * and coming back after a release waits for the MCP servers to start again.
 */
export const WORKTREE_LOCATION_RELEASE_DELAY_MS = 5 * 60_000

type Timers<T> = {
  set: (run: () => void, ms: number) => T
  clear: (timer: T) => void
}

const realTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
}

/**
 * `busy`: work or a question for the user still holds the location.
 * `unknown`: this window cannot see the directory's sessions, so it leaves
 * the location to OpenCode's own sweep.
 */
export type DirectoryUse = "free" | "busy" | "unknown"

type LocationReleaseDeps<T> = {
  /** How long after leaving `directory` to release it; null never releases it. */
  releaseDelayMs: (directory: string) => number | null
  isCurrentDirectory: (directory: string) => boolean
  directoryUse: (directory: string) => DirectoryUse
  release: (directory: string) => Promise<void>
  timers: Timers<T>
}

export type LocationRelease = {
  /** The user moved from `previous` to `next`. */
  directoryChanged: (previous: string | null | undefined, next: string | null | undefined) => void
  dispose: () => void
}

export function createLocationRelease<T>(deps: LocationReleaseDeps<T>): LocationRelease {
  const { timers } = deps
  const pending = new Map<string, T>()
  let disposed = false

  const cancel = (directory: string) => {
    const timer = pending.get(directory)
    if (timer === undefined) return
    timers.clear(timer)
    pending.delete(directory)
  }

  const schedule = (directory: string, delayMs: number) => {
    cancel(directory)
    pending.set(directory, timers.set(() => attempt(directory, delayMs), delayMs))
  }

  const attempt = (directory: string, delayMs: number) => {
    pending.delete(directory)
    if (disposed || deps.isCurrentDirectory(directory)) return
    const use = deps.directoryUse(directory)
    if (use === "unknown") return
    // Work still running, or waiting on the user, is looked at again later:
    // it usually finishes while the user is elsewhere.
    if (use === "busy") {
      schedule(directory, delayMs)
      return
    }
    void deps.release(directory).catch(() => {
      // Nothing to undo: OpenCode's own inactivity sweep still drops it.
    })
  }

  return {
    directoryChanged: (previous, next) => {
      if (disposed || previous === next) return
      if (next) cancel(next)
      if (!previous) return
      const delayMs = deps.releaseDelayMs(previous)
      if (delayMs !== null) schedule(previous, delayMs)
    },
    dispose: () => {
      disposed = true
      for (const timer of pending.values()) timers.clear(timer)
      pending.clear()
    },
  }
}

/**
 * Whether anything in `directory` still needs its location: a running or
 * retrying session, a pending permission or form, or a background command.
 * `state` is the directory's store; without one the answer is unknown.
 */
export function directoryUse(
  directory: string,
  state: Pick<State, "session_status" | "permission" | "form"> | undefined,
): DirectoryUse {
  if (!state) return "unknown"
  for (const status of Object.values(state.session_status)) {
    if (status.type === "busy" || status.type === "retry") return "busy"
  }
  if (Object.values(state.permission).some((requests) => requests.length > 0)) return "busy"
  if (Object.values(state.form).some((requests) => requests.length > 0)) return "busy"

  const scope = normalizeProjectPath(directory) ?? directory
  for (const entry of useGlobalSessionStatusStore.getState().statusById.values()) {
    if ((normalizeProjectPath(entry.directory) ?? entry.directory) !== scope) continue
    if (entry.status.type === "busy" || entry.status.type === "retry") return "busy"
  }
  const shellRuns = directoriesWithRunningShells().some((shellDirectory) => (
    (normalizeProjectPath(shellDirectory) ?? shellDirectory) === scope
  ))
  return shellRuns ? "busy" : "free"
}

/** Whether `directory` is a known worktree of a project, not the project root itself. */
export function isWorktreeDirectory(
  directory: string,
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
): boolean {
  const target = normalizePath(directory)
  if (!target) return false
  const projectRoots = [...availableWorktreesByProject.keys()].map((projectPath) => normalizePath(projectPath))
  if (projectRoots.includes(target)) return false
  for (const worktrees of availableWorktreesByProject.values()) {
    if (worktrees.some((worktree) => normalizePath(worktree.path) === target)) return true
  }
  return false
}

export function createRealLocationRelease(
  deps: Omit<LocationReleaseDeps<ReturnType<typeof setTimeout>>, "timers">,
): LocationRelease {
  return createLocationRelease({ ...deps, timers: realTimers })
}
