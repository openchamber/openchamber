
import { z } from 'zod';

import { sessionParentId } from '../session-lineage.js';
import { unwrapOpenCodeResponse } from './response-envelope.js';
import { readBoundedResponseJson } from '../shared/response-body.js';
import type { JsonValue } from '../shared/json-values.js';
import { isString } from '../shared/object-guards.js';

export type SessionReadFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SessionActivityOptions {
  buildOpenCodeUrl(route: string, directory: string): string | URL;
  getOpenCodeAuthHeaders(): Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: SessionReadFetch;
  signal?: AbortSignal | undefined;
}

export interface RunningSessionShell {
  sessionID: string;
  command: string;
  startedAt: number;
  /** The timeout the shell was started with, when it set one. */
  timeoutMs?: number;
}

export interface RunningSessionJob {
  kind: string;
  sessionID: string;
  command: string | undefined;
  startedAt: number;
}

export type SessionActivityProbe = ReturnType<typeof createSessionActivityProbe>;

const hasTag = (value: unknown): value is { _tag?: unknown } => value != null;

const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000;
const MAX_SUBAGENT_DEPTH = 8;
const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;
// 16 MiB matches the session-list proxy cap and leaves room for a 50-record page.
const SESSION_ACTIVITY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const childSessionPageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});
const childSessionSchema = z.object({ id: z.string().min(1) }).passthrough();
const workingChildSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() }).passthrough();
// `/api/session/active` lists only running sessions, by nonempty id. A body
// of any other shape is no answer: it must never read as "nothing running".
const activeSessionsSchema = z.record(z.string().min(1), z.object({ type: z.literal('running') }).passthrough());

