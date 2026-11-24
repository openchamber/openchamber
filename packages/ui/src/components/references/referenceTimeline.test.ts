import { describe, expect, test } from 'bun:test';

import { buildReferenceTimeline, countReferenceTimeline, filterReferenceTimeline, type ReferenceCommentItem } from './referenceTimeline';

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
    expect(entries.map((entry) => (entry.kind === 'comment' || entry.kind === 'reference' ? entry.key : entry.commits.map((item) => item.sha).join('+')))).toEqual(['a+b', 'review', 'c', 'reply']);
  });

  test('puts a mention among the comments by its time, keeping its own key', () => {
    const entries = buildReferenceTimeline(
      [comment('review', '2026-10-01T12:00:00Z')],
      [],
      [{ kind: 'issue', number: 4, url: 'https://github.com/acme/app/issues/4', createdAt: '2026-10-01T09:00:00Z' }],
    );
    expect(entries.map((entry) => entry.kind === 'reference' ? entry.reference.number : entry.key)).toEqual([4, 'review']);
  });

  test('keeps a comment before a commit made at the same moment, and undated items first', () => {
    const entries = buildReferenceTimeline([comment('note', '2026-10-01T09:00:00Z'), comment('undated', null)], [commit('a', '2026-10-01T09:00:00Z')]);
    expect(entries.map((entry) => entry.key)).toEqual(['undated', 'note', 'commit:a']);
  });

  test('filters and counts activity across comments, unresolved threads, and resolved threads', () => {
    const general = comment('general', '2026-10-01T09:00:00Z');
    const unresolved: ReferenceCommentItem = {
      ...comment('open-thread', '2026-10-01T10:00:00Z'),
      thread: { id: 't1', resolved: false, canResolve: true, canReply: true, replies: [] },
    };
    const resolved: ReferenceCommentItem = {
      ...comment('closed-thread', '2026-10-01T11:00:00Z'),
      thread: { id: 't2', resolved: true, canResolve: true, canReply: true, replies: [] },
    };
    const entries = buildReferenceTimeline(
      [general, unresolved, resolved],
      [commit('abc', '2026-10-01T08:00:00Z')],
      [{ kind: 'issue', number: 9, url: 'https://github.com/acme/app/issues/9', createdAt: '2026-10-01T12:00:00Z' }],
    );

    expect(countReferenceTimeline(entries)).toEqual({ all: 5, comments: 3, unresolved: 1, resolved: 1 });
    expect(filterReferenceTimeline(entries, 'all').map((entry) => entry.key)).toEqual(['commit:abc', 'general', 'open-thread', 'closed-thread', 'reference:https://github.com/acme/app/issues/9#0']);
    expect(filterReferenceTimeline(entries, 'comments').map((entry) => entry.key)).toEqual(['general', 'open-thread', 'closed-thread']);
    expect(filterReferenceTimeline(entries, 'unresolved').map((entry) => entry.key)).toEqual(['open-thread']);
    expect(filterReferenceTimeline(entries, 'resolved').map((entry) => entry.key)).toEqual(['closed-thread']);
  });
});
