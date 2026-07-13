/**
 * Reconciliation logic for a single host monitor.
 *
 * Periodically refreshes the host's session/project/status snapshot from the
 * server to catch missed events. The refresh:
 * - Replaces server-derived sessions/projects/statuses
 * - Preserves local unread counts for still-existing sessions
 * - Removes sessions/statuses for sessions the server no longer reports
 * - Does NOT affect other hosts
 */

import type { HostDescriptor, HostId, HostProjectSummary, HostSessionStatus, HostSessionSummary, HostSnapshot } from '../types';
import type { HostMonitorTransport } from './types';

// ---------------------------------------------------------------------------
// Refresh result
// ---------------------------------------------------------------------------

export type ReconcileResult = {
  snapshot: HostSnapshot;
  /** True if the fetch succeeded (even if data was empty). */
  ok: boolean;
  /** Error message if the fetch failed. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(
  transport: HostMonitorTransport,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await transport.request({ method: 'GET', path, signal });
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.data;
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

async function fetchProjects(
  transport: HostMonitorTransport,
  signal?: AbortSignal,
): Promise<HostProjectSummary[]> {
  const data = await fetchJson(transport, '/project/list', signal);
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (p): p is { id: string; name?: string; worktree?: string } =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>).id === 'string' &&
        ((p as Record<string, unknown>).id as string).length > 0,
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      directory: p.worktree,
    }));
}

// ---------------------------------------------------------------------------
// Session list (lightweight)
// ---------------------------------------------------------------------------

async function fetchSessions(
  transport: HostMonitorTransport,
  signal?: AbortSignal,
): Promise<HostSessionSummary[]> {
  const data = await fetchJson(transport, '/session', signal);
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (s): s is Record<string, unknown> =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Record<string, unknown>).id === 'string',
    )
    .map((s) => {
      const time = s.time as Record<string, unknown> | undefined;
      return {
        id: s.id as string,
        title: typeof s.title === 'string' ? s.title : undefined,
        directory: typeof s.directory === 'string' ? s.directory : undefined,
        projectId: typeof s.projectID === 'string' ? s.projectID : undefined,
        createdAt: typeof time?.created === 'number' ? (time.created as number) : undefined,
        updatedAt: typeof time?.updated === 'number' ? (time.updated as number) : undefined,
      };
    });
}

// ---------------------------------------------------------------------------
// Session status map
// ---------------------------------------------------------------------------

async function fetchSessionStatuses(
  transport: HostMonitorTransport,
  signal?: AbortSignal,
): Promise<Record<string, HostSessionStatus>> {
  const data = await fetchJson(transport, '/session/status', signal);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const raw = data as Record<string, { type?: unknown }>;
  const result: Record<string, HostSessionStatus> = {};
  for (const [sessionId, status] of Object.entries(raw)) {
    if (status?.type === 'busy') {
      result[sessionId] = { status: 'busy' };
    } else if (status?.type === 'retry') {
      result[sessionId] = { status: 'retry' };
    }
    // idle is omitted from the map (server convention)
  }
  return result;
}

// ---------------------------------------------------------------------------
// Full reconciliation refresh
// ---------------------------------------------------------------------------

/**
 * Perform a full refresh of a host's state. Returns a complete HostSnapshot
 * suitable for `replaceHostSnapshot`.
 *
 * On fetch failure, returns `ok: false` so the caller can decide whether
 * to overwrite state.
 */
export async function reconcileHost(
  hostId: HostId,
  descriptor: HostDescriptor,
  transport: HostMonitorTransport,
  existingSnapshot?: HostSnapshot,
  signal?: AbortSignal,
): Promise<ReconcileResult> {
  try {
    const [projects, sessions, statuses] = await Promise.all([
      fetchProjects(transport, signal),
      fetchSessions(transport, signal),
      fetchSessionStatuses(transport, signal),
    ]);

    // Build sessions record
    const sessionsRecord: Record<string, HostSessionSummary> = {};
    for (const s of sessions) {
      sessionsRecord[s.id] = s;
    }

    const snapshot: HostSnapshot = {
      descriptor,
      connection: {
        state: 'connected',
        connectedAt: existingSnapshot?.connection.connectedAt ?? new Date().toISOString(),
      },
      projects,
      sessions: sessionsRecord,
      statuses,
      unreadBySession: {},
    };

    return { snapshot, ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Reconciliation failed';
    return {
      snapshot: {
        descriptor,
        connection: {
          state: 'error',
          error: message,
        },
        projects: existingSnapshot?.projects ?? [],
        sessions: existingSnapshot?.sessions ?? {},
        statuses: existingSnapshot?.statuses ?? {},
        unreadBySession: existingSnapshot?.unreadBySession ?? {},
      },
      ok: false,
      error: message,
    };
  }
}
