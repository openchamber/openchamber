import type {
  Agent,
  Config,
  FormRequest,
  Message,
  Part,
  PermissionRequest,
  Project,
  Session,
  SessionStatus,
  Vcs,
} from "@/lib/opencode/model"
import type { ProviderCatalog } from "@/lib/opencode/client"

export type { Project }

/** Resolved filesystem context of a directory (from `/api/location` plus the server home). */
export type Path = {
  /** Directory the store is scoped to. */
  directory: string
  /** Project root that contains `directory`. */
  worktree: string
  home: string
}

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderCatalog
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  sessionListSource?: "empty" | "persisted" | "live" | "authoritative"
  sessionRevision?: number
  sessionEventRevision?: Record<string, number>
  sessionDeletedRevision?: Record<string, number>
  session_status: Record<string, SessionStatus>
  /** A successful status snapshot makes omitted sessions authoritatively idle. */
  sessionStatusReady?: boolean
  permission: Record<string, PermissionRequest[]>
  /** Pending forms (the agent asking the user for input), keyed by session. */
  form: Record<string, FormRequest[]>
  vcs: Vcs | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  path: Path
  projects: Project[]
  providers: ProviderCatalog
  config: Config
  reload: undefined | "pending" | "complete"
}

type InitError = {
  type: "init"
  message: string
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  graceMs?: number
  now: number
  hasPendingBlockingRequests?: (directory: string) => boolean
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
  hasPendingBlockingRequests: boolean
}

export const MAX_DIR_STORES = 30
/**
 * Directories touched within this window are never overflow-eviction victims.
 *
 * Sidebar rows call `ensureChild` during render but only take their pin in an
 * effect after commit. Without a grace window, expanding a project with more
 * worktrees than `MAX_DIR_STORES` evicted directories that were actively
 * rendering, which recreated them, which issued another bootstrap request, in
 * an endless loop (issue #1472). The limit is therefore a soft target: a burst
 * of live directories overflows briefly rather than thrashing, and the cache is
 * bounded by idle-time eviction instead.
 */
export const EVICTION_GRACE_MS = 30 * 1000
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 20

export const EMPTY_PATH: Path = { directory: "", worktree: "", home: "" }
export const EMPTY_PROVIDER_CATALOG: ProviderCatalog = { providers: [], models: [] }

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: EMPTY_PROVIDER_CATALOG,
  config: {},
  path: EMPTY_PATH,
  status: "loading",
  agent: [],
  session: [],
  sessionTotal: 0,
  sessionListSource: "empty",
  sessionRevision: 0,
  sessionEventRevision: {},
  sessionDeletedRevision: {},
  session_status: {},
  permission: {},
  form: {},
  vcs: undefined,
  limit: 5,
  message: {},
  part: {},
}

export const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  path: EMPTY_PATH,
  projects: [],
  providers: EMPTY_PROVIDER_CATALOG,
  config: {},
  reload: undefined,
}
