/**
 * Test fixtures for the multi-host sidebar components.
 *
 * These fixtures are for testing only and must NOT be imported by production code.
 */

import type {
  HostDescriptor,
  HostId,
  HostProjectSummary,
  HostSessionStatus,
  HostSessionSummary,
  HostSnapshot,
  HostTransport,
} from '@/multi-host';
import type { SessionExtraStatus } from './multi-host-sidebar-types';

// ---------------------------------------------------------------------------
// Host IDs
// ---------------------------------------------------------------------------

export const HOST_ID_MAC_STUDIO = 'host_mac_studio' as HostId;
export const HOST_ID_MACBOOK = 'host_macbook_pro' as HostId;
export const HOST_ID_OFFLINE = 'host_offline_server' as HostId;

// ---------------------------------------------------------------------------
// Transport descriptors
// ---------------------------------------------------------------------------

export const TRANSPORT_LOCAL: HostTransport = { kind: 'local' };

export const TRANSPORT_DIRECT_LAN: HostTransport = {
  kind: 'direct',
  apiUrl: 'http://192.168.1.100:4096',
};

export const TRANSPORT_SSH: HostTransport = {
  kind: 'ssh',
  sshEndpoint: '10.0.0.5:22',
};

export const TRANSPORT_RELAY: HostTransport = {
  kind: 'relay',
  relayServerId: 'relay-us-east-1',
};

// ---------------------------------------------------------------------------
// Host descriptors
// ---------------------------------------------------------------------------

export const DESCRIPTOR_MAC_STUDIO: HostDescriptor = {
  hostId: HOST_ID_MAC_STUDIO,
  label: 'Mac Studio',
  transport: TRANSPORT_LOCAL,
};

export const DESCRIPTOR_MACBOOK: HostDescriptor = {
  hostId: HOST_ID_MACBOOK,
  label: 'MacBook Pro',
  transport: TRANSPORT_RELAY,
};

export const DESCRIPTOR_OFFLINE: HostDescriptor = {
  hostId: HOST_ID_OFFLINE,
  label: 'Ubuntu Server (offline)',
  transport: TRANSPORT_SSH,
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const PROJECT_A: HostProjectSummary = {
  id: 'proj_a',
  name: 'project-alpha',
  directory: '/Users/dev/project-alpha',
};

export const PROJECT_B: HostProjectSummary = {
  id: 'proj_b',
  name: 'project-beta',
  directory: '/Users/dev/project-beta',
};

export const PROJECT_X: HostProjectSummary = {
  id: 'proj_x',
  name: 'project-x',
  directory: '/Users/dev/project-x',
};

// Two hosts with same project basename
export const PROJECT_SAME_NAME: HostProjectSummary = {
  id: 'proj_shared',
  name: 'shared-project',
  directory: '/Users/dev/shared-project',
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_IMPLEMENTS_MONITOR: HostSessionSummary = {
  id: 'sess_001',
  title: 'Implement monitor',
  directory: '/Users/dev/project-alpha',
  projectId: 'proj_a',
  createdAt: 1700000000000,
  updatedAt: 1700003600000,
};

export const SESSION_FIX_PARSER: HostSessionSummary = {
  id: 'sess_002',
  title: 'Fix parser',
  directory: '/Users/dev/project-alpha',
  projectId: 'proj_a',
  createdAt: 1700000100000,
  updatedAt: 1700003700000,
};

export const SESSION_REFACTOR_API: HostSessionSummary = {
  id: 'sess_003',
  title: 'Refactor API',
  directory: '/Users/dev/project-beta',
  projectId: 'proj_b',
  createdAt: 1700000200000,
  updatedAt: 1700003800000,
};

export const SESSION_TEST_WORKFLOW: HostSessionSummary = {
  id: 'sess_004',
  title: 'Test workflow',
  directory: '/Users/dev/project-x',
  projectId: 'proj_x',
  createdAt: 1700000300000,
  updatedAt: 1700003900000,
};

// Same session ID on different hosts
export const SESSION_DUPLICATE_ID: HostSessionSummary = {
  id: 'sess_dup',
  title: 'Shared session ID (different host)',
  directory: '/Users/dev/shared-project',
  projectId: 'proj_shared',
  createdAt: 1700000400000,
  updatedAt: 1700004000000,
};

// Long title for truncation test
export const SESSION_LONG_TITLE: HostSessionSummary = {
  id: 'sess_long',
  title:
    'This is an extremely long session title that should be truncated when rendered in the sidebar to prevent layout overflow issues',
  directory: '/Users/dev/project-alpha',
  projectId: 'proj_a',
  createdAt: 1700000500000,
  updatedAt: 1700004100000,
};

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const STATUS_BUSY: HostSessionStatus = { status: 'busy' };
export const STATUS_RETRY: HostSessionStatus = { status: 'retry' };
// idle is represented by undefined (no entry in statuses map)

// ---------------------------------------------------------------------------
// Extra status overlays (for waiting permission/question)
// ---------------------------------------------------------------------------

export const EXTRA_WAITING_PERMISSION: SessionExtraStatus = {
  hasWaitingPermission: true,
};

export const EXTRA_WAITING_QUESTION: SessionExtraStatus = {
  hasWaitingQuestion: true,
};

export const EXTRA_ERROR: SessionExtraStatus = {
  hasError: true,
};

// ---------------------------------------------------------------------------
// Host snapshots (complete state for replaceHostSnapshot)
// ---------------------------------------------------------------------------

export const SNAPSHOT_MAC_STUDIO: HostSnapshot = {
  descriptor: DESCRIPTOR_MAC_STUDIO,
  connection: { state: 'connected', connectedAt: '2025-01-15T10:00:00Z' },
  projects: [PROJECT_A, PROJECT_B],
  sessions: {
    sess_001: SESSION_IMPLEMENTS_MONITOR,
    sess_002: SESSION_FIX_PARSER,
    sess_003: SESSION_REFACTOR_API,
  },
  statuses: {
    sess_001: STATUS_BUSY,
  },
  unreadBySession: {
    sess_002: 3,
  },
};

export const SNAPSHOT_MACBOOK: HostSnapshot = {
  descriptor: DESCRIPTOR_MACBOOK,
  connection: { state: 'connecting' },
  projects: [PROJECT_X],
  sessions: {
    sess_004: SESSION_TEST_WORKFLOW,
  },
  statuses: {},
  unreadBySession: {},
};

export const SNAPSHOT_OFFLINE: HostSnapshot = {
  descriptor: DESCRIPTOR_OFFLINE,
  connection: { state: 'disconnected' },
  projects: [],
  sessions: {},
  statuses: {},
  unreadBySession: {},
};

// Empty snapshot (no hosts)
export const EMPTY_SNAPSHOT: HostSnapshot = {
  descriptor: DESCRIPTOR_OFFLINE,
  connection: { state: 'disconnected' },
  projects: [],
  sessions: {},
  statuses: {},
  unreadBySession: {},
};

// ---------------------------------------------------------------------------
// Extra status maps for tests
// ---------------------------------------------------------------------------

export const EXTRAS_WAITING_PERMISSION: Record<string, SessionExtraStatus> = {
  sess_003: EXTRA_WAITING_PERMISSION,
};

export const EXTRAS_WAITING_QUESTION: Record<string, SessionExtraStatus> = {
  sess_004: EXTRA_WAITING_QUESTION,
};
