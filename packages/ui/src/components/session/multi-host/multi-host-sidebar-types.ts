/**
 * Local types for the multi-host sidebar components.
 *
 * These types are derived from the frozen multi-host domain types but are
 * owned by this PR. They extend the domain layer with UI-specific concerns
 * like derived display status and grouping.
 */

import type {
  HostConnectionSummary,
  HostId,
  HostSessionRef,
  HostSessionStatus,
  HostTransport,
} from '@/multi-host';

// ---------------------------------------------------------------------------
// Derived display status (priority-ordered)
// ---------------------------------------------------------------------------

/**
 * Session display status derived from store state + optional external overlays.
 * Priority: waiting-permission > waiting-question > error > busy > retry > unread > idle.
 */
export type DerivedSessionStatus =
  | 'waiting-permission'
  | 'waiting-question'
  | 'error'
  | 'busy'
  | 'retry'
  | 'unread'
  | 'idle';

// ---------------------------------------------------------------------------
// Extra status overlay (injected by integration layer)
// ---------------------------------------------------------------------------

/**
 * Optional per-session status overlays that come from outside the frozen
 * multi-host store (e.g., from the sync layer's pending permission/question
 * state). The sidebar consumes these via a callback prop without knowing
 * how they are produced.
 */
export type SessionExtraStatus = {
  hasWaitingPermission?: boolean;
  hasWaitingQuestion?: boolean;
  hasError?: boolean;
};

// ---------------------------------------------------------------------------
// Host summary (computed for display)
// ---------------------------------------------------------------------------

export type HostSummary = {
  hostId: HostId;
  label: string;
  transport: HostTransport;
  connection: HostConnectionSummary;
  unreadTotal: number;
  waitingPermissionCount: number;
  waitingQuestionCount: number;
  hasBusySession: boolean;
  sessionCount: number;
};

// ---------------------------------------------------------------------------
// Project grouping
// ---------------------------------------------------------------------------

export type ProjectGroup = {
  projectId: string;
  projectName: string;
  directory: string;
  sessions: ProjectSession[];
  unreadCount: number;
  sessionCount: number;
};

export type ProjectSession = {
  ref: HostSessionRef;
  session: HostSessionSummary;
  status: DerivedSessionStatus;
  unreadCount: number;
};

// ---------------------------------------------------------------------------
// Fold state helpers
// ---------------------------------------------------------------------------

export const FOLD_KEY_PREFIX_HOST = 'host:';
export const FOLD_KEY_PREFIX_PROJECT = 'project:';

export const hostFoldKey = (hostId: HostId): string =>
  `${FOLD_KEY_PREFIX_HOST}${hostId}`;

export const projectFoldKey = (hostId: HostId, projectId: string): string =>
  `${FOLD_KEY_PREFIX_PROJECT}${hostId}:${projectId}`;

// ---------------------------------------------------------------------------
// Derive display status from store status + extras
// ---------------------------------------------------------------------------

export function deriveSessionStatus(
  storeStatus: HostSessionStatus | undefined,
  unreadCount: number,
  extra?: SessionExtraStatus,
): DerivedSessionStatus {
  if (extra?.hasWaitingPermission) return 'waiting-permission';
  if (extra?.hasWaitingQuestion) return 'waiting-question';
  if (extra?.hasError) return 'error';
  if (storeStatus?.status === 'busy') return 'busy';
  if (storeStatus?.status === 'retry') return 'retry';
  if (unreadCount > 0) return 'unread';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Transport kind labels
// ---------------------------------------------------------------------------

export function transportKindLabel(transport: HostTransport): string {
  switch (transport.kind) {
    case 'local':
      return 'Local';
    case 'direct':
      return 'LAN';
    case 'ssh':
      return 'SSH';
    case 'relay':
      return 'Relay';
  }
}

// ---------------------------------------------------------------------------
// Connection state labels
// ---------------------------------------------------------------------------

export function connectionStateLabel(state: HostConnectionSummary['state']): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return 'Error';
  }
}

// ---------------------------------------------------------------------------
// Transport icon names (maps to Icon component names)
// ---------------------------------------------------------------------------

export function transportIconName(transport: HostTransport): string {
  switch (transport.kind) {
    case 'local':
      return 'computer';
    case 'direct':
      return 'server';
    case 'ssh':
      return 'terminal';
    case 'relay':
      return 'cloud';
  }
}
