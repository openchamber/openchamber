import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { isPathWithinProject, isSessionRelatedToProject } from './utils';

describe('isPathWithinProject', () => {
  test('matches child directories for root projects', () => {
    expect(isPathWithinProject('/workspace/app', '/')).toBe(true);
  });

  test('matches exact project directories', () => {
    expect(isPathWithinProject('/workspace/app', '/workspace/app')).toBe(true);
  });

  test('does not match sibling directory prefixes', () => {
    expect(isPathWithinProject('/workspace/app2', '/workspace/app')).toBe(false);
  });

  test('returns false when directory is null', () => {
    expect(isPathWithinProject(null, '/workspace/app')).toBe(false);
  });

  test('returns false when projectPath is null', () => {
    expect(isPathWithinProject('/workspace/app', null)).toBe(false);
  });

  test('matches deep child directories', () => {
    expect(isPathWithinProject('/workspace/app/sub/dir', '/workspace/app')).toBe(true);
  });
});

describe('isSessionRelatedToProject', () => {
  test('prefers the most specific project root for archived session directories', () => {
    const session = {
      id: 'ses_parent_child',
      directory: '/home/user/proj/foo/src',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/home/user', '/home/user/proj/foo']);

    expect(
      isSessionRelatedToProject(session, '/home/user', new Set(['/home/user']), knownProjectDirectories),
    ).toBe(false);
    expect(
      isSessionRelatedToProject(
        session,
        '/home/user/proj/foo',
        new Set(['/home/user/proj/foo']),
        knownProjectDirectories,
      ),
    ).toBe(true);
  });

  test('prefers the most specific project worktree when session directory is missing', () => {
    const session = {
      id: 'ses_project_worktree',
      project: {
        worktree: '/home/user/proj/foo',
      },
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/home/user', '/home/user/proj/foo']);

    expect(
      isSessionRelatedToProject(session, '/home/user', new Set(['/home/user']), knownProjectDirectories),
    ).toBe(false);
    expect(
      isSessionRelatedToProject(
        session,
        '/home/user/proj/foo',
        new Set(['/home/user/proj/foo']),
        knownProjectDirectories,
      ),
    ).toBe(true);
  });

  test('prefers explicit session directory over broader project worktree metadata', () => {
    const session = {
      id: 'ses_directory_beats_worktree',
      directory: '/home/user/proj/foo/src',
      project: {
        worktree: '/home/user',
      },
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/home/user', '/home/user/proj/foo']);

    expect(
      isSessionRelatedToProject(session, '/home/user', new Set(['/home/user']), knownProjectDirectories),
    ).toBe(false);
    expect(
      isSessionRelatedToProject(
        session,
        '/home/user/proj/foo',
        new Set(['/home/user/proj/foo']),
        knownProjectDirectories,
      ),
    ).toBe(true);
  });

  test('keeps descendant sessions on the broad project when no child project matches', () => {
    const session = {
      id: 'ses_home_misc',
      directory: '/home/user/misc/sandbox',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/home/user', '/home/user/proj/foo']);

    expect(
      isSessionRelatedToProject(session, '/home/user', new Set(['/home/user']), knownProjectDirectories),
    ).toBe(true);
  });
});
