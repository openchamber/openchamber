import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import {
  EMPTY_GUEST_MARK_INDEX,
  NO_ROW_GUEST_MARKS,
  guestBranchMarkKey,
  joinGuestMarks,
  mayGuestShowMarks,
  mergeRowGuestMarks,
  parseGuestMarksJson,
  type GuestMarkEntry,
  type GuestMarkPlace,
  type RowGuestMark,
} from './marks.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id.toUpperCase(),
  icon: 'window',
  source: 'path',
  marks: true,
  capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
  ...overrides,
});

const entry = (guestId: string, target: GuestMarkEntry['target'], text = 'Checks passed', url?: string): GuestMarkEntry => ({
  guestId,
  target,
  mark: { icon: 'check', tone: 'success', text, ...(url === undefined ? {} : { url }) },
});

const places: GuestMarkPlace[] = [
  { path: '/work/app', projectId: 'app' },
  { path: '/work/app/packages/site', projectId: 'site' },
  { path: '/trees/app/feature', projectId: 'app' },
];

const join = (entries: GuestMarkEntry[], guests: InstalledGuest[], previous = EMPTY_GUEST_MARK_INDEX) => (
  joinGuestMarks(entries, guests, places, previous)
);

describe('parseGuestMarksJson', () => {
  const list = (marks: JsonValue[]): string => JSON.stringify({ marks });

  test('reads session, folder and branch targets', () => {
    const marks = [
      entry('ci', { sessionId: 'ses_1' }),
      entry('ci', { directory: '/work/app' }),
      entry('ci', { directory: '/work/app', branch: 'main' }, 'On main', 'https://ci.test/run/1'),
    ];
    expect(parseGuestMarksJson(list(marks))).toEqual(marks);
  });

  test('an answer that is not the list is a failed read, not an empty one', () => {
    expect(parseGuestMarksJson('<html>Fallback</html>')).toBeNull();
    expect(parseGuestMarksJson('[]')).toBeNull();
    expect(parseGuestMarksJson('{"marks":{}}')).toBeNull();
    expect(parseGuestMarksJson('{}')).toBeNull();
    expect(parseGuestMarksJson(list([]))).toEqual([]);
  });

  test('one entry this build cannot read leaves the rest', () => {
    const good = entry('ci', { sessionId: 'ses_1' });
    const hostile: JsonValue[] = [
      null,
      'mark',
      { guestId: '', target: good.target, mark: good.mark },
      { guestId: 'ci', target: {}, mark: good.mark },
      { guestId: 'ci', target: { sessionId: '' }, mark: good.mark },
      { guestId: 'ci', target: good.target, mark: { ...good.mark, icon: 'Not An Icon' } },
      { guestId: 'ci', target: good.target, mark: { ...good.mark, tone: 'loud' } },
      { guestId: 'ci', target: good.target, mark: { ...good.mark, text: '   ' } },
      { guestId: 'ci', target: good.target, mark: { icon: 'check', text: 'No tone' } },
      good,
    ];
    expect(parseGuestMarksJson(list(hostile))).toEqual([good]);
  });
});

describe('mayGuestShowMarks', () => {
  test('needs the manifest line, the grant, and an extension that is on and approved', () => {
    expect(mayGuestShowMarks(guest('ci'))).toBe(true);
    expect(mayGuestShowMarks(guest('ci', { marks: undefined }))).toBe(false);
    expect(mayGuestShowMarks(guest('ci', { enabled: false }))).toBe(false);
    expect(mayGuestShowMarks(guest('ci', { capabilities: { requested: ['service', 'marks'], granted: ['marks'] } }))).toBe(false);
    expect(mayGuestShowMarks(guest('ci', { capabilities: { requested: ['service', 'marks'], granted: ['service'] } }))).toBe(false);
    expect(mayGuestShowMarks(guest('ci', { capabilities: { requested: ['service', 'marks'], granted: [] } }))).toBe(false);
  });
});

