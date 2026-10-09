/**
 * OpenCode client wrapper.
 *
 * Every official OpenCode call the shared UI makes goes through here, on top
 * of `@opencode/client`. The wrapper owns three things the generated client
 * does not: runtime-aware transport (`runtimeFetch`, read timeouts, directory
 * scoping through `x-opencode-directory`), error normalisation (v2 throws
 * tagged error bodies without an HTTP status), and projection of wire shapes
 * into the OpenChamber domain model (`./model`, `./projection`).
 *
 * OpenChamber-owned server routes (`/api/fs/*`, `/api/opencode/*`) also live
 * here when they are part of the same directory/session workflows.
 */

import { ClientError, OpenCode, type OpenCodeClient } from "@opencode/client"
import type {
  FileDiffInfo,
  SessionDiffInput,
  FormAnswer,
  FormInfo,
  LocationGetOutput,
  SessionInboxDelivery,
  SessionRevert,
} from "@opencode/client"
import { z } from "zod"
import type { FilesAPI } from "../api/types"
import { getDesktopHomeDirectory } from "../desktop"
import { isAmbiguousTransportFailure, isDefiniteTransportFailure, markAmbiguousTransportFailure, markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { FilesystemError, parseFilesystemErrorReason } from "@/lib/api/files-errors"
import type { ContextPartMetadata } from "@/lib/messages/contextParts"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { spaceMarkSchema, type SpaceMark } from "@/lib/spaces/spaces-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { markStartupTrace } from "@/lib/startupTrace"
import { assertProviderCircuitClosed, recordProviderError, recordProviderSuccess } from "./provider-tracker"
import { normalizePath } from "@/lib/pathNormalization"
import { isAutoModel } from "@/lib/routing/autoModel"
import { activeSessionSnapshotSchema, hostSessionStatusSnapshotSchema, type HostSessionStatusSnapshot } from "./session-status"
import {
  compact,
  type Agent,
  type Command,
  type Config,
  type McpServerStatus,
  type Message,
  type Metadata,
  type Model,
  type ModelRef,
  type Part,
  type PermissionReply,
  type PermissionRequest,
  type Project,
  type Provider,
  type Session,
  type SessionStatus,
  type Skill,
  type Vcs,
} from "./model"
import { ascendingId } from "./ids"
import { runningShellFromWire, shellCancellationNote, type RunningShell } from "./background-shell"
import { subagentCancellationNote } from "./subagent-run"
import { toJsonRecord } from "./json"
import {
  deniesAnyProvider,
  mergeConfigDocuments,
  projectAgent,
  projectMessages,
  projectProject,
  projectSession,
  projectVcs,
  readIntegrationPolicies,
  type IntegrationPolicy,
} from "./projection"

export type { OpenCodeClient }

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api"
const CONFIG_CACHE_TTL_MS = 10_000
const OPENCODE_HEALTH_TIMEOUT_MS = 4_000
const DEFAULT_SESSION_PAGE_LIMIT = 100
/** How much of a running command's output the live view starts with. */
const SHELL_OUTPUT_TAIL_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * HTTP status for the tagged error bodies OpenCode v2 returns. The generated
 * client throws the parsed body for declared statuses and drops the status,
 * so callers that branch on 404 / 401 need it restored from the tag.
 */
const STATUS_BY_TAG = new Map<string, number>([
  ["InvalidRequestError", 400],
  ["InvalidCursorError", 400],
  ["FormInvalidAnswerError", 400],
  ["UnauthorizedError", 401],
  ["ForbiddenError", 403],
  ["SessionNotFoundError", 404],
  ["MessageNotFoundError", 404],
  ["PermissionNotFoundError", 404],
  ["FormNotFoundError", 404],
  ["AgentNotFoundError", 404],
  ["CommandNotFoundError", 404],
  ["SkillNotFoundError", 404],
  ["ProviderNotFoundError", 404],
  ["McpServerNotFoundError", 404],
  ["ProjectNotFoundError", 404],
  ["FileNotFoundError", 404],
  ["PtyNotFoundError", 404],
  ["ShellNotFoundError", 404],
  // LocationNotFoundError (the session's directory is gone) stays unmapped on
  // purpose: callers read 404 as "this entity is settled or missing", and
  // fetchPermission would then let auto-accept treat a live request as settled.
  ["ConflictError", 409],
  ["SessionBusyError", 409],
  ["FormAlreadySettledError", 409],
  ["ServiceUnavailableError", 503],
  ["UnknownError", 500],
])

export type OpencodeHealthProbe = "healthy" | "unhealthy" | "unreachable"

export class OpencodeApiError extends Error {
  readonly operation: string
  readonly status: number | undefined
  /** The error class OpenCode named in a tagged body (`SessionNotFoundError`, `UnknownError`, ...). */
  readonly tag: string | undefined
  /** What the body said, without the operation prefix `message` carries. */
  readonly detail: string
  /** The id OpenCode prints next to the stack in its own log for a 500, so a
      surface can quote something that can be searched for. */
  readonly ref: string | undefined

  constructor(operation: string, message: string, options: { status?: number; tag?: string; ref?: string; cause?: unknown }) {
    super(`${operation} failed${options.status ? ` (${options.status})` : ""}: ${message}`, { cause: options.cause })
    this.name = "OpencodeApiError"
    this.operation = operation
    this.status = options.status
    this.tag = options.tag
    this.detail = message
    this.ref = options.ref
  }
}

const taggedErrorSchema = z.object({ _tag: z.string(), message: z.string().optional(), ref: z.string().optional() })

class RuntimeRoutingResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RuntimeRoutingResponseError'
  }
}

const validateRuntimeResponse = (response: Response): Response => {
  const unavailable = response.headers.get('x-openchamber-error') === 'runtime-unavailable'
  const html = response.ok && (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
  if (!unavailable && !html) return response
  void response.body?.cancel().catch(() => undefined)
  throw new RuntimeRoutingResponseError(response.status, unavailable
    ? 'runtime_unavailable'
    : 'the runtime returned a web page instead of an API response')
}

/**
 * Turns whatever the generated client threw into an `OpencodeApiError` with a
 * status the rest of the app can branch on. Transport failures keep their
 * relay "outcome unknown" marker so a lost response is not mistaken for a
 * request that never left.
 */
export function normalizeOpencodeError(operation: string, error: unknown): OpencodeApiError {
  if (error instanceof OpencodeApiError) return error
  const routingError = error instanceof RuntimeRoutingResponseError ? error
    : error instanceof ClientError && error.cause instanceof RuntimeRoutingResponseError ? error.cause : null
  if (routingError) {
    return markDefiniteTransportFailure(new OpencodeApiError(operation, routingError.message, {
      status: routingError.status, cause: error,
    }))
  }
  if (error instanceof ClientError) {
    if (error.reason === "UnexpectedStatus") {
      const status = (error.cause as { status?: unknown } | undefined)?.status
      return new OpencodeApiError(operation, `unexpected status`, {
        status: typeof status === "number" ? status : undefined,
        cause: error,
      })
    }
    const wrapped = new OpencodeApiError(operation, error.reason === "Transport" ? "transport failure" : error.reason, {
      cause: error.cause ?? error,
    })
    if (error.reason === "Transport" && isAmbiguousTransportFailure(error.cause)) {
      markAmbiguousTransportFailure(wrapped)
    }
    return wrapped
  }
  const tagged = taggedErrorSchema.safeParse(error)
  if (tagged.success) {
    return new OpencodeApiError(operation, tagged.data.message ?? tagged.data._tag, {
      status: STATUS_BY_TAG.get(tagged.data._tag),
      tag: tagged.data._tag,
      ref: tagged.data.ref,
      cause: error,
    })
  }
  if (error instanceof Error) {
    const wrapped = new OpencodeApiError(operation, error.message, { cause: error })
    if (isAmbiguousTransportFailure(error)) markAmbiguousTransportFailure(wrapped)
    return wrapped
  }
  return new OpencodeApiError(operation, String(error), { cause: error })
}

/**
 * Skills the user named with `$name`, in order of appearance. They are
 * attached to the prompt by id so OpenCode loads each one with the message,
 * whatever the session is doing; a name that cannot be attached falls back to
 * the instruction the caller builds for it.
 */
export type SkillMentions = {
  names: readonly string[]
  instructionFor: (names: readonly string[]) => string | null
}

type SkillAttachmentRef = { id: string; name: string }

/** OpenCode rejected a prompt because an attached skill id does not exist. */
const isSkillNotFound = (error: OpencodeApiError): boolean =>
  error.tag === "InvalidRequestError" && error.detail.startsWith("Skill not found")

export const isOpencodeNotFound = (error: unknown): boolean =>
  error instanceof OpencodeApiError && error.status === 404

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw normalizeOpencodeError(operation, error)
  }
}

