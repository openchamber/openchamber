import type { Project } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"
import { runtimeFetch } from "../lib/runtime-fetch"
import { emitSyncConfigChanged } from "./sync-refs"
import { warmChatsRootDirectory } from "../lib/chatDirectories"
import { runBackgroundNetworkTask } from "../lib/background-network"
import {
  readDirectoryStatusSnapshot,
  readDirectoryFormSnapshot,
  readDirectoryPermissionSnapshot,
  type DirectoryRecoverySource,
} from "./directory-recovery-snapshots"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function projectID(directory: string, projects: Project[]) {
  return projects.find(
    (project) => project.worktree === directory || project.sandboxes?.includes(directory),
  )?.id
}

// ---------------------------------------------------------------------------
// Bootstrap global state
// ---------------------------------------------------------------------------

export async function bootstrapGlobal(set: (patch: Partial<GlobalState>) => void) {
  const results = await Promise.allSettled([
    // Sync chat classification needs the chats root before session lists load;
    // it resolves alongside the other bootstrap calls, not ahead of them.
    warmChatsRootDirectory(),
    retry(async () => {
      const [location, home] = await Promise.all([opencodeClient.getLocation(), opencodeClient.getFilesystemHome()])
      set({ path: { directory: location.directory, worktree: location.project.directory, home: home ?? "" } })
    }),
    retry(() => opencodeClient.getConfig().then((config) => set({ config }))),
    retry(() =>
      opencodeClient.listProjects().then((data) => {
        const projects = data
          .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
          .sort((a, b) => cmp(a.id, b.id))
        set({ projects })
      }),
    ),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error("[bootstrap] global bootstrap failed", errors[0])
  }

  // If ALL requests failed, OpenCode is likely down — fetch the OpenChamber
  // health endpoint (outside the readiness gate) to get the actual error reason.
  if (errors.length === results.length) {
    let message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    try {
      const healthRes = await runtimeFetch("/health", { signal: AbortSignal.timeout(4000) })
      if (healthRes.ok) {
        const health = await healthRes.json()
        if (health.lastOpenCodeError) {
          message = health.lastOpenCodeError
        } else if (!health.openCodeRunning) {
          message = "OpenCode process is not running"
        }
      }
    } catch {
      // health endpoint itself unreachable — use the original error
    }
    set({ ready: true, error: { type: "init", message } })
  } else {
    set({ ready: true, error: undefined })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap per-directory state
// ---------------------------------------------------------------------------

type DirectoryBootstrapInput = {
  directory: string
  store: DirectoryRecoverySource
  set: (patch: Partial<State>) => void
  isStale?: () => boolean
  global: {
    config: State["config"]
    projects: Project[]
    path: GlobalState["path"]
  }
  loadSessions: (directory: string) => Promise<void> | void
}

type BootstrapResult = "complete" | "failed" | "stale"

export function bootstrapDirectory(input: DirectoryBootstrapInput) {
  const sessions = (async (): Promise<BootstrapResult> => {
    if (input.isStale?.()) return "stale"
    try {
      await input.loadSessions(input.directory)
      return input.isStale?.() ? "stale" : "complete"
    } catch (error) {
      if (input.isStale?.()) return "stale"
      console.error(`[bootstrap] session load failed for ${input.directory}`, error)
      return "failed"
    }
  })()
  // Initialization has its own completion and network capacity. A slow config
  // or directory cannot hold the session-list scheduler's slot.
  const environment = initializeDirectory(input)
  return { sessions, environment }
}

async function initializeDirectory(input: DirectoryBootstrapInput): Promise<BootstrapResult> {
  const { directory, store, set, global: g } = input
  const read = <T>(request: () => Promise<T>) => retry(() => runBackgroundNetworkTask(() => {
    if (input.isStale?.()) throw new Error("Directory initialization superseded")
    return request()
  }))
  const commit = (patch: Partial<State>): boolean => {
    if (input.isStale?.()) return false
    set(patch)
    return true
  }
  const state = store.getState()

  // Seed from global state while we fetch directory-specific data
  const seededProject = projectID(directory, g.projects)
  if (seededProject) commit({ project: seededProject })
  if (Object.keys(state.config ?? {}).length === 0 && Object.keys(g.config ?? {}).length > 0) {
    if (commit({ config: g.config })) emitSyncConfigChanged(directory, g.config)
  }
  commit({ status: "partial" })
  if (input.isStale?.()) return "stale"

  // Queue live recovery first. Each read commits independently and a failing
  // config read cannot suppress pending form or permission recovery.
  const critical = Promise.allSettled([
    read(async () => {
      const session_status = await readDirectoryStatusSnapshot(store, async () => {
        const statuses = await opencodeClient.getActiveSessionStatuses(directory)
        if (statuses === null) throw new Error("session.active failed")
        return statuses
      })
      commit({ session_status, sessionStatusReady: true })
    }),
    read(async () => {
      const form = await readDirectoryFormSnapshot(store, () => (
        opencodeClient.listPendingForms({ directories: [directory], includeGlobal: false })
      ))
      commit({ form })
    }),
    read(async () => {
      const permission = await readDirectoryPermissionSnapshot(store, () => (
        opencodeClient.listPendingPermissions({ directories: [directory], includeGlobal: false })
      ))
      commit({ permission })
    }),
    read(() => opencodeClient.getConfig(directory).then((config) => {
      if (commit({ config })) emitSyncConfigChanged(directory, config)
    })),
    read(() =>
      opencodeClient.getLocation(directory).then((location) => {
        commit({
          project: location.project.id,
          path: { directory: location.directory, worktree: location.project.directory, home: g.path.home },
        })
      }),
    ),
  ])
  // MCP status and the command list are deliberately not read here. Reading
  // MCP state initializes the directory's whole stdio server fleet as an
  // OpenCode side effect, and listing commands enumerates MCP prompts, which
  // touches that same state. Both surfaces fetch on demand through their own
  // stores (useMcpStore, useCommandsStore) instead.
  const enrichment = Promise.allSettled([
    read(() => opencodeClient.getVcs(directory).then((vcs) => commit({ vcs }))),
  ])
  const [results, enrichmentResults] = await Promise.all([critical, enrichment])
  if (input.isStale?.()) return "stale"
  const enrichmentErrors = enrichmentResults.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (enrichmentErrors.length) console.warn(`[bootstrap] optional enrichment failed for ${directory}`, enrichmentErrors[0].reason)
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (errors.length) {
    console.error(`[bootstrap] environment initialization failed for ${directory}`, errors[0].reason)
    return "failed"
  }
  commit({ status: "complete" })
  return "complete"
}
