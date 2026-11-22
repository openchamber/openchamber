import { beforeEach, describe, expect, test } from 'bun:test';

import { EMPTY_GUEST_MARK_INDEX, guestBranchMarkKey, type GuestMarkEntry } from './marks.ts';
import { useGuestMarksStore } from './marks-store.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  source: 'path',
  marks: true,
  capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
  ...overrides,
});

const entry = (guestId: string, target: GuestMarkEntry['target'], text = 'Checks passed'): GuestMarkEntry => ({
  guestId,
  target,
  mark: { icon: 'check', tone: 'success', text },
});

const store = () => useGuestMarksStore.getState();

beforeEach(() => {
  useGuestMarksStore.setState({ ...EMPTY_GUEST_MARK_INDEX, runtimeKey: '', entries: [], guests: [], places: [] });
  store().resetForRuntimeSwitch('server-a');
});

describe('useGuestMarksStore', () => {
  test('joins an answer with the catalog it already holds', () => {
    store().setGuests([guest('ci')]);
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    expect(store().bySession.get('ses_1')?.map((mark) => mark.text)).toEqual(['Checks passed']);
  });

  test('an answer that came before the catalog shows nothing and is not kept', () => {
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    expect(store().entries).toEqual([]);
    store().setGuests([guest('ci')]);
    expect(store().bySession.size).toBe(0);
  });

  test('ignores the answer of a server the app left', () => {
    store().setGuests([guest('ci')]);
    store().resetForRuntimeSwitch('server-b');
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    expect(store().entries).toEqual([]);
    expect(store().bySession.size).toBe(0);
  });

  test('a switch drops the marks and keeps the catalog and folders for the next join', () => {
    store().setGuests([guest('ci')]);
    store().setPlaces([{ path: '/work/app', projectId: 'app' }]);
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    store().resetForRuntimeSwitch('server-b');
    expect(store().bySession.size).toBe(0);
    expect(store().runtimeKey).toBe('server-b');
    expect(store().guests).toHaveLength(1);
    expect(store().places).toHaveLength(1);
  });

  test('an extension that is paused loses its marks at the catalog change, and they do not come back with it', () => {
    store().setGuests([guest('ci'), guest('review')]);
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' }), entry('review', { sessionId: 'ses_1' }, 'Reviewed')], 'server-a');
    const review = store().bySession.get('ses_1');

    store().setGuests([guest('ci', { enabled: false }), guest('review')]);
    expect(store().bySession.get('ses_1')?.map((mark) => mark.guestId)).toEqual(['review']);
    expect(store().entries.map((kept) => kept.guestId)).toEqual(['review']);
    expect(review?.map((mark) => mark.guestId)).toEqual(['ci', 'review']);

    // The service was stopped with the pause, so what it had set is gone on
    // the server too; only a new read may show a mark of this extension.
    store().setGuests([guest('ci'), guest('review')]);
    expect(store().bySession.get('ses_1')?.map((mark) => mark.guestId)).toEqual(['review']);
  });

  test('the same holds for an approval taken back and for a version that no longer asks for marks', () => {
    store().setGuests([guest('ci')]);
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    store().setGuests([guest('ci', { capabilities: { requested: ['service', 'marks'], granted: [] } })]);
    expect(store().bySession.size).toBe(0);

    store().setGuests([guest('ci')]);
    store().replaceEntries([entry('ci', { sessionId: 'ses_1' })], 'server-a');
    store().setGuests([guest('ci', { marks: undefined, capabilities: { requested: ['service'], granted: ['service'] } })]);
    expect(store().bySession.size).toBe(0);
    expect(store().entries).toEqual([]);
  });

  test('a branch mark shows once its folder is known', () => {
    store().setGuests([guest('ci')]);
    store().replaceEntries([entry('ci', { directory: '/work/app', branch: 'main' })], 'server-a');
    expect(store().byBranch.size).toBe(0);
    store().setPlaces([{ path: '/work/app', projectId: 'app' }]);
    expect(store().byBranch.get(guestBranchMarkKey('app', 'main'))).toHaveLength(1);
  });

  test('an update that changes nothing keeps every list a row reads', () => {
    store().setGuests([guest('ci')]);
    store().setPlaces([{ path: '/work/app', projectId: 'app' }]);
    const entries = [entry('ci', { sessionId: 'ses_1' }), entry('ci', { directory: '/work/app' }), entry('ci', { directory: '/work/app', branch: 'main' })];
    store().replaceEntries(entries, 'server-a');
    const before = store();

    store().replaceEntries(structuredClone(entries), 'server-a');
    store().setGuests([guest('ci')]);
    store().setPlaces([{ path: '/work/app', projectId: 'app' }, { path: '/work/other', projectId: 'other' }]);

    expect(store().bySession).toBe(before.bySession);
    expect(store().byFolder).toBe(before.byFolder);
    expect(store().byBranch).toBe(before.byBranch);
  });
});
