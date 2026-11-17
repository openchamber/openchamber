import type {
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

export type Path = {
  directory: string
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

export type State = {
  status: "loading" | "partial" | "complete"
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  sessionListSource?: "empty" | "persisted" | "live" | "authoritative"
  sessionRevision?: number
  sessionEventRevision?: Record<string, number>
  sessionDeletedRevision?: Record<string, number>
  session_status: Record<string, SessionStatus>
  sessionStatusReady?: boolean
  sessionStatusInvalidated?: Record<string, true>
  permission: Record<string, PermissionRequest[]>
  form: Record<string, FormRequest[]>
  vcs: Vcs | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

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
export const EVICTION_GRACE_MS = 30 * 1000
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 20

const EMPTY_PATH: Path = { directory: "", worktree: "", home: "" }
const EMPTY_PROVIDER_CATALOG: ProviderCatalog = { providers: [], models: [] }

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  config: {},
  path: EMPTY_PATH,
  status: "loading",
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
