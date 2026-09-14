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