// ---------------------------------------------------------------------------
// Ids and URLs
// ---------------------------------------------------------------------------

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//
const ensureAbsoluteBaseUrl = (candidate: string): string => {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api"

  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized
  }

  if (typeof window === "undefined") {
    return normalized
  }

  const baseReference = window.location?.href || window.location?.origin
  if (!baseReference) {
    return normalized
  }

  try {
    return new URL(normalized, baseReference).toString()
  } catch (error) {
    console.warn("Failed to normalize OpenCode base URL:", error)
    return normalized
  }
}

const resolveRuntimeBaseUrl = (): string | null => {
  try {
    return getRuntimeUrlResolver().api("/api")
  } catch {
    return null
  }
}

type AbortSignalConstructorWithTimeout = typeof AbortSignal & {
  timeout?: (milliseconds: number) => AbortSignal
}

const createTimeoutSignal = (timeoutMs: number): { signal: AbortSignal; cleanup: () => void } => {
  const abortSignal = typeof AbortSignal !== "undefined" ? (AbortSignal as AbortSignalConstructorWithTimeout) : undefined
  if (typeof abortSignal?.timeout === "function") {
    return { signal: abortSignal.timeout(timeoutMs), cleanup: () => undefined }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  }
}

/**
 * Upper bound for non-streaming OpenCode read requests. Without it, a socket
 * that neither resolves nor rejects (the half-open state described in #2470)
 * keeps the bootstrap concurrency slot busy forever and the UI stays on
 * "loading sessions". Long-lived streams (prompts, the event SSE, session logs)
 * are excluded in {@link createRuntimeOpencodeClient}.
 */
const OPENCODE_REQUEST_TIMEOUT_MS = 30_000

const isEventStreamUrl = (url: URL): boolean => url.pathname.endsWith("/event") || url.pathname.endsWith("/log")

/** Header the server reads to resolve a Location; the value is URI-encoded on both ends. */
const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory"

type RuntimeOpencodeClientConfig = {
  baseUrl: string
  directory?: string
  /** Read-request timeout in ms. Overridable so tests can use short value. */
  requestTimeoutMs?: number
}

/**
 * The generated client joins its `/api/...` route paths onto the base URL's
 * path (since 2.0.15), so it wants the root the `/api` mount hangs off, not
 * the mount itself. Our base URLs name the mount, so drop that last segment.
 */
const toOpencodeClientRoot = (baseUrl: string): string => baseUrl.replace(/\/api\/*$/, "") || "/"

export const createRuntimeOpencodeClient = (config: RuntimeOpencodeClientConfig): OpenCodeClient => {
  const requestTimeoutMs = config.requestTimeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS
  return OpenCode.make({
    baseUrl: toOpencodeClientRoot(config.baseUrl),
    headers: config.directory ? { [OPENCODE_DIRECTORY_HEADER]: encodeURIComponent(config.directory) } : undefined,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      if (isEventStreamUrl(url) || method === "POST") {
        return validateRuntimeResponse(await runtimeFetch(input, init))
      }
      const timeout = createTimeoutSignal(requestTimeoutMs)
      const callerSignal = init?.signal !== undefined
        ? init.signal
        : input instanceof Request ? input.signal : undefined
      const supportsAny = typeof AbortSignal !== "undefined" && typeof (AbortSignal as { any?: unknown }).any === "function"
      let signal: AbortSignal
      let detachFallback: (() => void) | null = null
      if (callerSignal && supportsAny) {
        signal = (AbortSignal as typeof AbortSignal & { any: (signals: AbortSignal[]) => AbortSignal }).any([
          callerSignal,
          timeout.signal,
        ])
      } else if (callerSignal) {
        // No AbortSignal.any: compose manually. Silently dropping the timeout
        // here would disable the fix on exactly the bootstrap reads it
        // targets, since those carry a cancellation signal.
        const controller = new AbortController()
        const abortFromCaller = () => controller.abort(callerSignal.reason)
        const abortFromTimeout = () => controller.abort(timeout.signal.reason)
        if (callerSignal.aborted) {
          abortFromCaller()
        } else if (timeout.signal.aborted) {
          abortFromTimeout()
        } else {
          callerSignal.addEventListener("abort", abortFromCaller, { once: true })
          timeout.signal.addEventListener("abort", abortFromTimeout, { once: true })
          detachFallback = () => {
            callerSignal.removeEventListener("abort", abortFromCaller)
            timeout.signal.removeEventListener("abort", abortFromTimeout)
          }
        }
        signal = controller.signal
      } else {
        signal = timeout.signal
      }
      const cleanup = () => {
        detachFallback?.()
        timeout.cleanup()
      }
      let responseHasBody = false
      try {
        const response = await runtimeFetch(input, { ...init, signal })
        validateRuntimeResponse(response)
        responseHasBody = response.body !== null
        return response
      } catch (error) {
        if (timeout.signal.aborted && !callerSignal?.aborted) {
          throw new Error(`OpenCode request timed out after ${requestTimeoutMs}ms`)
        }
        throw error
      } finally {
        // The SDK consumes JSON after fetch resolves. Keep cancellation and the
        // deadline alive through body delivery, including on older WebViews
        // using the manual signal composition. Retention is bounded by the
        // request deadline, just like native AbortSignal.timeout.
        if (!responseHasBody || signal.aborted) cleanup()
        else signal.addEventListener("abort", cleanup, { once: true })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type FilesystemEntry = {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink?: boolean
}

export type ProjectFileSearchHit = {
  name: string
  path: string
  relativePath: string
  extension?: string
}

type FileInputLite = {
  id?: string
  type: "file"
  mime: string
  filename?: string
  url: string
}

type DirectorySwitchResult = {
  success: boolean
  restarted: boolean
  path: string
}

export type MessagePage = {
  items: Array<{ info: Message; parts: Part[] }>
  cursor: { previous?: string; next?: string }
}

export type SessionPage = {
  sessions: Session[]
  cursor: { previous?: string; next?: string }
  /**
   * The isolated spaces the host merged into a global page, one mark per space, when the
   * feature is on. Absent on a per-directory page and while the feature is off.
   */
  spaces?: SpaceMark[]
}

// The global list carries the mark beside the SDK's own fields; the SDK types do not know it.
const sessionPageSpacesSchema = z.object({ spaces: z.array(spaceMarkSchema).optional() })

export type SessionListOptions = {
  directory?: string | null
  /** No directory filter at all: every session the server knows. */
  global?: boolean
  limit?: number
  order?: "asc" | "desc"
  search?: string
  cursor?: string
  parentID?: string | null
}

export type ProviderCatalog = {
  providers: Provider[]
  models: Model[]
  default?: ModelRef
}

/**
 * Tagged result of `OpencodeService.fetchPermission()`. The caller can
 * distinguish a server-confirmed "no longer pending" permission (HTTP
 * 404) from a fetch failure (network error, malformed response).
 */
type FetchPermissionResult =
  | { state: "ok"; permission: PermissionRequest }
  | { state: "resolved" }
  | { state: "unknown" }

type DirectoryAvailability = "available" | "missing" | "unknown"
/**
 * Pending requests live in the location that raised them, so a list is asked
 * per directory. There is no global list on v2: a request without a directory
 * answers for OpenCode's own working directory and makes OpenCode start it,
 * MCP servers included.
 */
type PendingRequestListOptions = {
  directories?: Array<string | null | undefined>
}
const directoryProbeErrorSchema = z.object({ reason: z.string().optional(), isDirectory: z.boolean().optional() })

const normalizeFsPath = (path: string): string => path.replace(/\\/g, "/")
const FS_LIST_CACHE_TTL_MS = 400

const getDesktopFilesApi = (): FilesAPI | null => {
  const apis = getRegisteredRuntimeAPIs()
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files
  }
  return null
}

// /api/fs/home parsing boundary. Older servers answer without chatsRoot;
// only a valid home response may use the legacy chats-root fallback.
const fsAbsolutePathSchema = z.string().trim().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
const fsHomeResponseSchema = z.object({
  home: fsAbsolutePathSchema,
  chatsRoot: fsAbsolutePathSchema.optional(),
  canonicalChatsRoot: fsAbsolutePathSchema.optional(),
  canonicalLegacyChatsRoot: fsAbsolutePathSchema.optional(),
})

/** One context item admitted as a synthetic message; `id` is client-minted when given. */
export type SyntheticContextInput = {
  id?: string
  text: string
  metadata?: ContextPartMetadata
  description?: string
}

const pageCursor = (cursor: { previous?: string | null; next?: string | null }) =>
  compact({ previous: cursor.previous ?? undefined, next: cursor.next ?? undefined })

