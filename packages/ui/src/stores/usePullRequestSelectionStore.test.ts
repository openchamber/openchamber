import { describe, expect, test } from 'bun:test';

import { usePullRequestSelectionStore } from './usePullRequestSelectionStore';

const source = { kind: 'pr' as const, number: 12, sourceRepo: { owner: 'acme', repo: 'project' } };

describe('pull request diff requests', () => {
  test('a repeated request is a new one, and a taken one is dropped', () => {
    const store = usePullRequestSelectionStore.getState();
    store.requestDiff('/repo', source);
    const first = usePullRequestSelectionStore.getState().diffRequests.get('/repo');
    store.requestDiff('/repo', source);
    const second = usePullRequestSelectionStore.getState().diffRequests.get('/repo');
    expect(second).toEqual(source);
    expect(second).not.toBe(first);

    // Settling an older request leaves the newer one in place.
    if (!first || !second) throw new Error('Expected both requests');
    store.settleDiffRequest('/repo', first);
    expect(usePullRequestSelectionStore.getState().diffRequests.get('/repo')).toBe(second);
    store.settleDiffRequest('/repo', second);
    expect(usePullRequestSelectionStore.getState().diffRequests.has('/repo')).toBe(false);
  });
});
