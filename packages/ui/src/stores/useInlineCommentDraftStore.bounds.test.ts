import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from './useInlineCommentDraftStore';

const comment = {
  source: 'file' as const,
  fileLabel: 'src/app.ts:12',
  startLine: 12,
  endLine: 12,
  code: 'const x = 1',
  language: 'typescript',
};
const target = { directory: '/repo', sessionKey: 'session-1' };

const store = () => useInlineCommentDraftStore.getState();
const texts = () => store().getDrafts(target).map((draft) => draft.text);
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `comment ${index + 1}`);

describe('how many comments a session holds', () => {
  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {} }); });

  test('writing many comments before sending keeps the first one', () => {
    for (const text of numbered(50)) store().addDraft(target, { ...comment, text });

    expect(texts()).toEqual(numbered(50));
  });

  test('a failed send restores every comment it took', () => {
    for (const text of numbered(50)) store().addDraft(target, { ...comment, text });

    store().restoreDrafts(target, store().consumeDrafts(target));

    expect(texts()).toEqual(numbered(50));
  });
});

describe('at the shared limits', () => {
  const session = (index: number) => ({ directory: '/repo', sessionKey: `session-${index}` });
  const textsOf = (at: typeof target) => store().getDrafts(at).map((draft) => draft.text);
  const fillSessions = () => {
    for (let index = 0; index < 50; index += 1) store().addDraft(session(index), { ...comment, text: `kept ${index}` });
  };
  const allSessionsKept = () => Array.from({ length: 50 }, (_, index) => textsOf(session(index)));
  const everySession = Array.from({ length: 50 }, (_, index) => [`kept ${index}`]);
  // Two sessions of 500 kB each leave too little room for another 100 kB.
  const quote = 'x'.repeat(500 * 1024);
  const fillBytes = () => {
    store().addDraft(session(1), { ...comment, code: quote, text: 'first' });
    store().addDraft(session(2), { ...comment, code: quote, text: 'second' });
  };
  const large = { ...comment, code: 'y'.repeat(100 * 1024), text: 'large' };

  afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {} }); });

  test('a 51st session is refused and all 50 stay', () => {
    fillSessions();

    expect(store().addDraft(session(50), { ...comment, text: 'new' })).toBeNull();

    expect(textsOf(session(50))).toEqual([]);
    expect(allSessionsKept()).toEqual(everySession);
  });

  test('a session already held still takes comments at 50 sessions', () => {
    fillSessions();

    expect(store().addDraft(session(0), { ...comment, text: 'more' })).not.toBeNull();

    expect(textsOf(session(0))).toEqual(['kept 0', 'more']);
  });

  test('a comment past 1 MiB is refused and the others stay', () => {
    fillBytes();

    expect(store().addDraft(session(3), large)).toBeNull();
    expect(store().addDraft(session(1), large)).toBeNull();

    expect(textsOf(session(1))).toEqual(['first']);
    expect(textsOf(session(2))).toEqual(['second']);
    expect(textsOf(session(3))).toEqual([]);
  });

  test('deleting a comment makes room again', () => {
    fillBytes();
    store().clearDrafts(session(2));

    expect(store().addDraft(session(3), large)).not.toBeNull();
  });

  test('an edit that would pass 1 MiB is refused and leaves the comment as it was', () => {
    fillBytes();
    const id = store().getDrafts(session(1))[0].id;

    expect(store().updateDraft(session(1), id, { text: large.code })).toBe(false);

    expect(textsOf(session(1))).toEqual(['first']);
    expect(textsOf(session(2))).toEqual(['second']);
  });

  test('a failed send restores past both limits while the space was taken', () => {
    fillSessions();
    const taken = store().consumeDrafts(session(0));
    store().addDraft(session(50), { ...comment, text: 'written meanwhile' });

    store().restoreDrafts(session(0), taken);

    expect(allSessionsKept()).toEqual(everySession);
    expect(textsOf(session(50))).toEqual(['written meanwhile']);

    useInlineCommentDraftStore.setState({ drafts: {} });
    fillBytes();
    const sent = store().consumeDrafts(session(1));
    store().addDraft(session(3), { ...comment, code: quote, text: 'third' });

    store().restoreDrafts(session(1), sent);

    expect(textsOf(session(1))).toEqual(['first']);
    expect(textsOf(session(2))).toEqual(['second']);
    expect(textsOf(session(3))).toEqual(['third']);
  });

  test('context put back from a message passes the limits, and shrinking works past them', () => {
    fillBytes();

    const id = store().addDraft(session(3), { ...comment, code: quote, text: 'reverted' }, { written: true });

    expect(id).not.toBeNull();
    expect(textsOf(session(3))).toEqual(['reverted']);
    expect(store().updateDraft(session(3), id!, { code: 'short' })).toBe(true);
  });

  test('a terminal selection already attached answers with its draft, not a refusal', () => {
    const selection = { ...comment, source: 'terminal' as const, text: '' };
    const first = store().addDraft(target, selection);

    expect(store().addDraft(target, selection)).toBe(first);
    expect(store().getDrafts(target)).toHaveLength(1);
  });
});
