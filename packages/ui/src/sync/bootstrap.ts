import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { z } from "zod"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"
import { runtimeFetch } from "../lib/runtime-fetch"
import { emitSyncConfigChanged } from "./sync-refs"
import { warmChatsRootDirectory } from "../lib/chatDirectories"
import { runBackgroundNetworkTask } from "../lib/background-network"
import { sessionStatusSnapshotSchema } from "../lib/opencode/session-status"
import {
  readDirectoryStatusSnapshot,
  readDirectoryQuestionSnapshot,
  readDirectoryPermissionSnapshot,
  type DirectoryRecoverySource,
} from "./directory-recovery-snapshots"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sdkErrorMessage = z.object({ message: z.string() })

/**
 * SDK returns `{ data, error, response }` without throwing on non-2xx.
 * The silent `x.data!` / `x.data ?? []` pattern lets HTTP 5xx warmup
 * errors become empty state. Wrap into a real Error so retry() fires.
 */
function unwrap<T>(
  result: { data?: T; error?: unknown; response?: { status?: number } },
  name: string,
): T {
  if (result.error) {
    const status = result.response?.status
    const parsed = sdkErrorMessage.safeParse(result.error)
    const message = parsed.success ? parsed.data.message : String(result.error)
    throw Object.assign(new Error(`${name} failed${status ? ` (${status})` : ""}: ${message}`), { status })
  }
  if (result.data === undefined || result.data === null) {
    // No error + no data: ambiguous, treat as transient so retry fires.
    throw Object.assign(new Error(`${name} returned no data`), { status: 503 })
  }
  return result.data
}

function projectID(directory: string, projects: Project[]) {
  return projects.find(
    (project) => project.worktree === directory || project.sandboxes?.includes(directory),
  )?.id
}

// ---------------------------------------------------------------------------
// Bootstrap global state
// ---------------------------------------------------------------------------

export async function bootstrapGlobal(
  sdk: OpencodeClient,
  set: (patch: Partial<GlobalState>) => void,
) {
  const results = await Promise.allSettled([
    // Sync chat classification needs the chats root before session lists load;
    // it resolves alongside the other bootstrap calls, not ahead of them.
    warmChatsRootDirectory(),
    retry(() => sdk.path.get().then((x) => set({ path: unwrap(x, "path.get") }))),
    retry(() => sdk.global.config.get().then((x) => set({ config: unwrap(x, "global.config.get") }))),
    retry(() =>
      sdk.project.list().then((x) => {
        const data = unwrap(x, "project.list")
        const projects = data
          .filter((p): p is Project => !!p?.id)
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
      const healthRes = await runtimeFetch('/health', { signal: AbortSignal.timeout(4000) })
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
  sdk: OpencodeClient
  store: DirectoryRecoverySource
  set: (patch: Partial<State>) => void
  isStale?: () => boolean
  global: {
    config: State["config"]
    projects: Project[]
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
  const { directory, sdk, store, set, global: g } = input
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
    const seededConfig = g.config
    if (commit({ config: seededConfig })) emitSyncConfigChanged(directory, seededConfig)
  }
  commit({ status: "partial" })
  if (input.isStale?.()) return "stale"

  // Queue live recovery first. Each read commits independently and failures in
  // config/MCP cannot suppress pending questions or permission recovery.
  const critical = Promise.allSettled([
    read(async () => {
      const session_status = await readDirectoryStatusSnapshot(store, async () => (
        sessionStatusSnapshotSchema.parse(unwrap(await sdk.session.status({ directory }), "session.status"))
      ))
      commit({ session_status, sessionStatusReady: true })
    }),
    read(async () => {
      const question = await readDirectoryQuestionSnapshot(store, async () => (
        unwrap(await sdk.question.list({ directory }), "question.list")
      ))
      commit({ question })
    }),
    read(async () => {
      const permission = await readDirectoryPermissionSnapshot(store, async () => (
        unwrap(await sdk.permission.list({ directory }), "permission.list")
      ))
      commit({ permission })
    }),
    seededProject
      ? Promise.resolve()
      : read(() => sdk.project.current({ directory }).then((x) => commit({ project: unwrap(x, "project.current").id }))),
    read(() => sdk.config.get({ directory }).then((x) => {
      const config = unwrap(x, "config.get")
      if (commit({ config })) emitSyncConfigChanged(directory, config)
    })),
    read(() =>
      sdk.path.get({ directory }).then((x) => {
        const data = unwrap(x, "path.get")
        commit({ path: data })
        const next = projectID(data?.directory ?? directory, g.projects)
        if (next) commit({ project: next })
      }),
    ),
  ])
  const enrichment = Promise.allSettled([
    // MCP status and the command list are deliberately not read here. Reading
    // MCP state initializes the directory's whole stdio server fleet as an
    // OpenCode side effect, and listing commands enumerates MCP prompts,
    // which touches that same state. The sidebar declares bootstrap demand
    // for every known project directory, so either read launched one full
    // fleet per project at startup. Both surfaces fetch on demand through
    // their own stores (useMcpStore, useCommandsStore) instead.
    read(() => sdk.lsp.status({ directory }).then((x) => commit({ lsp: unwrap(x, "lsp.status") }))),
    read(() =>
      sdk.vcs.get({ directory }).then((x) => {
        const current = store.getState()
        if (x.error) {
          throw new Error(`vcs.get failed: ${String(x.error)}`)
        }
        commit({ vcs: x.data ?? current.vcs })
      }),
    ),
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
