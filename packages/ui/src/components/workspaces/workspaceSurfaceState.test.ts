import { describe, expect, test } from 'bun:test';
import {
  emptyWorkspaceScopeState,
  requiredCapabilityForWorkspaceOperation,
  requiredWorkspaceCapability,
  workspaceStatusSnapshot,
} from './workspaceSurfaceState';

describe('workspace surface state', () => {
  test('preserves authoritative statuses when refresh fails', () => {
    const current = { workspace1: 'connected' as const };
    expect(workspaceStatusSnapshot(current, null)).toBe(current);
  });

  test('clears workspace and export identity for a new runtime or project scope', () => {
    const reset = emptyWorkspaceScopeState();
    expect(reset).toEqual({
      workspaces: [],
      statuses: {},
      selectedWorkspaceID: '',
      exportID: '',
      artifactReview: null,
    });
  });

  test('wires privileged workflows to their distinct host grants', () => {
    expect(requiredCapabilityForWorkspaceOperation('workspace.create')).toBe('workspace.admin');
    expect(requiredCapabilityForWorkspaceOperation('workspace.export')).toBe('workspace.admin');
    expect(requiredCapabilityForWorkspaceOperation('host.apply')).toBe('host.apply');
    expect(requiredCapabilityForWorkspaceOperation('workspace.use')).toBeNull();
  });

  test('recognizes capability-aware server denials', () => {
    expect(requiredWorkspaceCapability(new Error('Client capability required: workspace.admin'))).toBe('workspace.admin');
    expect(requiredWorkspaceCapability(new Error('Client capability required: host.apply'))).toBe('host.apply');
  });
});
