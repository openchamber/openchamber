import type { OpencodeClient, PermissionRequest, Project, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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
    retry(() => sdk.path.get().then((x) => set({ path: x.data! }))),
    retry(() => sdk.global.config.get().then((x) => set({ config: x.data! }))),
    retry(() =>
      sdk.project.list().then((x) => {
        const projects = (x.data ?? [])
          .filter((p): p is Project => !!p?.id)
          .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
          .sort((a, b) => cmp(a.id, b.id))
        set({ projects })
      }),
    ),
    retry(() => sdk.provider.list().then((x) => set({ providers: x.data! }))),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error("[bootstrap] global bootstrap failed", errors[0])
  }

  set({ ready: true })
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
  if (Object.keys(state.config).length === 0 && Object.keys(g.config).length > 0) {
    set({ config: g.config as State["config"] })
  }
  if (loading) set({ status: "partial" })

  const results = await Promise.allSettled([
    seededProject
      ? Promise.resolve()
      : retry(() => sdk.project.current().then((x) => set({ project: x.data!.id }))),
    retry(() => sdk.provider.list().then((x) => set({ provider: x.data! }))),
    retry(() => sdk.app.agents().then((x) => set({ agent: x.data ?? [] }))),
    retry(() => sdk.config.get().then((x) => set({ config: x.data! }))),
    retry(() =>
      sdk.path.get().then((x) => {
        set({ path: x.data! })
        const next = projectID(x.data?.directory ?? directory, g.projects)
        if (next) set({ project: next })
      }),
    ),
    retry(() => sdk.command.list().then((x) => set({ command: x.data ?? [] }))),
    retry(() => sdk.session.status().then((x) => set({ session_status: x.data! }))),
    input.loadSessions(directory),
    retry(() => sdk.mcp.status().then((x) => set({ mcp: x.data! }))),
    retry(() => sdk.lsp.status().then((x) => set({ lsp: x.data! }))),
    retry(() =>
      sdk.vcs.get().then((x) => {
        const current = getState()
        set({ vcs: x.data ?? current.vcs })
      }),
    ),
    retry(() =>
      sdk.permission.list().then((x) => {
        const grouped = groupBySession(
          (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
        )
        const permission: Record<string, PermissionRequest[]> = {}
        // Clear sessions no longer having permissions
        const current = getState()
        for (const sessionID of Object.keys(current.permission ?? {})) {
          if (!grouped[sessionID]) permission[sessionID] = []
        }
        // Set grouped permissions sorted by id
        for (const [sessionID, perms] of Object.entries(grouped)) {
          permission[sessionID] = perms
            .filter((p) => !!p?.id)
            .sort((a, b) => cmp(a.id, b.id))
        }
        set({ permission })
      }),
    ),
    retry(() =>
      sdk.question.list().then((x) => {
        const grouped = groupBySession(
          (x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID),
        )
        const question: Record<string, QuestionRequest[]> = {}
        const current = getState()
        for (const sessionID of Object.keys(current.question ?? {})) {
          if (!grouped[sessionID]) question[sessionID] = []
        }
        for (const [sessionID, questions] of Object.entries(grouped)) {
          question[sessionID] = questions
            .filter((q) => !!q?.id)
            .sort((a, b) => cmp(a.id, b.id))
        }
        set({ question })
      }),
    ),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error(`[bootstrap] directory bootstrap failed for ${directory}`, errors[0])
    return
  }

  if (loading) set({ status: "complete" })
}
