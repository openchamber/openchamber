import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from './useInlineCommentDraftStore';

const selection = {
  sessionKey: 'session-1',
  source: 'terminal' as const,
  fileLabel: 'Terminal 1',
  startLine: 4,
  endLine: 5,
  code: 'first\nsecond',
  language: 'term-1',
  text: '',
};

describe('terminal context drafts', () => {
  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {} }); });

  test('persists snapshots by chat session and deduplicates identical selections', () => {
    useInlineCommentDraftStore.getState().addDraft(selection);
    useInlineCommentDraftStore.getState().addDraft(selection);
    const drafts = useInlineCommentDraftStore.getState().getDrafts('session-1');
    expect(drafts).toHaveLength(1);
    expect({ ...drafts[0], id: undefined, createdAt: undefined }).toEqual({ ...selection, id: undefined, createdAt: undefined });
  });

  test('supports individual removal and ordered consume', () => {
    useInlineCommentDraftStore.getState().addDraft(selection);
    useInlineCommentDraftStore.getState().addDraft({ ...selection, startLine: 8, endLine: 8, code: 'third' });
    const drafts = useInlineCommentDraftStore.getState().getDrafts('session-1');
    useInlineCommentDraftStore.getState().removeDraft('session-1', drafts[0].id);
    expect(useInlineCommentDraftStore.getState().consumeDrafts('session-1')).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts('session-1')).toEqual([]);
  });

  test('restores consumed drafts after a failed send without duplicating them', () => {
    useInlineCommentDraftStore.getState().addDraft(selection);
    const consumed = useInlineCommentDraftStore.getState().consumeDrafts('session-1');
    useInlineCommentDraftStore.getState().restoreDrafts('session-1', consumed);
    useInlineCommentDraftStore.getState().restoreDrafts('session-1', consumed);
    expect(useInlineCommentDraftStore.getState().getDrafts('session-1')).toEqual(consumed);
  });
});