describe('joinGuestMarks', () => {
  test('gives a mark the name, order and click of its extension', () => {
    const index = join(
      [entry('link', { sessionId: 'ses_1' }, 'Deployed', 'https://deploy.test/1'), entry('panel', { sessionId: 'ses_1' }, 'Reviewed', 'https://ignored.test/')],
      [guest('other', { marks: undefined }), guest('panel', { entry: 'panel/index.html' }), guest('link')],
    );
    expect(index.bySession.get('ses_1')).toEqual([
      { guestId: 'panel', guestName: 'PANEL', order: 1, icon: 'check', tone: 'success', text: 'Reviewed', panel: true, url: null },
      { guestId: 'link', guestName: 'LINK', order: 2, icon: 'check', tone: 'success', text: 'Deployed', panel: false, url: 'https://deploy.test/1' },
    ]);
  });

  test('a link that is not a plain https address opens nothing', () => {
    const index = join(
      [
        entry('link', { sessionId: 'plain' }, 'Plain', 'http://deploy.test/1'),
        entry('link', { sessionId: 'script' }, 'Script', 'javascript:alert(1)'),
        entry('link', { sessionId: 'credentials' }, 'Credentials', 'https://user:secret@deploy.test/'),
        entry('link', { sessionId: 'none' }, 'None'),
      ],
      [guest('link')],
    );
    for (const sessionId of ['plain', 'script', 'credentials', 'none']) {
      expect(index.bySession.get(sessionId)?.[0]?.url).toBeNull();
    }
  });

  test('leaves out marks of extensions that may not show any, and of ones the catalog does not list', () => {
    const index = join(
      [entry('paused', { sessionId: 'ses_1' }), entry('unapproved', { sessionId: 'ses_1' }), entry('gone', { sessionId: 'ses_1' })],
      [guest('paused', { enabled: false }), guest('unapproved', { capabilities: { requested: ['service', 'marks'], granted: [] } })],
    );
    expect(index).toBe(EMPTY_GUEST_MARK_INDEX);
  });

  test('a folder target is keyed by its normalized folder', () => {
    const index = join([entry('ci', { directory: '/work/app/' }), entry('ci', { directory: '/elsewhere/unknown' }, 'Unknown folder')], [guest('ci')]);
    expect([...index.byFolder.keys()]).toEqual(['/work/app', '/elsewhere/unknown']);
    expect(index.byBranch.size).toBe(0);
  });

  test('a branch target belongs to the project of the longest known folder that holds it', () => {
    const index = join(
      [
        entry('ci', { directory: '/work/app/src', branch: 'main' }, 'Inside the project'),
        entry('ci', { directory: '/work/app/packages/site/', branch: 'main' }, 'Nested project'),
        entry('ci', { directory: '/trees/app/feature', branch: 'feature' }, 'Through a worktree'),
        entry('ci', { directory: '/work/application', branch: 'main' }, 'Only shares a prefix'),
        entry('ci', { directory: '/elsewhere', branch: 'main' }, 'Unknown folder'),
      ],
      [guest('ci')],
    );
    expect(Object.fromEntries([...index.byBranch].map(([key, marks]) => [key, marks.map((mark) => mark.text)]))).toEqual({
      [guestBranchMarkKey('app', 'main')]: ['Inside the project'],
      [guestBranchMarkKey('site', 'main')]: ['Nested project'],
      [guestBranchMarkKey('app', 'feature')]: ['Through a worktree'],
    });
    expect(index.byFolder.size).toBe(0);
  });

  test('one mark per extension on a row key: the later in the list stays, in its first place', () => {
    const index = join(
      [entry('a', { sessionId: 'ses_1' }, 'First'), entry('b', { sessionId: 'ses_1' }, 'Other'), entry('a', { sessionId: 'ses_1' }, 'Second')],
      [guest('a'), guest('b')],
    );
    expect(index.bySession.get('ses_1')?.map((mark) => mark.text)).toEqual(['Second', 'Other']);
  });

  test('the same answer keeps the whole index', () => {
    const entries = [entry('ci', { sessionId: 'ses_1' }), entry('ci', { directory: '/work/app' }), entry('ci', { directory: '/work/app', branch: 'main' })];
    const first = join(entries, [guest('ci')]);
    expect(join(structuredClone(entries), [guest('ci')], first)).toBe(first);
  });

  test('a change to one row keeps the list of every other row', () => {
    const before = join([entry('ci', { sessionId: 'ses_1' }), entry('ci', { sessionId: 'ses_2' }), entry('ci', { directory: '/work/app' })], [guest('ci')]);
    const after = join(
      [entry('ci', { sessionId: 'ses_1' }), entry('ci', { sessionId: 'ses_2' }, 'Checks failed'), entry('ci', { directory: '/work/app' })],
      [guest('ci')],
      before,
    );
    expect(after).not.toBe(before);
    expect(after.bySession.get('ses_1')).toBe(before.bySession.get('ses_1'));
    expect(after.bySession.get('ses_2')).not.toBe(before.bySession.get('ses_2'));
    expect(after.byFolder).toBe(before.byFolder);
    expect(after.byBranch).toBe(before.byBranch);
  });

  test('a removed mark removes its row key', () => {
    const before = join([entry('ci', { sessionId: 'ses_1' }), entry('ci', { sessionId: 'ses_2' })], [guest('ci')]);
    const after = join([entry('ci', { sessionId: 'ses_1' })], [guest('ci')], before);
    expect([...after.bySession.keys()]).toEqual(['ses_1']);
    expect(after.bySession.get('ses_1')).toBe(before.bySession.get('ses_1'));
  });

  test('a renamed or reordered extension changes its marks', () => {
    const entries = [entry('ci', { sessionId: 'ses_1' })];
    const before = join(entries, [guest('ci')]);
    expect(join(entries, [guest('ci', { name: 'Checks' })], before).bySession.get('ses_1')?.[0]?.guestName).toBe('Checks');
    expect(join(entries, [guest('first', { marks: undefined }), guest('ci')], before).bySession.get('ses_1')?.[0]?.order).toBe(1);
  });
});

describe('mergeRowGuestMarks', () => {
  const mark = (guestId: string, order: number, text: string): RowGuestMark => (
    { guestId, guestName: guestId, order, icon: 'check', tone: 'success', text, panel: false, url: null }
  );

  test('a row no list names reads the one shared empty list', () => {
    expect(mergeRowGuestMarks([])).toBe(NO_ROW_GUEST_MARKS);
    expect(mergeRowGuestMarks([[], NO_ROW_GUEST_MARKS, []])).toBe(NO_ROW_GUEST_MARKS);
  });

  test('a single list is returned as it is', () => {
    const branch = [mark('ci', 0, 'On the branch')];
    expect(mergeRowGuestMarks([[], branch, []])).toBe(branch);
  });

  test('the more specific list wins for an extension, and the result is in catalog order', () => {
    const session = [mark('review', 2, 'Session')];
    const branch = [mark('ci', 0, 'Branch'), mark('review', 2, 'Branch')];
    const folder = [mark('deploy', 1, 'Folder'), mark('ci', 0, 'Folder')];
    expect(mergeRowGuestMarks([session, branch, folder]).map((entry) => `${entry.guestId}: ${entry.text}`)).toEqual([
      'ci: Branch',
      'deploy: Folder',
      'review: Session',
    ]);
  });
});
