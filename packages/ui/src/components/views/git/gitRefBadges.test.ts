import { describe, expect, test } from 'bun:test';
import { buildGitRefBadgePresentation, getGitRefBadgeIcon } from './gitRefBadges';
import type { GitHistoryGraphRef } from './gitGraph';

const ref = (id: string, name: string, kind: GitHistoryGraphRef['kind'], color?: string): GitHistoryGraphRef => ({
  id,
  name,
  kind,
  revision: 'commit',
  category: kind === 'remote' ? 'remote-branches' : kind === 'tag' ? 'tags' : 'branches',
  color,
});

describe('getGitRefBadgeIcon', () => {
  test('returns correct icon for each ref kind', () => {
    expect(getGitRefBadgeIcon(ref('id', 'name', 'head'))).toBe('target');
    expect(getGitRefBadgeIcon(ref('id', 'name', 'local'))).toBe('git-branch');
    expect(getGitRefBadgeIcon(ref('id', 'name', 'remote'))).toBe('cloud');
    expect(getGitRefBadgeIcon(ref('id', 'name', 'tag'))).toBe('git-commit');
  });
});

describe('buildGitRefBadgePresentation', () => {
  test('returns empty presentation for empty refs', () => {
    expect(buildGitRefBadgePresentation([])).toEqual({
      primary: null,
      secondary: [],
    });
  });

  test('keeps ranked current and upstream references in order while compacting the upstream name', () => {
    const references = [
      ref('refs/heads/beta', 'beta', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/beta', 'origin/beta', 'remote', 'var(--git-graph-2)'),
      ref('refs/heads/follow-up', 'follow-up', 'local', 'var(--git-graph-3)'),
    ];

    expect(buildGitRefBadgePresentation(references)).toEqual({
      primary: { ref: references[0], icon: 'target' },
      secondary: [
        { refs: [references[1]], icon: 'cloud' },
        { refs: [references[2]], icon: 'git-branch' },
      ],
    });
    expect(references.map((item) => item.id)).toEqual([
      'refs/heads/beta',
      'refs/remotes/origin/beta',
      'refs/heads/follow-up',
    ]);
  });

  test('keeps a sole local, remote, or tag named', () => {
    for (const item of [
      ref('refs/heads/follow-up', 'follow-up', 'local'),
      ref('refs/remotes/origin/main', 'origin/main', 'remote'),
      ref('refs/tags/v1', 'v1', 'tag'),
    ]) {
      expect(buildGitRefBadgePresentation([item])).toEqual({
        primary: { ref: item, icon: getGitRefBadgeIcon(item) },
        secondary: [],
      });
    }
  });

  test('prioritizes non-tag refs, showing first tag as primary only when all refs are tags', () => {
    const tagOnly = [ref('refs/tags/v1', 'v1', 'tag')];
    expect(buildGitRefBadgePresentation(tagOnly)).toEqual({
      primary: { ref: tagOnly[0], icon: 'git-commit' },
      secondary: [],
    });
  });

  test('handles detached HEAD (kind=head without matching branch)', () => {
    const references = [
      ref('HEAD', 'HEAD', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/main', 'origin/main', 'remote', 'var(--git-graph-2)'),
    ];

    expect(buildGitRefBadgePresentation(references)).toEqual({
      primary: { ref: references[0], icon: 'target' },
      secondary: [{ refs: [references[1]], icon: 'cloud' }],
    });
  });

  test('preserves upstream before unrelated local refs in ranked order', () => {
    const references = [
      ref('refs/heads/beta', 'beta', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/beta', 'origin/beta', 'remote', 'var(--git-graph-2)'),
      ref('refs/heads/feature', 'feature', 'local', 'var(--git-graph-3)'),
      ref('refs/heads/other', 'other', 'local', 'var(--git-graph-4)'),
    ];

    expect(buildGitRefBadgePresentation(references)).toEqual({
      primary: { ref: references[0], icon: 'target' },
      secondary: [
        { refs: [references[1]], icon: 'cloud' },
        { refs: [references[2]], icon: 'git-branch' },
        { refs: [references[3]], icon: 'git-branch' },
      ],
    });
  });

  test('groups equally colored secondary remote refs without changing their source order', () => {
    const references = [
      ref('refs/heads/beta', 'beta', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/beta', 'origin/beta', 'remote', 'var(--git-graph-2)'),
      ref('refs/remotes/upstream/beta', 'upstream/beta', 'remote', 'var(--git-graph-2)'),
    ];

    expect(buildGitRefBadgePresentation(references).secondary).toEqual([
      { refs: [references[1], references[2]], icon: 'cloud' },
    ]);
    expect(references.map((item) => item.id)).toEqual([
      'refs/heads/beta',
      'refs/remotes/origin/beta',
      'refs/remotes/upstream/beta',
    ]);
  });

  test('does not group refs with different colors', () => {
    const references = [
      ref('refs/heads/beta', 'beta', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/beta', 'origin/beta', 'remote', 'var(--git-graph-2)'),
      ref('refs/remotes/upstream/beta', 'upstream/beta', 'remote', 'var(--git-graph-3)'),
    ];

    expect(buildGitRefBadgePresentation(references).secondary).toEqual([
      { refs: [references[1]], icon: 'cloud' },
      { refs: [references[2]], icon: 'cloud' },
    ]);
  });

  test('does not mutate input refs array', () => {
    const references = [
      ref('refs/heads/beta', 'beta', 'head', 'var(--git-graph-1)'),
      ref('refs/remotes/origin/beta', 'origin/beta', 'remote', 'var(--git-graph-2)'),
      ref('refs/heads/feature', 'feature', 'local', 'var(--git-graph-3)'),
    ];
    const originalIds = references.map((r) => r.id);

    buildGitRefBadgePresentation(references);

    expect(references.map((r) => r.id)).toEqual(originalIds);
  });
});
