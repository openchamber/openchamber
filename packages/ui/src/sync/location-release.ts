import { normalizePath } from "@/lib/pathNormalization"
import { normalizeProjectPath } from "@/lib/projectResolution"
import { findIntegrateCheckout } from "@/lib/worktrees/integrateCheckouts"
import { findWorktreeHoldingDirectory } from "@/lib/worktrees/worktreePaths"
import type { WorktreeMetadata } from "@/types/worktree"
import { directoriesWithRunningShells } from "./background-shells"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { hasPendingSessionAssist } from "./pending-session-assists"
import type { State } from "./types"


export const CHAT_LOCATION_RELEASE_DELAY_MS = 30_000

export const WORKTREE_LOCATION_RELEASE_DELAY_MS = 5 * 60_000

export const PROJECT_LOCATION_RELEASE_DELAY_MS = 15 * 60_000

type Timers<T> = {
  set: (run: () => void, ms: number) => T
  clear: (timer: T) => void
}

const realTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
}

export type DirectoryUse = "free" | "busy" | "unknown"

type LocationReleaseDeps<T> = {
  releaseDelayMs: (directory: string) => number
  isCurrentDirectory: (directory: string) => boolean
  directoryUse: (directory: string) => DirectoryUse
  release: (directory: string) => Promise<void>
  timers: Timers<T>
}

export type LocationRelease = {
  directoryChanged: (previous: string | null | undefined, next: string | null | undefined) => void
  recheck: (matches: (directory: string) => boolean) => void
  dispose: () => void
}

export function createLocationRelease<T>(deps: LocationReleaseDeps<T>): LocationRelease {
  const { timers } = deps
  const pending = new Map<string, T>()
  const rechecking = new Map<string, number>()
  let disposed = false

  const cancel = (directory: string) => {
    rechecking.delete(directory)
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
    rechecking.delete(directory)
    if (disposed || deps.isCurrentDirectory(directory)) return
    const use = deps.directoryUse(directory)
    if (use === "unknown") return
    if (use === "busy") {
      schedule(directory, delayMs)
      rechecking.set(directory, delayMs)
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
      schedule(previous, deps.releaseDelayMs(previous))
    },
    recheck: (matches) => {
      if (disposed) return
      for (const [directory, delayMs] of [...rechecking]) {
        if (!matches(directory)) continue
        cancel(directory)
        attempt(directory, delayMs)
      }
    },
    dispose: () => {
      disposed = true
      for (const timer of pending.values()) timers.clear(timer)
      pending.clear()
      rechecking.clear()
    },
  }
}

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
  if (hasPendingSessionAssist(directory)) return "busy"

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

export function isWorktreeDirectory(
  directory: string,
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
): boolean {
  const target = normalizePath(directory)
  if (!target) return false
  const projectRoots = [...availableWorktreesByProject.keys()].map((projectPath) => normalizePath(projectPath))
  if (projectRoots.includes(target)) return false
  if (findIntegrateCheckout(target)) return true
  for (const worktrees of availableWorktreesByProject.values()) {
    if (findWorktreeHoldingDirectory(worktrees, target)) return true
  }
  return false
}

export function createRealLocationRelease(
  deps: Omit<LocationReleaseDeps<ReturnType<typeof setTimeout>>, "timers">,
): LocationRelease {
  return createLocationRelease({ ...deps, timers: realTimers })
}