const dedupeById = <T extends { id: string }>(lists: T[][]): T[] => {
  const merged: T[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const item of list) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class OpencodeService {
  private client: OpenCodeClient
  private baseUrl: string
  private scopedClients: Map<string, OpenCodeClient> = new Map()
  private currentDirectory: string | undefined = undefined
  private directoryContextQueue: Promise<void> = Promise.resolve()
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map()
  private providerCatalogInFlight: Map<string, Promise<ProviderCatalog>> = new Map()
  private listAgentsInFlight: Map<string, Promise<Agent[]>> = new Map()
  private configInFlight: Map<string, Promise<Config>> = new Map()
  private configCache: Map<string, { config: Config; expiresAt: number }> = new Map()
  private configCacheGeneration = 0
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map()

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const runtimeBase = resolveRuntimeBaseUrl()
    const requestedBaseUrl = runtimeBase || baseUrl
    this.baseUrl = ensureAbsoluteBaseUrl(requestedBaseUrl)
    this.client = createRuntimeOpencodeClient({ baseUrl: this.baseUrl })
  }

  /**
   * A send is several awaited mutations (model switch, agent switch, context,
   * prompt). A runtime switch between any two of them would route the rest to
   * the other server, so the caller's captured runtime key is re-checked
   * before every mutation, not only at entry.
   */
  private assertRuntimeUnchanged(runtimeKey?: string): void {
    if (runtimeKey && runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  reconnectToRuntimeBaseUrl(): void {
    const runtimeBase = resolveRuntimeBaseUrl()
    const nextBaseUrl = ensureAbsoluteBaseUrl(runtimeBase || DEFAULT_BASE_URL)
    // An explicit reconnect can change the instance or transport behind the
    // same URL. Its SDK client and in-flight directory requests are obsolete.
    this.baseUrl = nextBaseUrl
    this.client = createRuntimeOpencodeClient({ baseUrl: this.baseUrl })
    this.scopedClients.clear()
    this.listDirectoryInFlight.clear()
    this.providerCatalogInFlight.clear()
    this.clearAgentListRequests()
    this.clearConfigCache()
    this.listDirectoryCache.clear()
  }

  /** Raw client without a directory scope (global routes, event stream). */
  getSdkClient(): OpenCodeClient {
    return this.client
  }

  /** Raw client whose every request resolves the given directory's Location. */
  getScopedSdkClient(directory: string): OpenCodeClient {
    const normalized = this.normalizeCandidatePath(directory) ?? directory
    const key = normalized || ""
    const existing = this.scopedClients.get(key)
    if (existing) {
      return existing
    }
    const scoped = createRuntimeOpencodeClient({ baseUrl: this.baseUrl, directory: normalized })
    this.scopedClients.set(key, scoped)
    return scoped
  }

  /** Client for an explicit directory, else the current one, else unscoped. */
  private clientFor(directory?: string | null): OpenCodeClient {
    const resolved = this.resolveDirectory(directory)
    return resolved ? this.getScopedSdkClient(resolved) : this.client
  }

  private resolveDirectory(directory?: string | null): string | undefined {
    return this.normalizeCandidatePath(directory) ?? this.currentDirectory
  }

  private normalizeCandidatePath(path?: string | null): string | null {
    return normalizePath(path)
  }

  private deriveHomeDirectory(path: string): { homeDirectory: string; username?: string } {
    const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/)
    if (windowsMatch) {
      const drive = windowsMatch[1]
      const remainder = path.slice(drive.length + (path.charAt(drive.length) === "/" ? 1 : 0))
      const segments = remainder.split("/").filter(Boolean)

      if (segments.length >= 2) {
        const homeDirectory = `${drive}/${segments[0]}/${segments[1]}`
        return { homeDirectory, username: segments[1] }
      }

      if (segments.length === 1) {
        const homeDirectory = `${drive}/${segments[0]}`
        return { homeDirectory, username: segments[0] }
      }

      return { homeDirectory: `${drive}/`, username: undefined }
    }

    const absolute = path.startsWith("/")
    const segments = path.split("/").filter(Boolean)

    if (segments.length >= 2 && (segments[0] === "Users" || segments[0] === "home")) {
      const homeDirectory = `${absolute ? "/" : ""}${segments[0]}/${segments[1]}`
      return { homeDirectory, username: segments[1] }
    }

    if (absolute) {
      if (segments.length === 0) {
        return { homeDirectory: "/", username: undefined }
      }
      const homeDirectory = `/${segments.join("/")}`
      return { homeDirectory, username: segments[segments.length - 1] }
    }

    if (segments.length > 0) {
      const homeDirectory = `/${segments.join("/")}`
      return { homeDirectory, username: segments[segments.length - 1] }
    }

    return { homeDirectory: "/", username: undefined }
  }

  // Set the current working directory for all API calls
  setDirectory(directory: string | undefined) {
    const normalized = this.normalizeCandidatePath(directory) ?? directory
    if (this.currentDirectory !== normalized) {
      markStartupTrace("opencodeClient:setDirectory", {
        previous: this.currentDirectory ?? null,
        next: normalized ?? null,
      })
    }
    this.currentDirectory = normalized
  }

  getDirectory(): string | undefined {
    return this.currentDirectory
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const runWithContext = async (): Promise<T> => {
      if (directory === undefined || directory === null) {
        return fn()
      }

      const previousDirectory = this.currentDirectory
      const scopedDirectory = this.normalizeCandidatePath(directory) ?? directory
      this.currentDirectory = scopedDirectory
      try {
        return await fn()
      } finally {
        if (this.currentDirectory === scopedDirectory) {
          this.currentDirectory = previousDirectory
        }
      }
    }

    const queuedRun = this.directoryContextQueue.then(runWithContext, runWithContext)
    this.directoryContextQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    )

    return queuedRun
  }

  // -------------------------------------------------------------------------
  // Location / system
  // -------------------------------------------------------------------------

  /** The Location OpenCode resolves for a directory: canonical project root and id. */
  async getLocation(directory?: string | null): Promise<LocationGetOutput> {
    return call("location.get", () => this.clientFor(directory).location.get())
  }

  /**
   * Drops the location OpenCode keeps for a directory, which stops that
   * directory's MCP servers; the next read of it starts them again. OpenCode
   * serves this among its debug routes. Asked without a directory it would
   * drop its own working directory, so one is required.
   */
  async releaseLocation(directory: string): Promise<void> {
    const normalized = this.normalizeCandidatePath(directory)
    if (!normalized) throw new Error("releaseLocation needs a directory")
    await call("debug.location.evict", () => this.getScopedSdkClient(normalized).debug.location.evict())
  }

  /**
   * The list is global, but v2 serves it through a location: asked without a
   * directory, OpenCode starts its own working directory (MCP servers
   * included) to answer. The current directory is already running.
   */
  async listProjects(): Promise<Project[]> {
    const projects = await call("project.list", () => this.clientFor().project.list())
    return projects.map(projectProject)
  }

  /**
   * Identity of the project a directory belongs to. OpenCode 2.0.8 removed
   * `project.current`; the Location a directory resolves to carries the same
   * project record.
   */
  async getCurrentProject(directory?: string | null): Promise<LocationGetOutput["project"]> {
    const location = await call("location.get", () => this.clientFor(directory).location.get())
    return location.project
  }

  async getVcs(directory?: string | null): Promise<Vcs> {
    return call("vcs.get", () => this.clientFor(directory).vcs.get().then((r) => projectVcs(r.data)))
  }

  /**
   * Runs `git init` in a directory that has no repository yet (OpenCode
   * 2.0.23). OpenCode refreshes its own view of the directory; the caller
   * refreshes the app's Git state.
   */
  async initializeGit(directory: string): Promise<void> {
    return call("vcs.init", () => this.clientFor(directory).vcs.init())
  }

  // Get system information including home directory
  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates = new Set<string>()
    const addCandidate = (value?: string | null) => {
      const normalized = this.normalizeCandidatePath(value)
      if (normalized) {
        candidates.add(normalized)
      }
    }

    try {
      const location = await this.getLocation()
      addCandidate(location.directory)
      addCandidate(location.project.directory)
    } catch (error) {
      console.debug("Failed to load location info:", error)
    }

    if (!candidates.size) {
      try {
        const sessions = await this.listSessions()
        sessions.forEach((session) => addCandidate(session.directory))
      } catch (error) {
        console.debug("Failed to inspect sessions for system info:", error)
      }
    }

    addCandidate(this.currentDirectory)

    if (typeof window !== "undefined") {
      try {
        addCandidate(window.localStorage.getItem("lastDirectory"))
        addCandidate(window.localStorage.getItem("homeDirectory"))
      } catch {
        // Access to storage failed (e.g. privacy mode)
      }
    }

    if (!candidates.size && typeof process !== "undefined" && typeof process.cwd === "function") {
      addCandidate(process.cwd())
    }

    if (!candidates.size) {
      return { homeDirectory: "/", username: undefined }
    }

    const [primary] = Array.from(candidates)
    return this.deriveHomeDirectory(primary)
  }

  /**
   * Best-effort probe whether a directory is accessible to OpenCode.
   * This is intentionally NOT the same as local filesystem access in the UI runtime.
   */
  async probeDirectory(directory: string): Promise<boolean> {
    return (await this.getDirectoryAvailability(directory)) === "available"
  }

  /**
   * Distinguishes a confirmed-missing directory from an unavailable probe.
   * Offline, permission, and other transport failures stay `unknown` so callers
   * do not treat a temporary outage as proof the path was deleted.
   *
   * The probe is OpenChamber's own `/api/fs/directory-stat`, which asks the
   * server to stat the path without listing its contents. A runtime without
   * that route (VS Code) answers `unknown`.
   */
  async getDirectoryAvailability(directory: string): Promise<DirectoryAvailability> {
    const normalized = this.normalizeCandidatePath(directory)
    if (!normalized) {
      return "unknown"
    }
    try {
      const response = await runtimeFetch("/api/fs/directory-stat", { query: { path: normalized } })
      const body = directoryProbeErrorSchema.safeParse(await response.json().catch(() => null)).data
      if (response.ok && body?.isDirectory === true) return "available"
      const reason = parseFilesystemErrorReason(body?.reason)
      return reason === "not-found" || reason === "not-directory" ? "missing" : "unknown"
    } catch {
      return "unknown"
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /** One page of sessions. Without `global`, scoped to the given or current directory. */
  async listSessionsPage(options: SessionListOptions = {}): Promise<SessionPage> {
    const directory = options.global ? undefined : this.resolveDirectory(options.directory)
    const client = directory ? this.getScopedSdkClient(directory) : this.client
    const response = await call("session.list", () =>
      client.session.list({
        directory,
        limit: options.limit ?? DEFAULT_SESSION_PAGE_LIMIT,
        order: options.order,
        search: options.search,
        cursor: options.cursor,
        parentID: options.parentID,
      }),
    )
    const spaces = options.global ? sessionPageSpacesSchema.safeParse(response).data?.spaces : undefined
    return {
      sessions: response.data.map(projectSession),
      cursor: pageCursor(response.cursor),
      ...(spaces ? { spaces } : {}),
    }
  }

  /** First page of sessions for the current directory. */
  async listSessions(directory?: string | null): Promise<Session[]> {
    const page = await this.listSessionsPage({ directory })
    return page.sessions
  }

  async createSession(
    params?: { id?: string; title?: string; agent?: string; model?: ModelRef; metadata?: Metadata },
    directory?: string | null,
  ): Promise<Session> {
    const requestDirectory = this.resolveDirectory(directory)
    const info = await call("session.create", () =>
      this.clientFor(directory).session.create({
        id: params?.id,
        title: params?.title,
        agent: params?.agent,
        // Auto is OpenChamber's sentinel, not a model OpenCode can start a
        // session on; the first send puts the session on Auto through the
        // model switch the server intercepts.
        model: params?.model && isAutoModel(params.model.providerID, params.model.id) ? undefined : params?.model,
        location: requestDirectory ? { directory: requestDirectory } : undefined,
        metadata: params?.metadata,
      }),
    )
    return projectSession(info)
  }

  async getSession(id: string, directory?: string | null): Promise<Session> {
    const info = await call("session.get", () => this.clientFor(directory).session.get({ sessionID: id }))
    return projectSession(info)
  }

  async deleteSession(id: string, directory?: string | null): Promise<boolean> {
    await call("session.remove", () => this.clientFor(directory).session.remove({ sessionID: id }))
    return true
  }

  /**
   * Renames the session. OpenCode 2.0.8 folded `session.rename` into
   * `session.update`, where an empty title asks the server to regenerate one.
   */
  async renameSession(id: string, title: string, directory?: string | null): Promise<void> {
    await call("session.update", () => this.clientFor(directory).session.update({ sessionID: id, title }))
  }

  async moveSession(id: string, toDirectory: string, options?: { delivery?: SessionInboxDelivery }): Promise<void> {
    const directory = this.normalizeCandidatePath(toDirectory) ?? toDirectory
    await call("session.move", () =>
      this.client.session.move({ sessionID: id, directory, delivery: options?.delivery }),
    )
  }

  async switchSessionModel(id: string, model: ModelRef, directory?: string | null): Promise<void> {
    await call("session.switchModel", () => this.clientFor(directory).session.switchModel({ sessionID: id, model }))
  }

  async switchSessionAgent(id: string, agent: string, directory?: string | null): Promise<void> {
    await call("session.switchAgent", () => this.clientFor(directory).session.switchAgent({ sessionID: id, agent }))
  }

  /**
   * One page of a session's messages, newest first by default. `cursor` comes
   * from a previous page; the server rejects combining it with `order`.
   *
   * The server attaches `next` to every non-empty page, including the oldest
   * one, so a caller walking history would always need one more empty request
   * to learn it is done. A page shorter than the requested limit is the last
   * page, and its `next` is dropped here so `next` means "more" to callers.
   */
  async getSessionMessages(
    id: string,
    options?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
    directory?: string | null,
  ): Promise<MessagePage> {
    const response = await call("message.list", () =>
      this.clientFor(directory).message.list({
        sessionID: id,
        limit: options?.limit,
        cursor: options?.cursor,
        order: options?.cursor ? undefined : options?.order,
      }),
    )
    const items = projectMessages(response.data, id).map(({ message, parts }) => ({ info: message, parts }))
    const lastPage = options?.limit !== undefined && items.length < options.limit
    return {
      items,
      cursor: pageCursor({ ...response.cursor, next: lastPage ? undefined : response.cursor.next }),
    }
  }

  async getSessionMessage(id: string, messageID: string, directory?: string | null): Promise<{ info: Message; parts: Part[] }> {
    const info = await call("session.message.get", () => this.clientFor(directory).session.message.get({ sessionID: id, messageID }))
    const [projected] = projectMessages([info], id)
    return { info: projected.message, parts: projected.parts }
  }

  /**
   * Check if MIME type needs normalization to text/plain.
   * Some text MIME types (like text/markdown) aren't supported by AI providers.
   */
  private shouldNormalizeToTextPlain(mime: string): boolean {
    if (!mime) return false

    const lowerMime = mime.toLowerCase()

    // All text/* types except text/plain need normalization
    if (lowerMime.startsWith("text/") && lowerMime !== "text/plain") {
      return true
    }

    // Common application types that are actually text
    const textBasedTypes = [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/typescript",
      "application/x-yaml",
      "application/yaml",
      "application/toml",
      "application/x-sh",
      "application/x-shellscript",
      "application/octet-stream",
      "image/svg+xml",
    ]

    return textBasedTypes.includes(lowerMime)
  }

  /**
   * Check if MIME type is HEIC/HEIF (iPhone photo format).
   */
  private isHeicMime(mime: string): boolean {
    if (!mime) return false
    const lowerMime = mime.toLowerCase()
    return lowerMime === "image/heic" || lowerMime === "image/heif"
  }

  /**
   * Convert HEIC image to JPEG.
   * Returns the original file if conversion fails.
   */
  private async convertHeicToJpeg(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    try {
      // Dynamic import to avoid loading heic2any unless needed
      const heic2any = (await import("heic2any")).default

      // Extract base64 data from data URL
      const commaIndex = file.url.indexOf(",")
      if (commaIndex === -1) return file

      const base64Data = file.url.substring(commaIndex + 1)
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      const heicBlob = new Blob([bytes], { type: file.mime })

      // Convert to JPEG
      const jpegBlob = (await heic2any({
        blob: heicBlob,
        toType: "image/jpeg",
        quality: 0.9,
      })) as Blob

      // Convert back to data URL
      const jpegDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(jpegBlob)
      })

      // Update filename extension
      let newFilename = file.filename
      if (newFilename) {
        newFilename = newFilename.replace(/\.heic$/i, ".jpg").replace(/\.heif$/i, ".jpg")
      }

      return {
        mime: "image/jpeg",
        filename: newFilename,
        url: jpegDataUrl,
      }
    } catch (error) {
      console.warn("Failed to convert HEIC to JPEG:", error)
      return file
    }
  }

  /**
   * Normalize file part for sending to AI providers.
   * - Converts unsupported text MIME types to text/plain
   * - Converts HEIC/HEIF images to JPEG
   */
  private async normalizeFilePart(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    // Handle HEIC conversion
    if (this.isHeicMime(file.mime)) {
      return this.convertHeicToJpeg(file)
    }

    // Handle text MIME normalization
    if (!this.shouldNormalizeToTextPlain(file.mime)) {
      return file
    }

    let normalizedUrl = file.url

    // Update MIME type in data URL if present
    // Format: data:<mime>;base64,<content> or data:<mime>,<content>
    if (file.url.startsWith("data:")) {
      const commaIndex = file.url.indexOf(",")
      if (commaIndex !== -1) {
        const meta = file.url.substring(5, commaIndex) // after "data:"
        const content = file.url.substring(commaIndex) // includes comma

        // Replace the MIME type in meta, preserving ;base64 if present
        const newMeta = meta.replace(/^[^;,]+/, "text/plain")
        normalizedUrl = `data:${newMeta}${content}`
      }
    }

    return {
      mime: "text/plain",
      filename: file.filename,
      url: normalizedUrl,
    }
  }

  private async toPromptFile(file: FileInputLite): Promise<{ uri: string; name?: string }> {
    const normalized = await this.normalizeFilePart(file)
    return { uri: normalized.url, name: normalized.filename }
  }

  /**
   * Puts a session on the requested model/agent before a prompt. v2 selects
   * both per session, not per prompt; the choice persists until switched.
   */
  private async applySendSelection(
    sessionID: string,
    selection: { model?: ModelRef; agent?: string },
    directory: string | null | undefined,
    runtimeKey: string | undefined,
  ): Promise<void> {
    if (selection.model) {
      this.assertRuntimeUnchanged(runtimeKey)
      await this.switchSessionModel(sessionID, selection.model, directory)
    }
    if (selection.agent) {
      this.assertRuntimeUnchanged(runtimeKey)
      await this.switchSessionAgent(sessionID, selection.agent, directory)
    }
  }

  /**
   * Sends one user turn. Context the user attached (inline comments, terminal
   * output, PR checks) travels as synthetic messages admitted right before the
   * prompt with the same delivery, so the model reads them first and the
   * timeline can render them as context blocks from their metadata.
   *
   * Returns the user message id (client-generated so the optimistic message
   * reconciles in place when the server echoes it).
   */
  async sendMessage(params: {
    runtimeKey?: string
    id: string
    /** Switch the session to this model before sending; omit when unchanged. */
    model?: ModelRef
    /** Switch the session to this agent before sending; omit when unchanged. */
    agent?: string
    /** Provider the prompt will run on, for the provider circuit breaker. */
    providerID: string
    text: string
    files?: Array<FileInputLite>
    /**
     * Context items sent ahead of the prompt as synthetic messages. A caller
     * that supplies `messageId` also supplies the item ids, minted before it.
     */
    context?: SyntheticContextInput[]
    messageId?: string
    agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>
    metadata?: Metadata
    delivery?: SessionInboxDelivery
    directory?: string | null
    /** Skills named inline; attached to the prompt so OpenCode loads them with it. */
    skills?: SkillMentions
  }): Promise<string> {
    this.assertRuntimeUnchanged(params.runtimeKey)

    // Context ids are minted before the prompt's, so the transcript's id order
    // matches the order the records are admitted in.
    const context = (params.context ?? [])
      .filter((item) => item.text.trim())
      .map((item) => ({ ...item, id: item.id ?? ascendingId("msg") }))
    const messageId = params.messageId ?? ascendingId("msg")
    const files = await Promise.all((params.files ?? []).map((file) => this.toPromptFile(file)))
    const agents = (params.agentMentions ?? [])
      .filter((mention) => !!mention?.name)
      .map((mention) => ({
        name: mention.name,
        mention: mention.source ? { start: mention.source.start, end: mention.source.end, text: mention.source.value } : undefined,
      }))

    if (!params.text.trim() && files.length === 0 && (params.context?.length ?? 0) === 0) {
      throw new Error("Message must have at least one part (text or file)")
    }

    assertProviderCircuitClosed(params.providerID)

    const admitSynthetic = async (item: SyntheticContextInput) => {
      this.assertRuntimeUnchanged(params.runtimeKey)
      await call("session.synthetic", () =>
        this.clientFor(params.directory).session.synthetic({
          sessionID: params.id,
          id: item.id,
          text: item.text,
          description: item.description,
          metadata: item.metadata ? toJsonRecord(item.metadata) : undefined,
          delivery: params.delivery,
          resume: false,
        }),
      )
    }
    const prompt = (skills: readonly SkillAttachmentRef[]) => {
      this.assertRuntimeUnchanged(params.runtimeKey)
      return call("session.prompt", () =>
        this.clientFor(params.directory).session.prompt({
          sessionID: params.id,
          id: messageId,
          text: params.text,
          files: files.length > 0 ? files : undefined,
          agents: agents.length > 0 ? agents : undefined,
          skills: skills.length > 0 ? skills.map((skill) => ({ id: skill.id })) : undefined,
          metadata: params.metadata,
          delivery: params.delivery,
        }),
      )
    }

    try {
      await this.applySendSelection(params.id, { model: params.model, agent: params.agent }, params.directory, params.runtimeKey)
      const skills = await this.resolveSkillMentions(params.skills?.names ?? [], params.directory)
      const unresolvedInstruction = params.skills?.instructionFor(skills.unresolved) ?? null
      for (const item of context) {
        await admitSynthetic(item)
      }
      if (unresolvedInstruction) await admitSynthetic({ text: unresolvedInstruction })
      try {
        await prompt(skills.attached)
      } catch (error) {
        // The skill list and the prompt are two requests: a skill removed in
        // between fails preparation before anything is admitted, so the same
        // message id is safe to send again without the attachment.
        if (skills.attached.length === 0 || !(error instanceof OpencodeApiError) || !isSkillNotFound(error)) throw error
        const instruction = params.skills?.instructionFor(skills.attached.map((skill) => skill.name)) ?? null
        if (instruction) await admitSynthetic({ text: instruction })
        await prompt([])
      }
    } catch (error) {
      // Do not retry a prompt after a transport failure: through a remote
      // tunnel the POST may already be running server-side even though the
      // client lost the response.
      if (!(error instanceof Error && isDefiniteTransportFailure(error))) {
        recordProviderError(params.providerID, error instanceof OpencodeApiError ? error.status : undefined)
      }
      throw error
    }

    recordProviderSuccess(params.providerID)
    return messageId
  }

  /**
   * Runs a slash command in the session. The server assigns the message id.
   * Attached context (quoted selections, pinned knowledge) goes in first as
   * synthetic messages that do not start execution, so the command template
   * still expands on the server with the context already in the transcript.
   */
  async sendCommand(params: {
    runtimeKey?: string
    id: string
    model?: ModelRef
    agent?: string
    command: string
    arguments?: string
    files?: Array<FileInputLite>
    context?: SyntheticContextInput[]
    delivery?: SessionInboxDelivery
    directory?: string | null
  }): Promise<void> {
    this.assertRuntimeUnchanged(params.runtimeKey)
    const files = await Promise.all((params.files ?? []).map((file) => this.toPromptFile(file)))
    await this.applySendSelection(params.id, { model: params.model, agent: params.agent }, params.directory, params.runtimeKey)
    for (const item of params.context ?? []) {
      if (!item.text.trim()) continue
      this.assertRuntimeUnchanged(params.runtimeKey)
      await call("session.synthetic", () =>
        this.clientFor(params.directory).session.synthetic({
          sessionID: params.id,
          id: item.id,
          text: item.text,
          description: item.description,
          metadata: item.metadata ? toJsonRecord(item.metadata) : undefined,
          delivery: params.delivery,
          resume: false,
        }),
      )
    }
    this.assertRuntimeUnchanged(params.runtimeKey)
    await call("session.command", () =>
      this.clientFor(params.directory).session.command({
        sessionID: params.id,
        name: params.command,
        text: params.arguments ?? "",
        files: files.length > 0 ? files : undefined,
        delivery: params.delivery,
      }),
    )
  }

  /** Interrupts the running turn. Resolves false when nothing was running. */
  async abortSession(id: string, directory?: string | null): Promise<boolean> {
    const result = await call("session.interrupt", () => this.clientFor(directory).session.interrupt({ sessionID: id }))
    return result.interrupted
  }

  /**
   * Moves the work the turn is blocked on (a running shell command, a
   * subagent it waits for) to the background. The work keeps running, the
   * agent is told to move on, and the result is handed back when it settles.
   * A no-op when nothing blocks.
   */
  async backgroundSessionWork(id: string, directory?: string | null): Promise<void> {
    await call("session.background", () => this.clientFor(directory).session.background({ sessionID: id }))
  }

  /** Runs a shell command inside the session transcript. Returns the shell message id. */
  async shellSession(params: {
    runtimeKey?: string
    sessionId: string
    command: string
    messageId?: string
    directory?: string | null
  }): Promise<string> {
    this.assertRuntimeUnchanged(params.runtimeKey)
    const id = params.messageId ?? ascendingId("msg")
    await call("session.shell", () =>
      this.clientFor(params.directory).session.shell({ sessionID: params.sessionId, id, command: params.command }),
    )
    return id
  }

  /** Stages a revert to before `messageId`; nothing changes until {@link commitRevert}. */
  async stageRevert(sessionId: string, messageId: string, options?: { files?: boolean; directory?: string | null }): Promise<SessionRevert> {
    return call("session.revert.stage", () =>
      this.clientFor(options?.directory).session.revert.stage({
        sessionID: sessionId,
        messageID: messageId,
        files: options?.files,
      }),
    )
  }

  async commitRevert(sessionId: string, directory?: string | null): Promise<void> {
    await call("session.revert.commit", () => this.clientFor(directory).session.revert.commit({ sessionID: sessionId }))
  }

  async clearRevert(sessionId: string, directory?: string | null): Promise<void> {
    await call("session.revert.clear", () => this.clientFor(directory).session.revert.clear({ sessionID: sessionId }))
  }

  /** Compacts the transcript; the result arrives as a compaction message through events. */
  async compactSession(sessionId: string, directory?: string | null): Promise<void> {
    await call("session.compact", () => this.clientFor(directory).session.compact({ sessionID: sessionId }))
  }

  /**
   * Forks the session. `before` copies the transcript up to but excluding that
   * message; omitting it copies the whole transcript (OpenCode 2.0.8 replaced
   * the `boundary` object with this single optional message id).
   */
  async forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<Session> {
    const info = await call("session.fork", () =>
      this.clientFor(options?.directory).session.fork({ sessionID: sessionId, before: options?.before }),
    )
    return projectSession(info)
  }

  /**
   * Sessions with a running agent loop, or `null` when the fetch failed.
   *
   * `null` vs `{}` matters for reconnect resync: an empty map means every
   * session is idle, so a candidate missing from it is authoritatively idle.
   * A failure must not be conflated with that.
   *
   * The host's snapshot is global: one read for every directory of the host.
   * A directory inside an isolated space is asked of that space instead,
   * because the host's snapshot never covers a space's sessions, and an empty
   * answer from the host would settle a turn that is running inside.
   */
  async getActiveSessionStatuses(directory?: string | null): Promise<Record<string, SessionStatus> | null> {
    try {
      const client = isSpaceDirectory(directory) && directory ? this.getScopedSdkClient(directory) : this.client
      const active = activeSessionSnapshotSchema.parse(await call("session.active", () => client.session.active()))
      const statuses: Record<string, SessionStatus> = {}
      for (const sessionID of Object.keys(active)) statuses[sessionID] = { type: "busy" }
      return statuses
    } catch {
      return null
    }
  }

  /**
   * Cross-project busy/retry/idle map kept by the OpenChamber host from the
   * single upstream event stream. One request that creates no OpenCode
   * instance, unlike `/session/status?directory=`. `null` means the fetch
   * failed; callers must preserve their current state.
   */
  async getHostSessionStatusSnapshot(): Promise<HostSessionStatusSnapshot | null> {
    try {
      const response = await runtimeFetch('/api/sessions/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const parsed = hostSessionStatusSnapshotSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Get session activity from web server's in-memory tracking.
   * This is more reliable than the OpenCode active list on visibility restore
   * because the web server tracks activity even when UI is not listening to SSE.
   */
  async getWebServerSessionActivity(): Promise<Record<string, { type: string }> | null> {
    try {
      const response = await runtimeFetch("/api/session-activity", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json().catch(() => null)
      if (!data || typeof data !== "object") {
        return null
      }

      return data as Record<string, { type: string }>
    } catch {
      return null
    }
  }

  /** Transient text generated from the session's context; never enters history. */
  async generateSessionText(sessionId: string, prompt: string, directory?: string | null): Promise<string> {
    const result = await call("session.generate", () =>
      this.clientFor(directory).session.generate({ sessionID: sessionId, prompt }),
    )
    return result.text
  }

  /**
   * Per-file diffs of what a turn changed, computed by OpenCode from the
   * turn's snapshots: `from` names the user message whose turn to diff
   * (default: the newest), `to` extends the range through a later turn.
   * Covers edits the tool calls alone cannot describe (a `write`, a subagent).
   */
  async getSessionTurnDiff(
    sessionId: string,
    options?: { from?: string; to?: string; context?: number; directory?: string | null },
  ): Promise<FileDiffInfo[]> {
    const { from, to, context } = options ?? {}
    // The client's input type marks every field read-only, so it is built in one go.
    const input: SessionDiffInput = { sessionID: sessionId, from, to, context }
    const result = await call("session.diff", () => this.clientFor(options?.directory).session.diff(input))
    return [...result]
  }

  /** One stateless generation with the server's default model unless `model` is given. */
  async generateText(prompt: string, options?: { model?: ModelRef; directory?: string | null }): Promise<string> {
    const result = await call("generate.text", () =>
      this.clientFor(options?.directory).generate.text({ prompt, model: options?.model }),
    )
    return result.text
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  async replyToPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    options?: { message?: string; directory?: string | null },
  ): Promise<boolean> {
    await call("permission.reply", () =>
      this.clientFor(options?.directory).permission.reply({
        sessionID,
        requestID,
        decision: reply,
        message: options?.message,
      }),
    )
    return true
  }

  /**
   * Fetch a pending permission request owned by a session. A 404 is the
   * server confirming the request has settled; every other failure stays
   * distinct so auto-accept fails closed while the request stays visible.
   */
  async fetchPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult> {
    try {
      const permission = await call("permission.get", () => this.clientFor(directory).permission.get({ sessionID, requestID }))
      return { state: "ok", permission }
    } catch (error) {
      if (isOpencodeNotFound(error)) return { state: "resolved" }
      return { state: "unknown" }
    }
  }

  /**
   * Throws on fetch failure. Callers that drive authoritative state from the
   * result (e.g. reconnect resync) must let the throw propagate so they can
   * preserve existing state instead of conflating "fetch failed" with "server
   * returned no pending permissions".
   */
  async listPendingPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]> {
    const directories = this.uniqueDirectories(options?.directories)
    const lists = await Promise.all(
      directories.map((directory) =>
        call("permission.request.list", () =>
          this.getScopedSdkClient(directory).permission.request.list().then((r) => r.data),
        ),
      ),
    )
    return dedupeById(lists)
  }

  // -------------------------------------------------------------------------
  // Forms (the agent asking the user for input)
  // -------------------------------------------------------------------------

  async replyToForm(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean> {
    await call("session.form.reply", () => this.clientFor(directory).session.form.reply({ sessionID, formID, answer }))
    return true
  }

  async cancelForm(sessionID: string, formID: string, directory?: string | null): Promise<boolean> {
    await call("session.form.cancel", () => this.clientFor(directory).session.form.cancel({ sessionID, formID }))
    return true
  }

  /** Throws on fetch failure; see {@link listPendingPermissions}. */
  async listPendingForms(options?: PendingRequestListOptions): Promise<FormInfo[]> {
    const directories = this.uniqueDirectories(options?.directories)
    const lists = await Promise.all(
      directories.map((directory) =>
        call("form.list", () =>
          this.getScopedSdkClient(directory).form.list().then((r) => r.data),
        ),
      ),
    )
    return dedupeById(lists)
  }

  // -------------------------------------------------------------------------
  // Shell commands the agent started (background commands)
  // -------------------------------------------------------------------------

  /**
   * Commands still running in the directory on behalf of a session, keyed by
   * the directory OpenCode resolved it to (symlinks resolved), which is the
   * directory its shell events carry. Throws on fetch failure.
   */
  async listRunningShells(directory: string): Promise<{ directory: string; shells: RunningShell[] }> {
    const response = await call("shell.list", () => this.clientFor(directory).shell.list())
    return {
      directory: response.location.directory ?? directory,
      shells: response.data.flatMap((info) => runningShellFromWire(info) ?? []),
    }
  }

  /**
   * The newest part of a command's captured output, and the cursor to read
   * on from. Without a cursor the read starts `tailBytes` before the end.
   */
  async readShellOutput(
    shellID: string,
    directory: string,
    cursor?: number,
    tailBytes = SHELL_OUTPUT_TAIL_BYTES,
  ): Promise<{ output: string; cursor: number; skipped: boolean }> {
    const client = this.clientFor(directory)
    let start = cursor
    if (start === undefined) {
      const end = await call("shell.output", () => client.shell.output({ id: shellID, cursor: Number.MAX_SAFE_INTEGER }).then((r) => r.data))
      start = Math.max(0, end.size - tailBytes)
    }
    const page = await call("shell.output", () => client.shell.output({ id: shellID, cursor: start, limit: tailBytes }).then((r) => r.data))
    return { output: page.output, cursor: page.cursor, skipped: cursor === undefined && start > 0 }
  }

  /**
   * Stops a background command the agent started. The agent is told first,
   * in a note that does not wake it, that the error OpenCode is about to
   * report is the user's stop (see `shellCancellationNote`); the command is
   * killed only once the note is in. Throws when either step fails, and
   * nothing is killed when the note could not be delivered.
   */
  async stopBackgroundShell(params: {
    sessionID: string
    sessionDirectory?: string | null
    shellID: string
    shellDirectory: string
    command: string
  }): Promise<void> {
    const note = shellCancellationNote({ shellID: params.shellID, command: params.command })
    await call("session.synthetic", () =>
      this.clientFor(params.sessionDirectory).session.synthetic({
        sessionID: params.sessionID,
        text: note.text,
        description: note.description,
        metadata: note.metadata,
        resume: false,
      }),
    )
    await call("shell.remove", () => this.clientFor(params.shellDirectory).shell.remove({ id: params.shellID }))
  }

  /**
   * Stops a subagent the agent started, in the foreground or the background.
   * The agent is told first, in a note that does not wake it, that the
   * cancellation OpenCode is about to report is the user's stop (see
   * `subagentCancellationNote`); the child session is interrupted only once
   * the note is in. Throws when either step fails, and nothing is stopped
   * when the note could not be delivered.
   */
  async stopSubagent(params: {
    sessionID: string
    directory?: string | null
    childSessionID: string
    description: string | undefined
  }): Promise<void> {
    const note = subagentCancellationNote({ childSessionID: params.childSessionID, description: params.description })
    await call("session.synthetic", () =>
      this.clientFor(params.directory).session.synthetic({
        sessionID: params.sessionID,
        text: note.text,
        description: note.description,
        metadata: note.metadata,
        resume: false,
      }),
    )
    await this.abortSession(params.childSessionID, params.directory)
  }

  /** Global pending items when requested, then each distinct directory. */
  private uniqueDirectories(entries: Array<string | null | undefined> | undefined): string[] {
    const unique = new Set<string>()
    for (const entry of entries ?? []) {
      const normalized = this.normalizeCandidatePath(entry)
      if (normalized) unique.add(normalized)
    }
    return [...unique]
  }

  // -------------------------------------------------------------------------
  // Configuration and catalog
  // -------------------------------------------------------------------------

  clearConfigCache(): void {
    this.configCacheGeneration += 1
    this.configInFlight.clear()
    this.configCache.clear()
  }

  /** Whether OpenCode's config for a directory restricts providers with a `provider.use` deny policy. */
  async configDeniesAnyProvider(directory?: string | null): Promise<boolean> {
    const entries = await call("config.get", () => this.clientFor(this.resolveDirectory(directory)).config.get())
    return deniesAnyProvider(entries)
  }

  /** The `integration.use` statements OpenCode's config applies to MCP servers and skills in a directory. */
  async getIntegrationPolicies(directory?: string | null): Promise<IntegrationPolicy[]> {
    const entries = await call("config.get", () => this.clientFor(this.resolveDirectory(directory)).config.get())
    return readIntegrationPolicies(entries)
  }

  /** Effective configuration for a directory: every discovered document folded, highest priority last. */
  async getConfig(directory?: string | null): Promise<Config> {
    const effectiveDirectory = this.resolveDirectory(directory)
    const key = effectiveDirectory ?? ""
    const cached = this.configCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      markStartupTrace("opencodeClient.getConfig:cacheHit", { directory: effectiveDirectory ?? null })
      return cached.config
    }

    const existing = this.configInFlight.get(key)
    if (existing) {
      markStartupTrace("opencodeClient.getConfig:deduped", { directory: effectiveDirectory ?? null })
      return existing
    }

    const generation = this.configCacheGeneration
    const request = (async () => {
      markStartupTrace("opencodeClient.getConfig:start", { directory: effectiveDirectory ?? null })
      const started = typeof performance !== "undefined" ? performance.now() : Date.now()
      const entries = await call("config.get", () => this.clientFor(effectiveDirectory).config.get())
      const config = mergeConfigDocuments(entries)
      const ended = typeof performance !== "undefined" ? performance.now() : Date.now()
      markStartupTrace("opencodeClient.getConfig:end", {
        directory: effectiveDirectory ?? null,
        durationMs: Math.round(ended - started),
      })
      if (generation === this.configCacheGeneration) {
        this.configCache.set(key, { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS })
      }
      return config
    })()

    this.configInFlight.set(key, request)
    try {
      return await request
    } finally {
      if (this.configInFlight.get(key) === request) {
        this.configInFlight.delete(key)
      }
    }
  }

  async getProviders(): Promise<ProviderCatalog> {
    return this.getProvidersForConfig(this.currentDirectory)
  }

  /**
   * Providers, models, and the default model OpenCode resolves for a directory.
   *
   * The providers of a directory inside an isolated space are the host's: a space offers the
   * host's catalog, and the host refuses its provider routes across the boundary, so they are
   * asked of the host with no directory. Models and the default come from the space as usual.
   *
   * `fresh`: a request already in flight started before the caller's reason to re-read (a
   * catalog event), so it may carry the old catalog. Wait it out and read again.
   */
  async getProvidersForConfig(directory?: string | null, options?: { fresh?: boolean }): Promise<ProviderCatalog> {
    const effectiveDirectory = this.resolveDirectory(directory)
    const key = effectiveDirectory ?? ""

    let existing = this.providerCatalogInFlight.get(key)
    if (existing && options?.fresh) {
      await existing.catch(() => undefined)
      existing = this.providerCatalogInFlight.get(key)
    }
    if (existing) {
      return existing
    }

    const request = (async () => {
      const client = this.clientFor(effectiveDirectory)
      const providerClient = isSpaceDirectory(effectiveDirectory) ? this.client : client
      const [providers, models, fallback] = await Promise.all([
        call("provider.list", () => providerClient.provider.list().then((r) => r.data)),
        call("model.list", () => client.model.list().then((r) => r.data)),
        call("model.default", () => client.model.default().then((r) => r.data)).catch(() => undefined),
      ])
      return compact({
        providers,
        models: models.map((model) => (
          Array.isArray(model.variants) ? model : { ...model, variants: [] }
        )),
        default: fallback ? { id: fallback.modelID, providerID: fallback.providerID } : undefined,
      })
    })()

    this.providerCatalogInFlight.set(key, request)
    try {
      return await request
    } finally {
      if (this.providerCatalogInFlight.get(key) === request) this.providerCatalogInFlight.delete(key)
    }
  }

  /**
   * Throws on fetch failure so caller-side retry loops (see useAgentsStore)
   * can observe failure and retry; silently returning an empty list would
   * defeat retries and clear the cached agent list.
   */
  async listAgents(directory?: string | null): Promise<Agent[]> {
    const effectiveDirectory = this.resolveDirectory(directory)
    const key = effectiveDirectory ?? ""

    const existing = this.listAgentsInFlight.get(key)
    if (existing) {
      return existing
    }

    const request = call("agent.list", () => this.clientFor(effectiveDirectory).agent.list().then((r) => r.data.map(projectAgent)))

    this.listAgentsInFlight.set(key, request)
    try {
      return await request
    } finally {
      if (this.listAgentsInFlight.get(key) === request) this.listAgentsInFlight.delete(key)
    }
  }

  /** Retire a pre-change list so the next caller starts a fresh request. */
  invalidateAgentList(directory?: string | null): void {
    const effectiveDirectory = this.resolveDirectory(directory)
    const key = effectiveDirectory ?? ""
    this.listAgentsInFlight.delete(key)
  }

  clearAgentListRequests(): void {
    this.listAgentsInFlight.clear()
  }

  async listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]> {
    return call("command.list", () => this.clientFor(directory).command.list(undefined, { signal }).then((r) => r.data))
  }

  async listSkills(directory?: string | null): Promise<Skill[]> {
    return call("skill.list", () => this.clientFor(directory).skill.list().then((r) => r.data))
  }

  /**
   * Maps the names the composer knows to OpenCode skill ids. The composer's
   * registry is keyed by name, while a prompt attaches skills by id (the
   * skill's folder, which a frontmatter `name` can differ from). A name
   * OpenCode does not list, or a failed list, leaves the name unresolved so
   * the caller can fall back instead of losing the mention.
   */
  private async resolveSkillMentions(
    names: readonly string[],
    directory?: string | null,
  ): Promise<{ attached: SkillAttachmentRef[]; unresolved: string[] }> {
    if (names.length === 0) return { attached: [], unresolved: [] }
    let known: Skill[]
    try {
      known = await this.listSkills(directory)
    } catch (error) {
      console.warn("[opencode] Could not list skills; naming them in an instruction instead:", error)
      return { attached: [], unresolved: [...names] }
    }
    const attached: SkillAttachmentRef[] = []
    const unresolved: string[] = []
    for (const name of names) {
      const match = known.find((skill) => skill.name === name) ?? known.find((skill) => skill.id === name)
      if (!match) unresolved.push(name)
      else if (!attached.some((skill) => skill.id === match.id)) attached.push({ id: match.id, name })
    }
    return { attached, unresolved }
  }

  async listMcpServers(directory?: string | null): Promise<McpServerStatus[]> {
    return call("mcp.list", () => this.clientFor(directory).mcp.list().then((r) => r.data))
  }

  async connectMcpServer(server: string, directory?: string | null): Promise<void> {
    await call("mcp.connect", () => this.clientFor(directory).mcp.connect({ server }))
  }

  async disconnectMcpServer(server: string, directory?: string | null): Promise<void> {
    await call("mcp.disconnect", () => this.clientFor(directory).mcp.disconnect({ server }))
  }

  // Lightweight readiness check. Full diagnostics still live at /health.
  async checkHealth(): Promise<boolean> {
    return (await this.probeHealth()) === "healthy"
  }

  /**
   * Classifies the OpenCode health probe. "unreachable" means the OpenChamber
   * server did not answer (network error or timeout); "unhealthy" means it
   * answered but OpenCode is not ready.
   */
  async probeHealth(): Promise<OpencodeHealthProbe> {
    const normalizedBase = this.baseUrl.endsWith("/") ? this.baseUrl.replace(/\/+$/, "") : this.baseUrl
    const healthUrl =
      normalizedBase === "/api" || normalizedBase.endsWith("/api") ? "/api/opencode/health" : `${normalizedBase}/opencode/health`
    markStartupTrace("opencodeClient.checkHealth:url", { baseUrl: this.baseUrl, healthUrl })
    let response: Response
    try {
      const timeout = createTimeoutSignal(OPENCODE_HEALTH_TIMEOUT_MS)
      response = await runtimeFetch(healthUrl, { signal: timeout.signal }).finally(timeout.cleanup)
    } catch {
      return "unreachable"
    }
    markStartupTrace("opencodeClient.checkHealth:response", { status: response.status })
    // A gateway error means a proxy answered for a server it could not reach.
    if (response.status === 502 || response.status === 504) {
      return "unreachable"
    }
    if (!response.ok) {
      return "unhealthy"
    }
    try {
      const healthData = await response.json()
      markStartupTrace("opencodeClient.checkHealth:result", { healthy: healthData?.healthy })
      return healthData?.healthy === true ? "healthy" : "unhealthy"
    } catch {
      return "unhealthy"
    }
  }

  // -------------------------------------------------------------------------
  // File System Operations (OpenChamber routes)
  // -------------------------------------------------------------------------

  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean; asProject?: boolean },
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi()
    if (desktopFiles?.createDirectory) {
      try {
        return await desktopFiles.createDirectory(dirPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message || "Failed to create directory")
      }
    }

    if (options?.asProject) {
      const response = await runtimeFetch('/api/openchamber/directory', {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: dirPath, create: true }),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to create project directory" }))
        throw new Error(error.error || "Failed to create project directory")
      }

      const result = await response.json()
      return { success: true, path: result.path }
    }

    const payload = {
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    }

    const response = await runtimeFetch(`${this.baseUrl}/fs/mkdir`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to create directory" }))
      throw new Error(error.error || "Failed to create directory")
    }

    const result = await response.json()
    return result
  }

  async cloneRepository(input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null }): Promise<{ success: boolean; path: string; output?: string }> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/clone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to clone repository" }))
      throw new Error(error.error || "Failed to clone repository")
    }

    return await response.json()
  }

  async listLocalDirectory(directoryPath: string | null | undefined, options?: { respectGitignore?: boolean }): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === "string" ? normalizeFsPath(directoryPath.trim()) : ""
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? "1" : "0"}`
    const now = Date.now()
    const cached = this.listDirectoryCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached.entries
    }

    const inFlight = this.listDirectoryInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    const task = (async () => {
      const desktopFiles = getDesktopFilesApi()
      try {
        if (desktopFiles) {
          const result = await desktopFiles.listDirectory(directoryPath || "", options)
          if (!result || !Array.isArray(result.entries)) {
            throw new FilesystemError("Directory listing returned an invalid response", {
              reason: "invalid-response",
            })
          }
          const entries = result.entries.map<FilesystemEntry>((entry) => ({
            name: entry.name,
            path: normalizeFsPath(entry.path),
            isDirectory: !!entry.isDirectory,
            isFile: !entry.isDirectory,
            isSymbolicLink: false,
          }))
          this.listDirectoryCache.set(cacheKey, {
            entries,
            expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
          })
          return entries
        }

        const params = new URLSearchParams()
        if (directoryPath && directoryPath.trim().length > 0) {
          params.set("path", directoryPath)
        }
        if (options?.respectGitignore) {
          params.set("respectGitignore", "true")
        }
        const query = params.toString()
        const response = await runtimeFetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ""}`)
        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          const message = typeof error.error === "string" ? error.error : "Failed to list directory"
          throw new FilesystemError(message, {
            reason: parseFilesystemErrorReason((error as { reason?: unknown }).reason),
            status: response.status,
          })
        }

        const result = await response.json()
        if (!result || !Array.isArray(result.entries)) {
          throw new FilesystemError("Directory listing returned an invalid response", {
            reason: "invalid-response",
          })
        }

        const entries = result.entries as FilesystemEntry[]
        this.listDirectoryCache.set(cacheKey, {
          entries,
          expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
        })
        return entries
      } catch (error) {
        console.error("Failed to list directory contents:", error)
        throw error
      }
    })()

    const trackedTask = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === trackedTask) {
        this.listDirectoryInFlight.delete(cacheKey)
      }
    })
    this.listDirectoryInFlight.set(cacheKey, trackedTask)
    return trackedTask
  }

  /** Fuzzy file search inside a directory through OpenCode's file index. */
  async searchFiles(
    query: string,
    options?: {
      directory?: string | null
      limit?: number
      type?: "file" | "directory"
    },
  ): Promise<ProjectFileSearchHit[]> {
    const directory = this.resolveDirectory(options?.directory)
    const normalizedDirectory = directory ? normalizeFsPath(directory) : null

    try {
      const response = await call("file.find", () =>
        this.clientFor(directory).file.find({
          query,
          limit: options?.limit !== undefined && Number.isFinite(options.limit) ? options.limit : undefined,
          type: options?.type,
        }),
      )

      return response.data.map<ProjectFileSearchHit>((item) => {
        const normalizedRelativePath = normalizeFsPath(item.path)
        const name = normalizedRelativePath.split("/").filter(Boolean).pop() || normalizedRelativePath
        const normalizedPath = normalizedDirectory
          ? normalizeFsPath(`${normalizedDirectory}/${normalizedRelativePath}`)
          : normalizeFsPath(normalizedRelativePath)

        return {
          name,
          path: normalizedPath,
          relativePath: normalizedRelativePath,
          extension: name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined,
        }
      })
    } catch (error) {
      console.error("Failed to search files:", error)
      throw error
    }
  }

  async getFilesystemHome(): Promise<string | null> {
    // The injected desktop home describes the LOCAL machine. It is only a
    // valid answer while the active runtime is the local one — after an
    // in-place switch to a remote host the home must come from that host's
    // /api/fs/home, not from the local Electron global.
    const runtimeKey = getRuntimeKey()
    if (!runtimeKey || runtimeKey === "local") {
      const desktopHome = await getDesktopHomeDirectory()
      if (desktopHome) {
        return desktopHome
      }
    }

    try {
      const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        const message =
          typeof error.error === "string" && error.error.length > 0 ? error.error : "Failed to resolve home directory"
        throw new Error(message)
      }

      const payload = await response.json()
      if (payload && typeof payload.home === "string" && payload.home.length > 0) {
        return payload.home
      }
      return null
    } catch (error) {
      console.warn("Failed to resolve filesystem home directory:", error)
      return null
    }
  }

  // Both roots must describe the same server response, including on desktop.
  // Failure is distinct from an older server omitting chatsRoot.
  async getFilesystemHomeInfo(): Promise<z.infer<typeof fsHomeResponseSchema>> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })
    if (!response.ok) {
      throw new Error(`Failed to resolve the chats root (${response.status})`)
    }
    return fsHomeResponseSchema.parse(await response.json())
  }

  async setOpenCodeWorkingDirectory(directoryPath: string | null | undefined): Promise<DirectorySwitchResult | null> {
    if (!directoryPath || typeof directoryPath !== "string" || !directoryPath.trim()) {
      console.warn("[OpencodeClient] setOpenCodeWorkingDirectory: invalid path", directoryPath)
      return null
    }

    const url = '/api/openchamber/directory'

    try {
      const response = await runtimeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: directoryPath }),
      })

      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        const error = payload ?? {}
        const message =
          typeof error.error === "string" && error.error.length > 0 ? error.error : "Failed to update OpenCode working directory"
        throw new Error(message)
      }

      if (payload && typeof payload === "object") {
        return payload as DirectorySwitchResult
      }

      return {
        success: true,
        restarted: false,
        path: directoryPath,
      }
    } catch (error) {
      console.warn("Failed to update OpenCode working directory:", error)
      throw error
    }
  }
}

// Exported singleton instance
export const opencodeClient = new OpencodeService()
