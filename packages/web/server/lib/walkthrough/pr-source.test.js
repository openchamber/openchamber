import { describe, expect, it } from 'vitest';
import { parseSource, sourceKey, loadSourceSections } from './sources.js';

describe('repository-qualified PR sources', () => {
  it('keeps old cache keys and separates equal PR numbers in different repositories', () => {
    expect(sourceKey(parseSource({ kind: 'pr', number: 42 }))).toBe('pr:42');
    const upstream = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } });
    const fork = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'fork', repo: 'project' } });
    expect(sourceKey(upstream)).not.toBe(sourceKey(fork));
  });

  it('hands the selected repository to the walkthrough diff loader beside the read context', async () => {
    const source = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } });
    const readContext = { provider: 'github', accountId: 'github.com#7', primaryRemote: 'origin' };
    let received;
    await loadSourceSections('/repo', source, {
      readContext,
      getPullRequestDiff: async (...args) => {
        received = args;
        return { patch: 'published patch', meta: {} };
      },
    });
    // The read context carries the authority; the named repository rides along
    // only so the loader can check it against the bound one.
    expect(received).toEqual(['/repo', 42, readContext, { sourceRepo: source.sourceRepo }]);
  });
});

describe('GitLab namespace owners', () => {
  it('accepts a subgroup namespace owner so MR walkthrough selection works below the root group', () => {
    const source = parseSource({ kind: 'pr', number: 12, sourceRepo: { owner: 'group/subgroup', repo: 'repo' } });
    expect(source.sourceRepo).toEqual({ owner: 'group/subgroup', repo: 'repo' });
    expect(sourceKey(source)).toBe('pr:group/subgroup/repo:12');
  });

  it('accepts deeper nesting and dot/underscore segments as GitLab namespaces spell them', () => {
    for (const owner of ['group/sub/sub', 'group.name/sub_group']) {
      const source = parseSource({ kind: 'pr', number: 3, sourceRepo: { owner, repo: 'repo' } });
      expect(source.sourceRepo.owner).toBe(owner);
    }
  });

  it('keeps rejecting values that are not owner paths', () => {
    for (const owner of ['group/../repo', '/group/repo', 'group/repo/', 'group//repo', '.', 'group/./repo']) {
      expect(() => parseSource({ kind: 'pr', number: 3, sourceRepo: { owner, repo: 'repo' } }))
        .toThrow('pr sources require a valid repository');
    }
  });
});
