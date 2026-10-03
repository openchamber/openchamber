import { normalizeProjectPath } from "@/lib/projectResolution"
import { directoriesWithRunningShells } from "./background-shells"
import { useGlobalSessionStatusStore } from "./global-session-status"
import type { State } from "./types"

// OpenCode 2 keeps a location for every directory it serves, and each location
// runs its own copy of the user's local MCP servers. A managed chat has a
// directory of its own, so every chat opened keeps one copy alive until
// OpenCode's hour-long inactivity sweep. Once the user has left a chat
// directory and nothing runs there, ask OpenCode to drop that location now.

/** Long enough that flicking between chats does not restart their MCP servers. */
const CHAT_LOCATION_RELEASE_DELAY_MS = 30_000

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
export type ChatDirectoryUse = "free" | "busy" | "unknown"

type ChatLocationReleaseDeps<T> = {
  isChatDirectory: (directory: string) => boolean
  isCurrentDirectory: (directory: string) => boolean
  directoryUse: (directory: string) => ChatDirectoryUse
  release: (directory: string) => Promise<void>
  delayMs: number
  timers: Timers<T>
}

export type ChatLocationRelease = {
  /** The user moved from `previous` to `next`. */
  directoryChanged: (previous: string | null | undefined, next: string | null | undefined) => void
  dispose: () => void
}

export function createChatLocationRelease<T>(deps: ChatLocationReleaseDeps<T>): ChatLocationRelease {
  const { delayMs, timers } = deps
  const pending = new Map<string, T>()
  let disposed = false

  const cancel = (directory: string) => {
    const timer = pending.get(directory)
    if (timer === undefined) return
    timers.clear(timer)
    pending.delete(directory)
  }

  const schedule = (directory: string) => {
    cancel(directory)
    pending.set(directory, timers.set(() => attempt(directory), delayMs))
  }

  const attempt = (directory: string) => {
    pending.delete(directory)
    if (disposed || deps.isCurrentDirectory(directory)) return
    const use = deps.directoryUse(directory)
    if (use === "unknown") return
    // A chat still running, or waiting on the user, is looked at again later:
    // it usually finishes while the user is elsewhere.
    if (use === "busy") {
      schedule(directory)
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
      if (previous && deps.isChatDirectory(previous)) schedule(previous)
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
export function chatDirectoryUse(
  directory: string,
  state: Pick<State, "session_status" | "permission" | "form"> | undefined,
): ChatDirectoryUse {
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

export function createRealChatLocationRelease(
  deps: Omit<ChatLocationReleaseDeps<ReturnType<typeof setTimeout>>, "delayMs" | "timers">,
): ChatLocationRelease {
  return createChatLocationRelease({ ...deps, delayMs: CHAT_LOCATION_RELEASE_DELAY_MS, timers: realTimers })
}
