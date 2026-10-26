import { describe, expect, test } from 'bun:test';

import {
  describeSessionDirectorySources,
  resolveSessionDirectoryFromSources,
} from './session-directory-resolution';

const WORKTREE = '/repo/.worktrees/feature';
const MAIN = '/repo';

describe('resolveSessionDirectoryFromSources', () => {
  test('authoritative directory beats a selection-time fallback', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: WORKTREE,
      selected: MAIN,
    });

    expect(resolution.directory).toBe(WORKTREE);
    expect(resolution.source).toBe('authoritative');
    expect(resolution.conflict).toEqual({ source: 'selected', directory: MAIN });
  });

  test('authoritative directory beats a directory persisted across restarts', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: WORKTREE,
      remembered: MAIN,
    });

    expect(resolution.directory).toBe(WORKTREE);
    expect(resolution.conflict).toEqual({ source: 'remembered', directory: MAIN });
  });

  test('the indexed directory outranks a locally requested worktree path', () => {
    // attachment/worktreeMetadata hold the path this client asked for, before
    // the server canonicalized it. Letting them win would route prompts to a
    // directory that no child store owns.
    const resolution = resolveSessionDirectoryFromSources({
      attachment: '/requested/worktree',
      worktreeMetadata: '/requested/worktree',
      authoritative: WORKTREE,
    });

    expect(resolution.directory).toBe(WORKTREE);
    expect(resolution.source).toBe('authoritative');
    expect(resolution.conflict).toEqual({ source: 'attachment', directory: '/requested/worktree' });
  });

  test('a worktree attachment is used while the session is not indexed yet', () => {
    // A guessed selection is not passed as `selected` at all, so the worktree
    // assignment is the best available value during the bootstrap race.
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: null,
      selected: null,
      attachment: WORKTREE,
      remembered: MAIN,
    });

    expect(resolution.directory).toBe(WORKTREE);
    expect(resolution.source).toBe('attachment');
    expect(resolution.conflict).toEqual({ source: 'remembered', directory: MAIN });
  });

  test('a server-confirmed selection outranks the requested worktree path', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: null,
      selected: '/canonical/worktree',
      attachment: '/requested/worktree',
      worktreeMetadata: '/requested/worktree',
    });

    expect(resolution.directory).toBe('/canonical/worktree');
    expect(resolution.source).toBe('selected');
  });

  test('falls back to the selection hint while the session is not indexed yet', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: null,
      selected: WORKTREE,
    });

    expect(resolution.directory).toBe(WORKTREE);
    expect(resolution.source).toBe('selected');
    expect(resolution.conflict).toBeNull();
  });

  test('agreeing sources report no conflict', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: WORKTREE,
      selected: WORKTREE,
      remembered: WORKTREE,
    });

    expect(resolution.conflict).toBeNull();
  });

  test('reports the first disagreeing source, not the last', () => {
    const resolution = resolveSessionDirectoryFromSources({
      authoritative: WORKTREE,
      selected: MAIN,
      remembered: '/somewhere/else',
    });

    expect(resolution.conflict).toEqual({ source: 'selected', directory: MAIN });
  });

  test('treats missing and blank values as unknown, never as a directory', () => {
    const resolution = resolveSessionDirectoryFromSources({
      attachment: null,
      worktreeMetadata: '   ',
      authoritative: undefined,
      selected: '',
    });

    expect(resolution.directory).toBeNull();
    expect(resolution.source).toBe('none');
    expect(resolution.conflict).toBeNull();
  });
});

describe('describeSessionDirectorySources', () => {
  test('lists populated sources in precedence order', () => {
    expect(describeSessionDirectorySources({
      remembered: MAIN,
      authoritative: WORKTREE,
      selected: '',
    })).toEqual([
      { source: 'authoritative', directory: WORKTREE },
      { source: 'remembered', directory: MAIN },
    ]);
  });
});
