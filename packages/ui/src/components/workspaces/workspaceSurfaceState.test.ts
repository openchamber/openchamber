import { describe, expect, test } from 'bun:test';
import {
  emptyWorkspaceScopeState,
  requiredCapabilityForWorkspaceOperation,
  requiredWorkspaceCapability,
  workspaceProjectDirectory,
  workspaceSourceRefusal,
  workspaceStatusSnapshot,
} from './workspaceSurfaceState';

describe('workspace surface state', () => {
  test('uses the explicit draft target before the active host project for lifecycle scope', () => {
    const projects = [
      { id: 'host-project', path: '/host/project' },
      { id: 'other-project', path: '/other/project' },
    ];

    expect(workspaceProjectDirectory(projects, 'host-project', {
      open: true,
      selectedProjectId: 'other-project',
      directoryOverride: '/other/project/worktree',
    })).toBe('/other/project/worktree');
    expect(workspaceProjectDirectory(projects, 'host-project', {
      open: true,
      selectedProjectId: 'other-project',
    })).toBe('/other/project');
    expect(workspaceProjectDirectory(projects, 'host-project', {
      open: true,
      selectedProjectId: 'missing-project',
    })).toBe('');
    expect(workspaceProjectDirectory(projects, 'host-project')).toBe('/host/project');
    expect(workspaceProjectDirectory(projects, 'missing-project')).toBe('');
    expect(workspaceProjectDirectory(projects, null)).toBe('');
  });

  test('uses the selected host session before a stale active project', () => {
    const projects = [
      { id: 'stale-project', path: '/host/stale' },
      { id: 'session-project', path: '/host/session' },
    ];

    expect(workspaceProjectDirectory(projects, 'stale-project', undefined, '/host/session')).toBe('/host/session');
    expect(workspaceProjectDirectory(projects, 'stale-project', undefined, '/host/session/worktree')).toBe('/host/session/worktree');
    expect(workspaceProjectDirectory(projects, 'stale-project', undefined, '/workspace')).toBe('/host/stale');
    expect(workspaceProjectDirectory(projects, 'stale-project', {
      open: true,
      selectedProjectId: 'stale-project',
    }, '/host/session')).toBe('/host/stale');
  });

  test('preserves authoritative statuses when refresh fails', () => {
    const current = { workspace1: 'connected' as const };
    expect(workspaceStatusSnapshot(current, null)).toBe(current);
  });

  test('keeps the last known status for workspaces missing from a partial payload', () => {
    const current = { workspace1: 'connected' as const, workspace2: 'connecting' as const };
    expect(workspaceStatusSnapshot(current, [{ workspaceID: 'workspace2', status: 'connected' }])).toEqual({
      workspace1: 'connected',
      workspace2: 'connected',
    });
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

  test('names a home directory as unusable before anyone presses create', () => {
    const home = 'C:\\Users\\Sam';
    expect(workspaceSourceRefusal(home, home, 'win32')).toBe('home');
    expect(workspaceSourceRefusal('/home/yulia', '/home/yulia', 'linux')).toBe('home');
    // The picker and a typed path disagree about letter case, and Windows does not.
    expect(workspaceSourceRefusal('c:/users/sam/', home, 'win32')).toBe('home');
    // Linux does treat those as different directories, so neither may be assumed.
    expect(workspaceSourceRefusal('/home/Yulia', '/home/yulia', 'linux')).toBeNull();
  });

  test('names a filesystem root as unusable, whichever kind of root it is', () => {
    expect(workspaceSourceRefusal('C:\\', null, 'win32')).toBe('root');
    expect(workspaceSourceRefusal('/', null, 'linux')).toBe('root');
    expect(workspaceSourceRefusal('\\\\fileserver\\projects', null, 'win32')).toBe('root');
  });

  test('accepts an ordinary project, including one inside the home directory', () => {
    const home = 'C:\\Users\\Sam';
    expect(workspaceSourceRefusal('C:\\Users\\Sam\\projects\\openchamber', home, 'win32')).toBeNull();
    expect(workspaceSourceRefusal('/home/yulia/projects/openchamber', '/home/yulia', 'linux')).toBeNull();
    expect(workspaceSourceRefusal('', '/home/yulia', 'linux')).toBeNull();
  });

  test('recognizes capability-aware server denials', () => {
    expect(requiredWorkspaceCapability(new Error('Client capability required: workspace.admin'))).toBe('workspace.admin');
    expect(requiredWorkspaceCapability(new Error('Client capability required: host.apply'))).toBe('host.apply');
  });
});
