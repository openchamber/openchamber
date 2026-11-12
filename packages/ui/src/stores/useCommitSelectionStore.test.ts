import { afterEach, expect, test } from 'bun:test';
import { commitSelectionKey, useCommitSelectionStore } from './useCommitSelectionStore';

afterEach(() => useCommitSelectionStore.setState({ selections: new Map() }));

test('shares a commit choice within its runtime, repository and checked-out branch only', () => {
  const key = commitSelectionKey('/repo', 'feature', 'runtime-a');
  const commit = {
    hash: 'a'.repeat(40), message: 'Selected commit', date: '2026-09-09T09:22:00Z',
    author_name: 'Test Author', author_email: 'test@example.com', refs: '', body: '',
    filesChanged: 1, insertions: 1, deletions: 0, parents: [],
  };
  useCommitSelectionStore.getState().select(key, commit);
  expect(useCommitSelectionStore.getState().selections.get(key)).toEqual(commit);
  for (const otherKey of [
    commitSelectionKey('/other', 'feature', 'runtime-a'),
    commitSelectionKey('/repo', 'other', 'runtime-a'),
    commitSelectionKey('/repo', 'feature', 'runtime-b'),
  ]) expect(useCommitSelectionStore.getState().selections.get(otherKey)).toBeUndefined();
});
