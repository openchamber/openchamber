import { describe, expect, test } from 'bun:test';
import type { GitHubPullReference } from '@/lib/api/types';
import { findPullForStackBase, inferPullStackPositions } from './pullStackInference';

const pull = (number: number, head: string, base: string, overrides: Partial<GitHubPullReference> = {}): GitHubPullReference => ({
  kind: 'pull', provider: 'github', number, head, base, title: head, url: `https://github.com/acme/app/pull/${number}`,
  state: 'open', draft: false, headSha: 'a'.repeat(40), body: '', bodyTruncated: false,
  createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  headRepo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' }, ...overrides,
});

describe('page-local pull stack positions', () => {
  test('orders a loaded chain from bottom to top regardless of page order', () => {
    const items = [pull(3, 'third', 'second'), pull(1, 'first', 'main'), pull(2, 'second', 'first')];
    const positions = inferPullStackPositions(items);
    expect([...positions]).toEqual([
      ['acme/app#1', { index: 1, total: 3 }], ['acme/app#2', { index: 2, total: 3 }], ['acme/app#3', { index: 3, total: 3 }],
    ]);
  });
  test('does not join identical branch names across repositories or fork heads', () => {
    const items = [pull(1, 'first', 'main'), pull(2, 'second', 'first', {
      sourceRepo: { owner: 'other', repo: 'app', source: 'origin' },
    }), pull(3, 'fork', 'first', { headRepo: { owner: 'fork', repo: 'app', url: 'https://github.com/fork/app' } })];
    const positions = inferPullStackPositions(items);
    expect(positions.size).toBe(0);
  });
  test('omits closed, GitLab and missing-page parents', () => {
    const items = [pull(1, 'first', 'main', { state: 'closed' }), pull(2, 'second', 'first'),
      pull(3, 'third', 'second', { provider: 'gitlab' })];
    const positions = inferPullStackPositions(items);
    expect(positions.size).toBe(0);
  });
  test('does not invent positions for a tree or a cycle', () => {
    const items = [pull(1, 'first', 'main'), pull(2, 'second', 'first'), pull(3, 'third', 'first'),
      pull(4, 'cycle-a', 'cycle-b'), pull(5, 'cycle-b', 'cycle-a')];
    const positions = inferPullStackPositions(items);
    expect(positions.size).toBe(0);
  });
  test('handles a representative large loaded page without per-member lookups', () => {
    const items = Array.from({ length: 1000 }, (_, index) => pull(index + 1, `branch-${index}`, index === 0 ? 'main' : `branch-${index - 1}`));
    const positions = inferPullStackPositions(items);
    expect(positions.get('acme/app#1000')).toEqual({ index: 1000, total: 1000 });
    expect(positions.size).toBe(1000);
  });
  test('does not choose an ambiguous parent when several PRs have the same head', () => {
    const positions = inferPullStackPositions([pull(1, 'first', 'main'), pull(2, 'first', 'main'), pull(3, 'third', 'first'), pull(4, 'fourth', 'third')]);
    expect(positions.size).toBe(0);
  });
  test('finds the open PR behind a chosen base only in its actual repository', () => {
    const actual = pull(3, 'base', 'main');
    const found = findPullForStackBase([pull(1, 'base', 'main', { state: 'closed' }), pull(2, 'base', 'main', {
      headRepo: { owner: 'fork', repo: 'app', url: 'https://github.com/fork/app' },
    }), actual], 'base', { owner: 'ACME', repo: 'App' });
    expect(found).toBe(actual);
  });

  test('does not join GitHub Enterprise layers to github.com page hints', () => {
    // Given
    const lower = pull(1, 'lower', 'main');
    const enterprise = pull(2, 'upper', 'lower', {
      url: 'https://github.enterprise.example/acme/app/pull/2',
      headRepo: { owner: 'acme', repo: 'app', url: 'https://github.enterprise.example/acme/app' },
    });

    // When
    const positions = inferPullStackPositions([lower, enterprise]);

    // Then
    expect(positions.size).toBe(0);
  });

  test('does not resolve an Enterprise PR as a github.com stack base', () => {
    // Given
    const enterprise = pull(1, 'base', 'main', {
      url: 'https://github.enterprise.example/acme/app/pull/1',
      headRepo: { owner: 'acme', repo: 'app', url: 'https://github.enterprise.example/acme/app' },
    });

    // When
    const found = findPullForStackBase([enterprise], 'base', { owner: 'acme', repo: 'app' });

    // Then
    expect(found).toBeNull();
  });
});
