import { describe, expect, test } from 'bun:test';

import { findGuestFileEditor } from './file-editors';
import type { InstalledGuest } from './types';

const guest = (id: string, match: string[], overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'apps',
  capabilities: { requested: [], granted: [] },
  fileEditors: [{ id: 'editor', title: `${id} editor`, match, entry: 'editor/index.html' }],
  ...overrides,
});

describe('findGuestFileEditor', () => {
  test('matches the file name, not the directory, case-insensitively', () => {
    const guests = [guest('excalidraw', ['*.excalidraw', '*.excalidraw.md'])];
    expect(findGuestFileEditor(guests, '/repo/docs/Flow.EXCALIDRAW')?.guestId).toBe('excalidraw');
    expect(findGuestFileEditor(guests, 'C:\\repo\\flow.excalidraw.md')?.guestId).toBe('excalidraw');
    expect(findGuestFileEditor(guests, '/repo/flow.excalidraw/readme.md')).toBeNull();
  });

  test('skips paused and unapproved guests; the first active one in catalog order wins', () => {
    const paused = guest('paused', ['*.note'], { enabled: false });
    const unapproved = guest('unapproved', ['*.note'], { capabilities: { requested: ['files'], granted: [] } });
    const first = guest('first', ['*.note']);
    const second = guest('second', ['*.note']);
    expect(findGuestFileEditor([paused, unapproved, first, second], '/repo/a.note')?.guestId).toBe('first');
    expect(findGuestFileEditor([paused, unapproved], '/repo/a.note')).toBeNull();
  });

  test('guests without file editors and unmatched files leave the file to the host', () => {
    expect(findGuestFileEditor([guest('x', ['*.x'], { fileEditors: undefined })], '/repo/a.x')).toBeNull();
    expect(findGuestFileEditor([guest('x', ['*.x'])], '/repo/a.md')).toBeNull();
  });
});
