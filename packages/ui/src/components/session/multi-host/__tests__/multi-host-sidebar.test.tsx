/**
 * Tests for multi-host sidebar components.
 *
 * Uses bun:test for pure function testing. Component structure is verified
 * via source-text regression guards (consistent with existing sidebar tests).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type {
  HostId,
  HostSessionRef,
} from '@/multi-host';
import {
  useMultiHostStore,
  selectHostSessions,
  selectHostProjects,
} from '@/multi-host';
import type { SessionExtraStatus } from '../multi-host-sidebar-types';
import {
  connectionStateLabel,
  deriveSessionStatus,
  FOLD_KEY_PREFIX_HOST,
  FOLD_KEY_PREFIX_PROJECT,
  hostFoldKey,
  projectFoldKey,
  transportIconName,
  transportKindLabel,
} from '../multi-host-sidebar-types';
import {
  DESCRIPTOR_MACBOOK,
  DESCRIPTOR_MAC_STUDIO,
  HOST_ID_MAC_STUDIO,
  HOST_ID_MACBOOK,
  SESSION_DUPLICATE_ID,
  SESSION_IMPLEMENTS_MONITOR,
  SESSION_TEST_WORKFLOW,
  STATUS_BUSY,
  STATUS_RETRY,
  TRANSPORT_DIRECT_LAN,
  TRANSPORT_LOCAL,
  TRANSPORT_RELAY,
  TRANSPORT_SSH,
} from '../fixtures';

// ---------------------------------------------------------------------------
// deriveSessionStatus
// ---------------------------------------------------------------------------

describe('deriveSessionStatus', () => {
  test('waiting-permission has highest priority', () => {
    const extra: SessionExtraStatus = { hasWaitingPermission: true };
    expect(deriveSessionStatus(STATUS_BUSY, 5, extra)).toBe('waiting-permission');
  });

  test('waiting-question beats busy', () => {
    const extra: SessionExtraStatus = { hasWaitingQuestion: true };
    expect(deriveSessionStatus(STATUS_BUSY, 0, extra)).toBe('waiting-question');
  });

  test('error beats busy', () => {
    const extra: SessionExtraStatus = { hasError: true };
    expect(deriveSessionStatus(STATUS_BUSY, 0, extra)).toBe('error');
  });

  test('busy from store status', () => {
    expect(deriveSessionStatus(STATUS_BUSY, 0)).toBe('busy');
  });

  test('retry from store status', () => {
    expect(deriveSessionStatus(STATUS_RETRY, 0)).toBe('retry');
  });

  test('unread when no store status but unread > 0', () => {
    expect(deriveSessionStatus(undefined, 3)).toBe('unread');
  });

  test('idle as default', () => {
    expect(deriveSessionStatus(undefined, 0)).toBe('idle');
  });

  test('idle when store status is idle and no unread', () => {
    expect(deriveSessionStatus({ status: 'idle' }, 0)).toBe('idle');
  });

  test('busy with unread still returns busy', () => {
    expect(deriveSessionStatus(STATUS_BUSY, 5)).toBe('busy');
  });
});

// ---------------------------------------------------------------------------
// transportKindLabel
// ---------------------------------------------------------------------------

describe('transportKindLabel', () => {
  test('local', () => {
    expect(transportKindLabel(TRANSPORT_LOCAL)).toBe('Local');
  });

  test('direct', () => {
    expect(transportKindLabel(TRANSPORT_DIRECT_LAN)).toBe('LAN');
  });

  test('ssh', () => {
    expect(transportKindLabel(TRANSPORT_SSH)).toBe('SSH');
  });

  test('relay', () => {
    expect(transportKindLabel(TRANSPORT_RELAY)).toBe('Relay');
  });
});

// ---------------------------------------------------------------------------
// connectionStateLabel
// ---------------------------------------------------------------------------

describe('connectionStateLabel', () => {
  test('connected', () => {
    expect(connectionStateLabel('connected')).toBe('Connected');
  });

  test('connecting', () => {
    expect(connectionStateLabel('connecting')).toBe('Connecting');
  });

  test('disconnected', () => {
    expect(connectionStateLabel('disconnected')).toBe('Disconnected');
  });

  test('error', () => {
    expect(connectionStateLabel('error')).toBe('Error');
  });
});

// ---------------------------------------------------------------------------
// transportIconName
// ---------------------------------------------------------------------------

describe('transportIconName', () => {
  test('local -> computer', () => {
    expect(transportIconName(TRANSPORT_LOCAL)).toBe('computer');
  });

  test('direct -> server', () => {
    expect(transportIconName(TRANSPORT_DIRECT_LAN)).toBe('server');
  });

  test('ssh -> terminal', () => {
    expect(transportIconName(TRANSPORT_SSH)).toBe('terminal');
  });

  test('relay -> cloud', () => {
    expect(transportIconName(TRANSPORT_RELAY)).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// Fold key generation
// ---------------------------------------------------------------------------

describe('fold key generation', () => {
  test('hostFoldKey uses correct prefix', () => {
    const key = hostFoldKey(HOST_ID_MAC_STUDIO);
    expect(key).toBe('host:host_mac_studio');
    expect(key.startsWith(FOLD_KEY_PREFIX_HOST)).toBe(true);
  });

  test('projectFoldKey includes hostId and projectId', () => {
    const key = projectFoldKey(HOST_ID_MAC_STUDIO, 'proj_a');
    expect(key).toBe('project:host_mac_studio:proj_a');
    expect(key.startsWith(FOLD_KEY_PREFIX_PROJECT)).toBe(true);
  });

  test('same project name on different hosts produces different keys', () => {
    const key1 = projectFoldKey(HOST_ID_MAC_STUDIO, 'proj_shared');
    const key2 = projectFoldKey(HOST_ID_MACBOOK, 'proj_shared');
    expect(key1).not.toBe(key2);
  });

  test('same projectId on different hosts produces different keys', () => {
    const key1 = projectFoldKey(HOST_ID_MAC_STUDIO, 'proj_a');
    const key2 = projectFoldKey(HOST_ID_MACBOOK, 'proj_a');
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// HostSessionRef integrity
// ---------------------------------------------------------------------------

describe('HostSessionRef integrity', () => {
  test('fixture refs contain all required fields', () => {
    const refs: HostSessionRef[] = [
      {
        hostId: HOST_ID_MAC_STUDIO,
        sessionId: SESSION_IMPLEMENTS_MONITOR.id,
        directory: SESSION_IMPLEMENTS_MONITOR.directory!,
        projectId: SESSION_IMPLEMENTS_MONITOR.projectId!,
      },
      {
        hostId: HOST_ID_MACBOOK,
        sessionId: SESSION_TEST_WORKFLOW.id,
        directory: SESSION_TEST_WORKFLOW.directory!,
        projectId: SESSION_TEST_WORKFLOW.projectId!,
      },
    ];

    for (const ref of refs) {
      expect(ref.hostId).toBeTruthy();
      expect(ref.sessionId).toBeTruthy();
      expect(ref.directory).toBeTruthy();
      expect(ref.projectId).toBeTruthy();
    }
  });

  test('same sessionId on different hosts is valid', () => {
    const ref1: HostSessionRef = {
      hostId: HOST_ID_MAC_STUDIO,
      sessionId: SESSION_DUPLICATE_ID.id,
      directory: SESSION_DUPLICATE_ID.directory!,
      projectId: SESSION_DUPLICATE_ID.projectId!,
    };
    const ref2: HostSessionRef = {
      hostId: HOST_ID_MACBOOK,
      sessionId: SESSION_DUPLICATE_ID.id,
      directory: SESSION_DUPLICATE_ID.directory!,
      projectId: SESSION_DUPLICATE_ID.projectId!,
    };

    expect(ref1.sessionId).toBe(ref2.sessionId);
    expect(ref1.hostId).not.toBe(ref2.hostId);
  });
});

// ---------------------------------------------------------------------------
// Store integration: two hosts with same sessionId
// ---------------------------------------------------------------------------

describe('store: two hosts same sessionId', () => {
  test('storing same sessionId on different hosts does not collide', () => {
    // Reset store
    useMultiHostStore.setState({ hosts: {} });

    useMultiHostStore.getState().registerHost(DESCRIPTOR_MAC_STUDIO);
    useMultiHostStore.getState().registerHost(DESCRIPTOR_MACBOOK);

    useMultiHostStore.getState().upsertSession(HOST_ID_MAC_STUDIO, SESSION_DUPLICATE_ID);
    useMultiHostStore.getState().upsertSession(HOST_ID_MACBOOK, {
      ...SESSION_DUPLICATE_ID,
      title: 'Same ID different host',
    });

    const host1 = useMultiHostStore.getState().hosts[HOST_ID_MAC_STUDIO];
    const host2 = useMultiHostStore.getState().hosts[HOST_ID_MACBOOK];

    expect(host1).toBeTruthy();
    expect(host2).toBeTruthy();
    expect(host1!.sessions[SESSION_DUPLICATE_ID.id]?.title).toBe(SESSION_DUPLICATE_ID.title);
    expect(host2!.sessions[SESSION_DUPLICATE_ID.id]?.title).toBe('Same ID different host');
  });
});

// ---------------------------------------------------------------------------
// Store integration: unread isolation
// ---------------------------------------------------------------------------

describe('store: unread isolation between hosts', () => {
  test('unread on host A does not affect host B', () => {
    useMultiHostStore.setState({ hosts: {} });

    useMultiHostStore.getState().registerHost(DESCRIPTOR_MAC_STUDIO);
    useMultiHostStore.getState().registerHost(DESCRIPTOR_MACBOOK);

    useMultiHostStore.getState().upsertSession(HOST_ID_MAC_STUDIO, SESSION_DUPLICATE_ID);
    useMultiHostStore.getState().upsertSession(HOST_ID_MACBOOK, SESSION_DUPLICATE_ID);

    useMultiHostStore.getState().markSessionUnread(HOST_ID_MAC_STUDIO, SESSION_DUPLICATE_ID.id, 5);

    const host1 = useMultiHostStore.getState().hosts[HOST_ID_MAC_STUDIO];
    const host2 = useMultiHostStore.getState().hosts[HOST_ID_MACBOOK];

    expect(host1!.unreadBySession[SESSION_DUPLICATE_ID.id]).toBe(5);
    expect(host2!.unreadBySession[SESSION_DUPLICATE_ID.id]).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Store integration: status isolation
// ---------------------------------------------------------------------------

describe('store: status isolation between hosts', () => {
  test('busy on host A does not affect host B', () => {
    useMultiHostStore.setState({ hosts: {} });

    useMultiHostStore.getState().registerHost(DESCRIPTOR_MAC_STUDIO);
    useMultiHostStore.getState().registerHost(DESCRIPTOR_MACBOOK);

    useMultiHostStore.getState().upsertSession(HOST_ID_MAC_STUDIO, SESSION_DUPLICATE_ID);
    useMultiHostStore.getState().upsertSession(HOST_ID_MACBOOK, SESSION_DUPLICATE_ID);

    useMultiHostStore.getState().setSessionStatus(HOST_ID_MAC_STUDIO, SESSION_DUPLICATE_ID.id, 'busy');

    const host1 = useMultiHostStore.getState().hosts[HOST_ID_MAC_STUDIO];
    const host2 = useMultiHostStore.getState().hosts[HOST_ID_MACBOOK];

    expect(host1!.statuses[SESSION_DUPLICATE_ID.id]?.status).toBe('busy');
    expect(host2!.statuses[SESSION_DUPLICATE_ID.id]).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Store: stable empty selectors for non-existent host
// ---------------------------------------------------------------------------

describe('store: stable empty for non-existent host', () => {
  test('selectHostSessions returns stable empty for unknown host', () => {
    const fakeId = 'nonexistent_host' as HostId;
    const result1 = selectHostSessions(fakeId);
    const result2 = selectHostSessions(fakeId);
    expect(result1).toBe(result2);
    expect(Object.keys(result1)).toHaveLength(0);
  });

  test('selectHostProjects returns stable empty for unknown host', () => {
    const fakeId = 'nonexistent_host' as HostId;
    const result1 = selectHostProjects(fakeId);
    const result2 = selectHostProjects(fakeId);
    expect(result1).toBe(result2);
    expect(result1).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source structure: components exist with correct patterns
// ---------------------------------------------------------------------------

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readSource(filename: string): string {
  return readFileSync(resolve(srcDir, filename), 'utf-8');
}

describe('source structure: MultiHostSessionTree', () => {
  test('renders HostNode for each host', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).toContain('HostNode');
    expect(src).toContain('key={`host:${hostId}`}');
  });

  test('uses useMultiHostStore with host ID selector', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).toContain('useMultiHostStore');
    expect(src).toContain('Object.keys(s.hosts)');
  });

  test('shows empty state when no hosts', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).toContain('MultiHostEmptyState');
    expect(src).toContain('sortedHostIds.length === 0');
  });

  test('does not import runtime-switch', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).not.toContain('runtime-switch');
  });

  test('does not import activation controller', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).not.toContain('activation-controller');
    expect(src).not.toContain('HostActivationController');
  });

  test('does not import monitor', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).not.toContain('monitor');
  });

  test('does not import relay registry', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    expect(src).not.toContain('relay-registry');
    expect(src).not.toContain('PrivateRelay');
  });
});

describe('source structure: HostNode', () => {
  test('subscribes to single host via useHost', () => {
    const src = readSource('HostNode.tsx');
    expect(src).toContain('useHost(hostId)');
  });

  test('renders HostConnectionIndicator', () => {
    const src = readSource('HostNode.tsx');
    expect(src).toContain('HostConnectionIndicator');
  });

  test('renders HostProjectNode for each project', () => {
    const src = readSource('HostNode.tsx');
    expect(src).toContain('HostProjectNode');
    expect(src).toContain('key={`project:${hostId}:${project.projectId}`}');
  });

  test('has collapse toggle with aria-expanded', () => {
    const src = readSource('HostNode.tsx');
    expect(src).toContain('aria-expanded');
    expect(src).toContain('onToggleHostCollapse');
  });
});

describe('source structure: HostProjectNode', () => {
  test('has collapse toggle with aria-expanded', () => {
    const src = readSource('HostProjectNode.tsx');
    expect(src).toContain('aria-expanded');
  });

  test('renders HostSessionNode for each session', () => {
    const src = readSource('HostProjectNode.tsx');
    expect(src).toContain('HostSessionNode');
    expect(src).toContain('key={`session:${hostId}:${ps.ref.sessionId}`}');
  });

  test('has collapse toggle with aria-expanded', () => {
    const src = readSource('HostProjectNode.tsx');
    expect(src).toContain('aria-expanded');
  });
});

describe('source structure: HostSessionNode', () => {
  test('renders as button for keyboard accessibility', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('<button');
    expect(src).toContain('type="button"');
  });

  test('handles Enter and Space for activation', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain("e.key === 'Enter'");
    expect(src).toContain("e.key === ' '");
  });

  test('calls onActivate with full HostSessionRef', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('onActivate(hostSessionRef)');
  });

  test('shows loading state for pending', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('isPending');
    expect(src).toContain('animate-busy-pulse');
  });

  test('highlights active session', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('isActive');
    expect(src).toContain('aria-current');
  });

  test('truncates long titles', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('truncate');
  });

  test('has focus-visible ring', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('focus-visible:ring-2');
  });
});

describe('source structure: HostConnectionIndicator', () => {
  test('shows transport icon', () => {
    const src = readSource('HostConnectionIndicator.tsx');
    expect(src).toContain('transportIconName');
  });

  test('shows connection state', () => {
    const src = readSource('HostConnectionIndicator.tsx');
    expect(src).toContain('connectionStateLabel');
  });

  test('has aria-label', () => {
    const src = readSource('HostConnectionIndicator.tsx');
    expect(src).toContain('aria-label');
  });

  test('spins on connecting', () => {
    const src = readSource('HostConnectionIndicator.tsx');
    expect(src).toContain('animate-spin');
  });
});

describe('source structure: HostStatusBadge', () => {
  test('renders waiting-permission with shield icon', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('shield');
    expect(src).toContain('Waiting permission');
  });

  test('renders waiting-question with chat icon', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('chat-1');
    expect(src).toContain('Waiting question');
  });

  test('renders busy with spinning loader', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('loader-4');
    expect(src).toContain('animate-spin');
  });

  test('renders unread as dot', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('rounded-full bg-[var(--status-info)]');
  });

  test('renders error with warning icon', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('error-warning');
    expect(src).toContain('Error');
  });

  test('returns null for idle', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain("case 'idle':");
    expect(src).toContain('return null');
  });

  test('has aria-label for accessibility', () => {
    const src = readSource('HostStatusBadge.tsx');
    expect(src).toContain('aria-label');
  });
});

describe('source structure: MultiHostEmptyState', () => {
  test('shows no-hosts message', () => {
    const src = readSource('MultiHostEmptyState.tsx');
    expect(src).toContain('No hosts connected');
  });

  test('does not have interactive elements', () => {
    const src = readSource('MultiHostEmptyState.tsx');
    expect(src).not.toContain('<button');
    expect(src).not.toContain('onClick');
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation structure
// ---------------------------------------------------------------------------

describe('keyboard navigation', () => {
  test('session rows are focusable buttons', () => {
    const src = readSource('HostSessionNode.tsx');
    expect(src).toContain('<button');
    // Buttons are natively focusable, no explicit tabIndex needed
  });

  test('host/project headers handle keyboard events', () => {
    const hostSrc = readSource('HostNode.tsx');
    const projectSrc = readSource('HostProjectNode.tsx');
    expect(hostSrc).toContain('onKeyDown');
    expect(projectSrc).toContain('onKeyDown');
  });
});

// ---------------------------------------------------------------------------
// No sensitive data in components
// ---------------------------------------------------------------------------

describe('no sensitive data', () => {
  test('components do not render tokens or credentials', () => {
    const files = [
      'MultiHostSessionTree.tsx',
      'HostNode.tsx',
      'HostProjectNode.tsx',
      'HostSessionNode.tsx',
      'HostConnectionIndicator.tsx',
      'HostStatusBadge.tsx',
    ];
    for (const file of files) {
      const src = readSource(file);
      expect(src).not.toContain('token');
      expect(src).not.toContain('authorization');
      expect(src).not.toContain('password');
      expect(src).not.toContain('secret');
      expect(src).not.toContain('grant');
    }
  });
});

// ---------------------------------------------------------------------------
// Performance: no full state subscription at root
// ---------------------------------------------------------------------------

describe('performance: subscription discipline', () => {
  test('MultiHostSessionTree only subscribes to host IDs', () => {
    const src = readSource('MultiHostSessionTree.tsx');
    // Should use Object.keys to get just IDs, not full state
    expect(src).toContain('Object.keys(s.hosts)');
    // Should NOT subscribe to the full hosts record directly
    expect(src).not.toContain('useMultiHostStore((s) => s.hosts)');
  });

  test('HostNode subscribes to single host', () => {
    const src = readSource('HostNode.tsx');
    expect(src).toContain('useHost(hostId)');
  });
});
