/**
 * Event normalizer for multi-host monitor.
 *
 * Converts raw server events (same shape as the SDK Event type) into
 * NormalizedHostEvent instances that can be safely written to the
 * multi-host store.
 *
 * High-frequency / irrelevant events (message deltas, tool progress,
 * streaming, LSP, etc.) are silently dropped.
 *
 * Incomplete events (missing required fields) trigger a host refresh
 * instead of creating malformed session refs.
 */

import type { HostId, HostSessionStatus, HostSessionSummary } from '../types';
import type { MonitorEventFrame, NormalizedHostEvent } from './types';

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

const normalizeStatusType = (type: unknown): HostSessionStatus['status'] | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

// ---------------------------------------------------------------------------
// Session info extraction (from session.created / session.updated)
// ---------------------------------------------------------------------------

function extractSessionSummary(
  properties: Record<string, unknown>,
): HostSessionSummary | null {
  const info = properties?.info;
  if (!info || typeof info !== 'object') return null;
  const record = info as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;

  const time = record.time as Record<string, unknown> | undefined;

  return {
    id: record.id as string,
    title: typeof record.title === 'string' ? record.title : undefined,
    directory: typeof record.directory === 'string' ? record.directory : undefined,
    projectId: typeof record.projectID === 'string' ? record.projectID : undefined,
    createdAt: typeof time?.created === 'number' ? time.created : undefined,
    updatedAt: typeof time?.updated === 'number' ? time.updated : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

/** Event types we care about for sidebar summary updates. */
const RELEVANT_EVENT_TYPES = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
  'session.error',
  'permission.v2.asked',
  'permission.v2.replied',
  'permission.asked',
  'permission.replied',
  'question.v2.asked',
  'question.v2.replied',
  'question.v2.rejected',
  'question.asked',
  'question.replied',
  'question.rejected',
]);

/**
 * Normalize a raw event frame from a host's event stream into zero or more
 * NormalizedHostEvent instances.
 *
 * Returns an empty array for irrelevant events (message streaming, tool
 * progress, LSP, etc.).
 *
 * Returns a "host-refresh-required" event if the raw event lacks fields
 * needed to construct a complete HostSessionSummary — rather than creating
 * an incomplete session ref.
 */
export function normalizeHostEvent(
  hostId: HostId,
  frame: MonitorEventFrame,
): NormalizedHostEvent[] {
  const { payload } = frame;
  const eventType = payload.type;

  // Strip trailing ".N" suffix (e.g. "session.status.1" → "session.status")
  const normalizedType = eventType.replace(/\.\d+$/, '');

  if (!RELEVANT_EVENT_TYPES.has(normalizedType)) {
    return [];
  }

  const props = payload.properties ?? {};

  switch (normalizedType) {
    case 'session.created':
    case 'session.updated': {
      const summary = extractSessionSummary(props);
      if (!summary) {
        // Incomplete event — trigger refresh rather than create bad state.
        return [{ type: 'host-refresh-required', hostId }];
      }
      return [{ type: 'session-upsert', hostId, session: summary }];
    }

    case 'session.deleted': {
      const sessionID =
        typeof props.sessionID === 'string'
          ? props.sessionID
          : typeof (props.info as Record<string, unknown>)?.id === 'string'
            ? (props.info as Record<string, unknown>).id as string
            : '';
      if (!sessionID) {
        return [{ type: 'host-refresh-required', hostId }];
      }
      return [{ type: 'session-remove', hostId, sessionId: sessionID }];
    }

    case 'session.status': {
      const sessionID = typeof props.sessionID === 'string' ? props.sessionID : '';
      if (!sessionID) {
        return [{ type: 'host-refresh-required', hostId }];
      }
      const statusObj = props.status as Record<string, unknown> | undefined;
      const rawType = statusObj?.type;
      const normalized = normalizeStatusType(rawType);
      if (normalized === 'idle') {
        // idle means the server omits it from status snapshots — treat as idle
        return [{ type: 'session-status', hostId, sessionId: sessionID, status: 'idle' }];
      }
      return [{ type: 'session-status', hostId, sessionId: sessionID, status: normalized }];
    }

    case 'session.idle':
    case 'session.error': {
      const sessionID = typeof props.sessionID === 'string' ? props.sessionID : '';
      if (!sessionID) {
        return [{ type: 'host-refresh-required', hostId }];
      }
      return [{ type: 'session-status', hostId, sessionId: sessionID, status: 'idle' }];
    }

    // Permission / question events — we don't track them in session summary,
    // but they indicate the session has activity. We treat them as "refresh
    // required" to ensure the sidebar shows the latest state.
    case 'permission.v2.asked':
    case 'permission.asked': {
      const sessionID = typeof props.sessionID === 'string' ? props.sessionID : '';
      if (!sessionID) return [];
      // Don't update status — permission events don't change busy/idle.
      // But we could trigger a status fetch if needed.
      return [];
    }

    case 'question.v2.asked':
    case 'question.asked': {
      const sessionID = typeof props.sessionID === 'string' ? props.sessionID : '';
      if (!sessionID) return [];
      return [];
    }

    default:
      return [];
  }
}
