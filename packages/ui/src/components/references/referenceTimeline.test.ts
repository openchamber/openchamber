import { describe, expect, test } from 'bun:test';

import { buildReferenceTimeline, type ReferenceCommentItem } from './referenceTimeline';

const comment = (key: string, createdAt: string | null): ReferenceCommentItem => ({
  kind: 'comment', key, author: 'sam', avatarUrl: null, body: key, createdAt, context: null, location: null,
});
const commit = (sha: string, committedAt: string | null) => ({ sha, headline: sha, author: null, avatarUrl: null, committedAt, url: null });

describe('reference timeline', () => {
  test('puts commits between the comments they came between, grouping the ones in a row', () => {
    const entries = buildReferenceTimeline(
      [comment('review', '2026-10-01T12:00:00Z'), comment('reply', '2026-10-02T12:00:00Z')],
      [commit('a', '2026-10-01T09:00:00Z'), commit('b', '2026-10-01T10:00:00Z'), commit('c', '2026-10-01T15:00:00Z')],
    );
    expect(entries.map((entry) => (entry.kind === 'comment' ? entry.key : entry.commits.map((item) => item.sha).join('+')))).toEqual(['a+b', 'review', 'c', 'reply']);
  });

  test('keeps a comment before a commit made at the same moment, and undated items first', () => {
    const entries = buildReferenceTimeline([comment('note', '2026-10-01T09:00:00Z'), comment('undated', null)], [commit('a', '2026-10-01T09:00:00Z')]);
    expect(entries.map((entry) => entry.key)).toEqual(['undated', 'note', 'commit:a']);
  });
});
