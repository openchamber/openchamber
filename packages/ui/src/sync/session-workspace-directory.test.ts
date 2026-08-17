import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveSessionDirectoryKey } from './session-directory';

/** Only the fields the resolver reads; the rest of a Session is irrelevant here. */
const sessionLike = (fields: Record<string, unknown>) => fields as unknown as Session;

/**
 * A session running in a secure workspace reports the directory it works in, which is
 * inside the container. Host-side state must never take that as a path on this computer:
 * the file tree points at a directory that does not exist here, and the value is
 * persisted as `lastDirectory`, so it outlives the session that introduced it.
 */
describe('directory of a session routed into a workspace', () => {
  test('uses the project worktree rather than the path inside the container', () => {
    const session = sessionLike({
      id: 's1',
      workspaceID: 'wrk_1',
      directory: '/workspace',
      project: { worktree: 'C:/Users/me/project' },
    });

    expect(resolveSessionDirectoryKey(session)).toBe('C:/Users/me/project');
  });

  test('reports no directory rather than a container path when the host one is unknown', () => {
    const session = sessionLike({ id: 's1', workspaceID: 'wrk_1', directory: '/workspace', project: null });

    expect(resolveSessionDirectoryKey(session)).toBeNull();
  });

  test('recognises the container path even when nothing says the session is routed', () => {
    // Measured against the running app: OpenCode carries no `workspaceID` on session
    // records, and asking it for sessions scoped to a workspace returns the same list as
    // asking unscoped. So a routed session arrives looking ordinary, and only the path
    // tells the truth. Trusting the flag alone let `/workspace` through, and on Windows
    // it resolves against the current drive — the host OpenCode was seen bootstrapping an
    // instance for `C:\workspace` purely because such sessions sat in the list.
    expect(resolveSessionDirectoryKey(sessionLike({ id: 's1', directory: '/workspace' }))).toBeNull();
    expect(resolveSessionDirectoryKey(sessionLike({ id: 's1', directory: '/workspace/src' }))).toBeNull();
    expect(resolveSessionDirectoryKey(sessionLike({
      id: 's1',
      directory: '/workspace',
      project: { worktree: 'C:/Users/me/project' },
    }))).toBe('C:/Users/me/project');
  });

  test('does not mistake a host directory that merely begins the same way', () => {
    expect(resolveSessionDirectoryKey(sessionLike({ id: 's1', directory: '/workspaces/mine' }))).toBe('/workspaces/mine');
    expect(resolveSessionDirectoryKey(sessionLike({ id: 's1', directory: 'C:/workspace' }))).toBe('C:/workspace');
  });

  test('treats the global placeholder project and its "/" worktree as no directory at all', () => {
    // OpenCode's "global" project reports worktree "/" — a spelling of "nowhere".
    // Taking it at face value made a routed session resolve to the filesystem root,
    // which no project owns, so the sidebar filter dropped it before ownership could
    // seat it from the recorded route.
    expect(resolveSessionDirectoryKey(sessionLike({
      id: 's1',
      directory: '/workspace',
      project: { id: 'global', worktree: '/' },
    }))).toBeNull();
    expect(resolveSessionDirectoryKey(sessionLike({
      id: 's1',
      directory: '/workspace',
      project: { id: 'proj_1', worktree: '/' },
    }))).toBeNull();
  });

  test('keeps using the session directory for work that runs on this computer', () => {
    const session = sessionLike({ id: 's1', directory: 'C:/Users/me/project', project: { worktree: 'C:/Users/me/other' } });

    expect(resolveSessionDirectoryKey(session)).toBe('C:/Users/me/project');
  });
});
