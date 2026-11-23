import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';

const dom = new Window();
Object.assign(globalThis, { window: dom, StorageEvent: dom.StorageEvent });

const { useInlineCommentDraftStore, getInlineCommentDraftKey } = await import('./useInlineCommentDraftStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { flushDeferredStorage } = await import('./utils/safeStorage');

const STORAGE_KEY = 'openchamber-inline-comment-drafts';
const comment = { source: 'diff' as const, fileLabel: 'a.ts', startLine: 1, endLine: 1, code: 'x', language: 'typescript' };
const here = { directory: '/repo', sessionKey: 'session-1' };
const elsewhere = { directory: '/repo', sessionKey: 'session-2' };

const store = () => useInlineCommentDraftStore.getState();
const texts = (target: typeof here) => store().getDrafts(target).map((draft) => draft.text);
const keyOf = (target: typeof here) => getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey)!;
const draftOf = (target: typeof here, text: string, id: string) => ({ ...comment, id, text, sessionKey: target.sessionKey, createdAt: 1 });

/** Another window of the app saving its whole map, the way the persist middleware writes it. */
const savedElsewhere = (drafts: Record<string, unknown[]>) => {
  const newValue = JSON.stringify({ state: { drafts }, version: 3 });
  window.localStorage.setItem(STORAGE_KEY, newValue);
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue }));
};
const savedSchema = z.object({ state: z.object({ drafts: z.record(z.string(), z.array(z.looseObject({ text: z.string() }))) }) });
const savedDrafts = () => {
  flushDeferredStorage();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? {} : savedSchema.parse(JSON.parse(raw)).state.drafts;
};
const persistedTexts = () => Object.values(savedDrafts()).flat().map((draft) => draft.text).sort();

afterEach(() => {
  useInlineCommentDraftStore.setState({ drafts: {} });
  flushDeferredStorage();
  window.localStorage.clear();
});

describe('inline comments in several windows', () => {
  test('a comment written in another window shows up here, and leaves when that window sends it', () => {
    savedElsewhere({ [keyOf(here)]: [draftOf(here, 'from the diff window', 'icd-1')] });
    expect(texts(here)).toEqual(['from the diff window']);

    savedElsewhere({});
    expect(texts(here)).toEqual([]);
  });

  test('a comment written here survives a save made in another window, and both stay saved', () => {
    store().addDraft(here, { ...comment, text: 'written here' });
    const own = savedDrafts();

    savedElsewhere({ ...own, [keyOf(elsewhere)]: [draftOf(elsewhere, 'written elsewhere', 'icd-2')] });
    store().addDraft(here, { ...comment, text: 'written here later' });

    expect(persistedTexts()).toEqual(['written elsewhere', 'written here', 'written here later']);
  });

  test('a session the other window did not touch keeps its drafts as they are on screen', () => {
    store().addDraft(here, { ...comment, text: 'written here' });
    flushDeferredStorage();
    const before = store().getDrafts(here);

    savedElsewhere({
      [keyOf(here)]: JSON.parse(JSON.stringify(before)),
      [keyOf(elsewhere)]: [draftOf(elsewhere, 'written elsewhere', 'icd-2')],
    });

    expect(store().getDrafts(here)).toBe(before);
    expect(texts(elsewhere)).toEqual(['written elsewhere']);
  });

  test('drafts taken from another window are not written back', () => {
    savedElsewhere({ [keyOf(elsewhere)]: [draftOf(elsewhere, 'written elsewhere', 'icd-2')] });
    const theirs = window.localStorage.getItem(STORAGE_KEY);

    flushDeferredStorage();

    expect(texts(elsewhere)).toEqual(['written elsewhere']);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(theirs);
  });

  test('an action here that changed nothing does not overwrite what another window just saved', () => {
    store().removeDraft(here, 'no-such-draft');

    savedElsewhere({ [keyOf(elsewhere)]: [draftOf(elsewhere, 'written elsewhere', 'icd-2')] });

    expect(texts(elsewhere)).toEqual(['written elsewhere']);
    expect(persistedTexts()).toEqual(['written elsewhere']);
  });

  test('other keys and unreadable values leave the drafts alone', () => {
    store().addDraft(here, { ...comment, text: 'written here' });
    flushDeferredStorage();
    const ours = window.localStorage.getItem(STORAGE_KEY)!;
    const unreadable = (newValue: string) => {
      window.localStorage.setItem(STORAGE_KEY, newValue);
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue }));
    };

    window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: '{}' }));
    unreadable('{not json');
    unreadable(JSON.stringify({ state: { drafts: [] }, version: 3 }));

    expect(texts(here)).toEqual(['written here']);
    window.localStorage.setItem(STORAGE_KEY, ours);
  });
});
