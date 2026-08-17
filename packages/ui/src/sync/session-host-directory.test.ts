import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  getSessionHostDirectory,
  hydrateSessionHostDirectories,
  isPhantomWorkspaceSession,
  rememberSessionHostDirectory,
  resolveSessionHostDirectory,
} from './session-host-directory';

const sessionLike = (fields: Record<string, unknown>) => fields as unknown as Session;

describe('session host directory routes', () => {
  test('a routed session with no route anywhere is a phantom', () => {
    const session = sessionLike({ id: 'ses_phantom_1', directory: '/workspace', project: { id: 'global', worktree: '/' } });
    expect(resolveSessionHostDirectory(session)).toBeNull();
    expect(isPhantomWorkspaceSession(session)).toBe(true);
  });

  test('a recorded route makes the same session an ordinary member of its project', () => {
    const session = sessionLike({ id: 'ses_routed_1', directory: '/workspace', project: { id: 'global', worktree: '/' } });
    rememberSessionHostDirectory('ses_routed_1', 'C:/projects/app');
    expect(getSessionHostDirectory('ses_routed_1')).toBe('C:/projects/app');
    expect(resolveSessionHostDirectory(session)).toBe('C:/projects/app');
    expect(isPhantomWorkspaceSession(session)).toBe(false);
  });

  test('server hydration reports whether anything new was learned', () => {
    expect(hydrateSessionHostDirectories([{ sessionID: 'ses_hydrated_1', projectDirectory: 'C:/projects/app' }])).toBe(true);
    expect(hydrateSessionHostDirectories([{ sessionID: 'ses_hydrated_1', projectDirectory: 'C:/projects/app' }])).toBe(false);
  });

  test('a host session is never a phantom, whatever the map says', () => {
    const session = sessionLike({ id: 'ses_host_1', directory: 'C:/projects/app' });
    expect(isPhantomWorkspaceSession(session)).toBe(false);
  });
});
