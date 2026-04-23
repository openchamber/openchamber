import type { OpencodeClient, PermissionRequest, Project, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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
    const rawError = result.error
    const status = result.response?.status
    const message = typeof rawError === "object" && rawError !== null && "message" in rawError
      ? String((rawError as { message?: unknown }).message)
      : String(rawError)
    const err = new Error(`${name} failed${status ? ` (${status})` : ""}: ${message}`)
    if (status !== undefined) {
      ;(err as Error & { status?: number }).status = status
    }
    throw err
  }
  if (result.data === undefined) {
    // No error + no data: ambiguous, treat as transient so retry fires.
    const err = new Error(`${name} returned no data`)
    ;(err as Error & { status?: number }).status = 503
    throw err
  }
  return result.data
}

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    else acc[item.sessionID] = [item]
    return acc
  }, {})
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
    retry(() => sdk.provider.list().then((x) => set({ providers: unwrap(x, "provider.list") }))),
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
      const healthRes = await fetch("/health", { signal: AbortSignal.timeout(4000) })
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

export async function bootstrapDirectory(input: {
  directory: string
  sdk: OpencodeClient
  getState: () => State
  set: (patch: Partial<State>) => void
  global: {
    config: Record<string, unknown>
    projects: Project[]
    providers: { all: unknown[]; connected: unknown[]; default: Record<string, unknown> }
  }
  loadSessions: (directory: string) => Promise<void> | void
}) {
  const { directory, sdk, getState, set, global: g } = input
  const state = getState()
  const loading = state.status !== "complete"

  // Seed from global state while we fetch directory-specific data
  const seededProject = projectID(directory, g.projects)
  if (seededProject) set({ project: seededProject })
  if (state.provider.all.length === 0 && g.providers.all.length > 0) {
    set({ provider: g.providers as State["provider"] })
  }
  if (Object.keys(state.config ?? {}).length === 0 && Object.keys(g.config ?? {}).length > 0) {
    set({ config: g.config as State["config"] })
  }
  if (loading) set({ status: "partial" })

  // ---------------------------------------------------------------------------
  // Phase 1: Critical path — block until these resolve so the UI can render.
  // These are the minimum data needed to show a functional chat interface.
  // ---------------------------------------------------------------------------
  const phase1Results = await Promise.allSettled([
    seededProject
      ? Promise.resolve()
      : retry(() => sdk.project.current().then((x) => set({ project: unwrap(x, "project.current").id }))),
    retry(() => sdk.provider.list().then((x) => set({ provider: unwrap(x, "provider.list") }))),
    retry(() => sdk.config.get().then((x) => set({ config: unwrap(x, "config.get") }))),
    retry(() =>
      sdk.path.get().then((x) => {
        const data = unwrap(x, "path.get")
        set({ path: data })
        const next = projectID(data?.directory ?? directory, g.projects)
        if (next) set({ project: next })
      }),
    ),
    retry(() => sdk.session.status().then((x) => set({ session_status: unwrap(x, "session.status") }))),
  ])

  const phase1Errors = phase1Results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)

  // path.get (index 3) and session.status (index 4) have no global-state
  // fallback. If either fails, the UI cannot safely advance to "complete".
  const criticalPhase1Failed = phase1Results[3].status === "rejected" || phase1Results[4].status === "rejected"

  if (phase1Errors.length === phase1Results.length || criticalPhase1Failed) {
    console.error(`[bootstrap] directory bootstrap failed for ${directory}`, phase1Errors[0])
    return
  }

  // Mark ready after critical data arrives so the UI can paint.
  if (loading) set({ status: "complete" })

  // ---------------------------------------------------------------------------
  // Phase 2: Deferrable — fetch after first paint without blocking.
  // These enrich the UI but aren't required for basic functionality.
  // ---------------------------------------------------------------------------
  void Promise.allSettled([
    retry(() => sdk.app.agents().then((x) => set({ agent: unwrap(x, "app.agents") }))),
    retry(() => sdk.command.list().then((x) => set({ command: unwrap(x, "command.list") }))),
    retry(() => sdk.mcp.status().then((x) => set({ mcp: unwrap(x, "mcp.status") }))),
    retry(() => sdk.lsp.status().then((x) => set({ lsp: unwrap(x, "lsp.status") }))),
    retry(() =>
      sdk.vcs.get().then((x) => {
        const current = getState()
        if (x.error) {
          throw new Error(`vcs.get failed: ${String(x.error)}`)
        }
        set({ vcs: x.data ?? current.vcs })
      }),
    ),
    retry(async () => {
      const before = getState()
      const beforeSignatures = new Map(
        Object.entries(before.question ?? {}).map(([sessionID, questions]) => [sessionID, requestSignature(questions)]),
      )
      const x = await sdk.question.list(directory ? { directory } : undefined)
      if (x.error) {
        const status = (x as { response?: { status?: number } }).response?.status
        const err = new Error(`question.list failed${status ? ` (${status})` : ""}: ${String(x.error)}`)
        if (status !== undefined) (err as Error & { status?: number }).status = status
        throw err
      }
      const grouped = groupBySession(
        (x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID),
      )
      const current = getState()
      const merged = { ...current.question }
      for (const [sessionID, questions] of Object.entries(grouped)) {
        merged[sessionID] = questions
          .filter((q) => !!q?.id)
          .sort((a, b) => cmp(a.id, b.id))
      }
      for (const sessionID of beforeSignatures.keys()) {
        if (grouped[sessionID]) continue
        const beforeSignature = beforeSignatures.get(sessionID) ?? ""
        const currentSignature = requestSignature(current.question[sessionID])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionID]
      }
      set({ question: merged })
    }),
    retry(async () => {
      const before = getState()
      const beforeSignatures = new Map(
        Object.entries(before.permission ?? {}).map(([sessionID, permissions]) => [sessionID, requestSignature(permissions)]),
      )
      const x = await sdk.permission.list(directory ? { directory } : undefined)
      if (x.error) {
        const status = (x as { response?: { status?: number } }).response?.status
        const err = new Error(`permission.list failed${status ? ` (${status})` : ""}: ${String(x.error)}`)
        if (status !== undefined) (err as Error & { status?: number }).status = status
        throw err
      }
      const grouped = groupBySession(
        (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm?.sessionID),
      )
      const current = getState()
      const merged = { ...current.permission }
      for (const [sessionID, perms] of Object.entries(grouped)) {
        merged[sessionID] = perms
          .filter((p) => !!p?.id)
          .sort((a, b) => cmp(a.id, b.id))
      }
      for (const sessionID of beforeSignatures.keys()) {
        if (grouped[sessionID]) continue
        const beforeSignature = beforeSignatures.get(sessionID) ?? ""
        const currentSignature = requestSignature(current.permission[sessionID])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionID]
      }
      set({ permission: merged })
    }),
  ]).then((results) => {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason)
    if (errors.length) {
      console.error(`[bootstrap] deferred phase failed for ${directory}`, errors[0])
    }
  })

  // ---------------------------------------------------------------------------
  // Phase 3: Lazy — session list can be large; don't block on it.
  // ---------------------------------------------------------------------------
  void Promise.resolve(input.loadSessions(directory)).catch((err) => {
    console.error(`[bootstrap] session load failed for ${directory}`, err)
  })
}
