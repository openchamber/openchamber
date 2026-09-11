import { describe, expect, test } from 'bun:test';

import { resolveDraftPinnedKnowledge } from './draftKnowledge';

describe('resolveDraftPinnedKnowledge', () => {
  test('shows only notes and plans pinned on this draft', () => {
    expect(resolveDraftPinnedKnowledge(
      [{ id: 'note-a', body: 'Attached' }, { id: 'note-b', body: 'Not attached' }],
      [{ id: 'plan-a', title: 'Attached plan' }, { id: 'plan-b', title: 'Other plan' }],
      { notes: ['note-a'], plans: ['plan-a'] },
    )).toEqual({
      notes: [{ id: 'note-a', body: 'Attached' }],
      plans: [{ id: 'plan-a', title: 'Attached plan' }],
    });
  });

  test('drops stale ids without borrowing project-wide pins', () => {
    expect(resolveDraftPinnedKnowledge(
      [{ id: 'note-a', body: 'Project note' }],
      [{ id: 'plan-a', title: 'Project plan' }],
      { notes: ['missing'], plans: [] },
    )).toEqual({ notes: [], plans: [] });
  });
});
