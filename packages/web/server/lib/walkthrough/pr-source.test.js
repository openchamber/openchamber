import { describe, expect, it } from 'vitest';
import { parseSource, sourceKey, loadSourceSections } from './sources.js';

describe('repository-qualified PR sources', () => {
  it('keeps old cache keys and separates equal PR numbers in different repositories', () => {
    expect(sourceKey(parseSource({ kind: 'pr', number: 42 }))).toBe('pr:42');
    const upstream = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } });
    const fork = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'fork', repo: 'project' } });
    expect(sourceKey(upstream)).not.toBe(sourceKey(fork));
  });

  it('hands the selected repository to the walkthrough diff loader', async () => {
    const source = parseSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } });
    let received;
    await loadSourceSections('/repo', source, { getPullRequestDiff: async (...args) => {
      received = args;
      return { patch: 'published patch', meta: {} };
    } });
    expect(received).toEqual(['/repo', 42, source.sourceRepo]);
  });
});
