import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from './useInlineCommentDraftStore';

const selection = {
  source: 'terminal' as const,
  fileLabel: 'Terminal 1',
  startLine: 4,
  endLine: 5,
  code: 'first\nsecond',
  language: 'term-1',
  text: '',
};
const target = { directory: '/repo', sessionKey: 'session-1' };

describe('terminal context drafts', () => {
  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });

  test('persists snapshots by chat session and deduplicates identical selections', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    const drafts = useInlineCommentDraftStore.getState().getDrafts(target);
    expect(drafts).toHaveLength(1);
    expect({ ...drafts[0], id: undefined, createdAt: undefined }).toEqual({ ...selection, sessionKey: 'session-1', id: undefined, createdAt: undefined });
  });

  test('supports individual removal and ordered consume', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(target, { ...selection, startLine: 8, endLine: 8, code: 'third' });
    const drafts = useInlineCommentDraftStore.getState().getDrafts(target);
    useInlineCommentDraftStore.getState().removeDraft(target, drafts[0].id);
    expect(useInlineCommentDraftStore.getState().consumeDrafts(target)).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
  });

  test('restores consumed drafts after a failed send without duplicating them', () => {
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    const consumed = useInlineCommentDraftStore.getState().consumeDrafts(target);
    useInlineCommentDraftStore.getState().restoreDrafts(target, consumed);
    useInlineCommentDraftStore.getState().restoreDrafts(target, consumed);
    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual(consumed);
  });

  test('isolates identical session IDs by normalized directory', () => {
    const otherTarget = { directory: '/other', sessionKey: 'session-1' };
    useInlineCommentDraftStore.getState().addDraft(target, selection);
    useInlineCommentDraftStore.getState().addDraft(otherTarget, { ...selection, code: 'other' });

    useInlineCommentDraftStore.getState().clearDrafts({ ...target, directory: '/repo/' });

    expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
    expect(useInlineCommentDraftStore.getState().getDrafts(otherTarget)).toHaveLength(1);
  });

  test('returns a stable empty snapshot for absent draft buckets', () => {
    const first = useInlineCommentDraftStore.getState().getDrafts(target);
    const second = useInlineCommentDraftStore.getState().getDrafts(target);

    expect(first).toBe(second);
  });
});
