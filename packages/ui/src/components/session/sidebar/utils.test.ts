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

  test('matches Windows normalized paths', () => {
    const session = {
      id: 'ses_windows',
      directory: 'C:/Users/dev/proj/src',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['C:/Users/dev', 'C:/Users/dev/proj']);

    expect(
      isSessionRelatedToProject(session, 'C:/Users/dev', new Set(['C:/Users/dev']), knownProjectDirectories),
    ).toBe(false);
    expect(
      isSessionRelatedToProject(
        session,
        'C:/Users/dev/proj',
        new Set(['C:/Users/dev/proj']),
        knownProjectDirectories,
      ),
    ).toBe(true);
  });

  test('matches root project when no more specific project exists', () => {
    const session = {
      id: 'ses_root_child',
      directory: '/foo/bar/baz',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/']);

    expect(
      isSessionRelatedToProject(session, '/', new Set(['/']), knownProjectDirectories),
    ).toBe(true);
  });

  test('more specific project wins over root project', () => {
    const session = {
      id: 'ses_specific_wins',
      directory: '/foo/bar/baz',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/', '/foo/bar']);

    expect(
      isSessionRelatedToProject(session, '/', new Set(['/']), knownProjectDirectories),
    ).toBe(false);
    expect(
      isSessionRelatedToProject(session, '/foo/bar', new Set(['/foo/bar']), knownProjectDirectories),
    ).toBe(true);
  });

  test('cache returns the same result on repeated calls', () => {
    const session = {
      id: 'ses_cache',
      directory: '/home/user/proj/foo/src',
    } as unknown as Session;

    const knownProjectDirectories = new Set(['/home/user', '/home/user/proj/foo']);
    const cache = new Map<string, string | null>();

    const first = isSessionRelatedToProject(
      session,
      '/home/user/proj/foo',
      new Set(['/home/user/proj/foo']),
      knownProjectDirectories,
      cache,
    );
    expect(cache.size).toBe(1);

    const second = isSessionRelatedToProject(
      session,
      '/home/user/proj/foo',
      new Set(['/home/user/proj/foo']),
      knownProjectDirectories,
      cache,
    );
    expect(second).toBe(first);
    expect(second).toBe(true);
    expect(cache.size).toBe(1);
  });

  test('results update when a fresh cache is used after knownProjectDirectories changes', () => {
    const session = {
      id: 'ses_invalidate',
      directory: '/home/user/proj/foo/src',
    } as unknown as Session;

    const narrowDirectories = new Set(['/home/user/proj/foo']);
    const broadDirectories = new Set(['/home/user']);
    const narrowCache = new Map<string, string | null>();
    const broadCache = new Map<string, string | null>();

    const narrowResult = isSessionRelatedToProject(
      session,
      '/home/user/proj/foo',
      new Set(['/home/user/proj/foo']),
      narrowDirectories,
      narrowCache,
    );
    expect(narrowResult).toBe(true);
    expect(narrowCache.get('/home/user/proj/foo/src')).toBe('/home/user/proj/foo');

    // SessionSidebar creates a fresh cache when knownProjectDirectories
    // changes, so the stale narrow lookup is no longer consulted.
    const broadResult = isSessionRelatedToProject(
      session,
      '/home/user',
      new Set(['/home/user']),
      broadDirectories,
      broadCache,
    );
    expect(broadResult).toBe(true);
    expect(broadCache.get('/home/user/proj/foo/src')).toBe('/home/user');
  });
});