export type ChildSession = z.infer<typeof childSessionSchema>;
const sessionLineageSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().min(1).nullish(),
  metadata: z.unknown().optional(),
});
const runningShellsSchema = z.array(z.object({
  status: z.string(),
  command: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  time: z.object({ started: z.number() }),
}));
const backgroundJobsSchema = z.array(z.object({
  kind: z.string(),
  sessionID: z.string(),
  status: z.string(),
  command: z.string().optional(),
  time: z.object({ started: z.number() }),
}));

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch, signal: parentSignal }: SessionActivityOptions) => {
  const requestSignal = () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  };
  const openCodeGet = async (fetchPath: string, query?: Record<string, string>, signal = requestSignal()) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode GET ${fetchPath} failed with ${response.status}`);
    }
    const body: JsonValue = await readBoundedResponseJson(response, SESSION_ACTIVITY_RESPONSE_MAX_BYTES);
    return unwrapOpenCodeResponse(body);
  };

  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    const parsed = activeSessionsSchema.safeParse(statuses);
    return parsed.success ? parsed.data : null;
  };

  /**
   * v2 has no `/session/{id}/children`; `GET /api/session?parentID=` lists a
   * parent's subagent sessions, newest first, in cursor pages. Later pages
   * carry the filter inside the cursor, so only the cursor and the limit
   * travel. A parent with more subagents than this walks is unknown (`null`).
   */
  const fetchChildSessions = async (sessionId: string): Promise<ChildSession[] | null> => {
    const children: ChildSession[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < CHILDREN_MAX_PAGES; pageNumber += 1) {
      const page = childSessionPageSchema.safeParse(await openCodeGet('/api/session', {
        limit: String(CHILDREN_PAGE_SIZE),
        ...(cursor ? { cursor } : { parentID: sessionId }),
      }).catch(() => null));
      if (!page.success) return null;
      for (const entry of page.data.data) {
        const child = childSessionSchema.safeParse(entry);
        if (child.success) children.push(child.data);
      }
      const next = page.data.cursor?.next;
      if (!next || page.data.data.length === 0 || seenCursors.has(next)) return children;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  };

  /**
   * The running direct subagents of a session, read from the active set: each
   * running session's own record names its parent, so no historical child is
   * paged. Null when a running session's record could not be read.
   */
  const fetchWorkingChildSessions = async (sessionId: string, statuses: NonNullable<Awaited<ReturnType<typeof fetchActiveSessionStatuses>>>): Promise<ChildSession[] | null> => {
    const signal = requestSignal();
    const children: ChildSession[] = [];
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      const record = await openCodeGet(`/api/session/${encodeURIComponent(activeId)}`, undefined, signal).catch(() => undefined);
      const parsed = workingChildSchema.safeParse(record);
      if (!parsed.success) return null;
      if (parsed.data.parentID === sessionId) children.push(parsed.data);
    }
    return children;
  };

  // Parent links fetched for one active-status snapshot, shared by every
  // descendant check made against that snapshot: a sweep asking about
  // hundreds of candidates against the same active set would otherwise
  // re-fetch the same lineage records for every candidate. The cache is
  // keyed by the statuses object itself, so a fresh snapshot starts fresh
  // and the old one is collected with it.
  const lineageCaches = new WeakMap<object, Map<string, { id: string | null; viaWorkflowLink: boolean } | undefined>>();

  const hasWorkingWithinDepth = async (sessionId: string, statuses: NonNullable<Awaited<ReturnType<typeof fetchActiveSessionStatuses>>>, maxDepth: number, directOnly = false) => {
    let parents = lineageCaches.get(statuses);
    if (!parents) {
      parents = new Map();
      lineageCaches.set(statuses, parents);
    }
    const signal = requestSignal();
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      let current: string | null = activeId;
      const visited = new Set<string>();
      for (let depth = 0; current && depth < maxDepth; depth += 1) {
        if (signal.aborted) return null;
        if (visited.has(current)) {
          unknown = true;
          break;
        }
        visited.add(current);
        if (!parents.has(current)) {
          const body = await openCodeGet(`/api/session/${encodeURIComponent(current)}`, undefined, signal).catch(() => null);
          const parsed = sessionLineageSchema.safeParse(body);
          parents.set(current, parsed.success && parsed.data.id === current
            ? { id: sessionParentId(parsed.data), viaWorkflowLink: !parsed.data.parentID && sessionParentId(parsed.data) !== null }
            : undefined);
        }
        const parent = parents.get(current);
        if (parent === undefined) {
          unknown = true;
          break;
        }
        if (parent.id === sessionId) {
          if (!directOnly || depth === 0 || parent.viaWorkflowLink) return true;
          break;
        }
        current = parent.id;
      }
    }
    return unknown ? null : false;
  };

  const fetchRunningShells = async (directory: string): Promise<RunningSessionShell[] | null> => {
    const base = buildOpenCodeUrl('/api/shell', '');
    const response = await fetchImpl(base, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-opencode-directory': encodeURIComponent(directory),
        ...getOpenCodeAuthHeaders(),
      },
      signal: requestSignal(),
    }).catch(() => null);
    if (!response?.ok) return null;
    const parsed = runningShellsSchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
    if (!parsed.success) return null;
    return parsed.data.flatMap((shell) => {
      const owner = shell.metadata?.sessionID;
      if (shell.status !== 'running' || !isString(owner) || !owner) return [];
      const timeout = shell.metadata?.timeout;
      const running: RunningSessionShell = { sessionID: owner, command: shell.command, startedAt: shell.time.started };
      if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) running.timeoutMs = timeout;
      return [running];
    });
  };

  const fetchRunningBackgroundJobs = async (sessionId: string): Promise<RunningSessionJob[] | null | undefined> => {
    const base = buildOpenCodeUrl('/api/experimental/job', '');
    const search = new URLSearchParams({ sessionID: sessionId, descendants: 'true', status: 'running' });
    const response = await fetchImpl(`${base}?${search}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: requestSignal(),
    }).catch(() => null);
    if (!response) return null;
    const body: JsonValue = await response.json().catch(() => null);
    if (response.status === 404 && !(hasTag(body) ? body._tag : undefined)) return undefined;
    if (!response.ok) return null;
    const parsed = backgroundJobsSchema.safeParse(unwrapOpenCodeResponse(body));
    if (!parsed.success) return null;
    const now = Date.now();
    return parsed.data
      .filter((job) => job.status === 'running')
      .filter((job) => job.kind !== 'image' || now - job.time.started <= IMAGE_JOB_LIFETIME_MS)
      .map((job) => ({ kind: job.kind, sessionID: job.sessionID, command: job.command, startedAt: job.time.started }));
  };

  return {
    fetchActiveSessionStatuses,
    hasWorkingChildren: (sessionId: string, statuses: NonNullable<Awaited<ReturnType<typeof fetchActiveSessionStatuses>>>) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH, true),
    // Chains count at any depth, as in the UI's ancestor walk: OpenCode's
    // `experimental.subagent_depth` has no upper bound, and the visited set
    // ends a walk whose parent links form a cycle.
    hasWorkingDescendants: (sessionId: string, statuses: NonNullable<Awaited<ReturnType<typeof fetchActiveSessionStatuses>>>) => hasWorkingWithinDepth(sessionId, statuses, Number.POSITIVE_INFINITY),
    fetchChildSessions,
    fetchWorkingChildSessions,
    fetchRunningShells,
    fetchRunningBackgroundJobs,
  };
};
