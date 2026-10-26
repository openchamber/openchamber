import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from './useInlineCommentDraftStore';

const comment = {
  source: 'file' as const,
  fileLabel: 'src/app.ts:12',
  startLine: 12,
  endLine: 12,
  code: 'const x = 1',
  language: 'typescript',
  text: 'fix this',
};
const target = { directory: '/repo', sessionKey: 'session-1' };

const store = () => useInlineCommentDraftStore.getState();

describe('caller-provided draft ids', () => {
  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });

  test('a caller that owns its own view of the draft chooses the id', () => {
    // The VS Code editor thread mints the id so it can track its draft without
    // waiting for a round trip.
    const id = store().addDraft(target, { ...comment, id: 'icd-editor-thread' });
    expect(id).toBe('icd-editor-thread');
    expect(store().getDrafts(target)[0].id).toBe('icd-editor-thread');
  });

  test('the chosen id is what removal and lookup accept', () => {
    store().addDraft(target, { ...comment, id: 'icd-editor-thread' });
    store().removeDraft(target, 'icd-editor-thread');
    expect(store().getDrafts(target)).toEqual([]);
  });

  test('omitting the id still generates one', () => {
    const id = store().addDraft(target, comment);
    expect(/^icd-\d+-\w+$/.test(id ?? '')).toBe(true);
  });

  test('a blank id is ignored rather than stored', () => {
    const id = store().addDraft(target, { ...comment, id: '   ' });
    expect(/^icd-\d+-\w+$/.test(id ?? '')).toBe(true);
  });

  test('a colliding id is refused, so edits cannot retarget another draft', () => {
    const first = store().addDraft(target, { ...comment, id: 'icd-duplicate' });
    const second = store().addDraft(target, { ...comment, id: 'icd-duplicate', text: 'different' });

    expect(first).toBe('icd-duplicate');
    expect(second).not.toBe('icd-duplicate');

    const drafts = store().getDrafts(target);
    expect(drafts).toHaveLength(2);
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(2);
  });

  test('the same id may be reused once its draft is gone', () => {
    store().addDraft(target, { ...comment, id: 'icd-reused' });
    store().removeDraft(target, 'icd-reused');
    expect(store().addDraft(target, { ...comment, id: 'icd-reused' })).toBe('icd-reused');
  });

  test('an id taken in another session does not collide', () => {
    const other = { directory: '/repo', sessionKey: 'session-2' };
    store().addDraft(target, { ...comment, id: 'icd-shared' });
    expect(store().addDraft(other, { ...comment, id: 'icd-shared' })).toBe('icd-shared');
  });
});
