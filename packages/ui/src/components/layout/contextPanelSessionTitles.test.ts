import { describe, expect, test } from 'bun:test';

import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP } from './contextPanelSessionTitles';

const state = (...session: Array<{ id: string; title?: string | null; updated?: number }>) => ({
  session: session.map(({ updated, ...rest }) => ({ ...rest, time: updated === undefined ? undefined : { updated } })),
});

describe('context panel session titles', () => {
  test('reads a chat tab title from whichever live directory holds the session', () => {
    const titles = buildSessionTitleMap(
      [state({ id: 'ses_a', title: 'Main chat' }), state({ id: 'ses_b', title: 'Other project' })],
      ['ses_a', 'ses_b'],
    );

    expect(titles.get('ses_a')).toBe('Main chat');
    expect(titles.get('ses_b')).toBe('Other project');
  });

  test('follows a rename and leaves a session without a title to its fallback', () => {
    const states = [state({ id: 'ses_a', title: 'Main chat' }), state({ id: 'ses_b', title: '  ' }, { id: 'ses_c', title: 'Not a tab' })];
    const before = buildSessionTitleMap(states, ['ses_a', 'ses_b']);
    const after = buildSessionTitleMap([states[0]!, state({ id: 'ses_b', title: 'Renamed' })], ['ses_a', 'ses_b']);

    expect(before.has('ses_b')).toBe(false);
    expect(before.has('ses_c')).toBe(false);
    expect(after.get('ses_b')).toBe('Renamed');
    expect(areTitleMapsEqual(before, after)).toBe(false);
    expect(areTitleMapsEqual(before, buildSessionTitleMap(states, ['ses_a', 'ses_b']))).toBe(true);
  });

  test('prefers the most recently updated copy when a session sits in two stores', () => {
    const titles = buildSessionTitleMap(
      [state({ id: 'ses_w', title: 'Stale copy', updated: 1 }), state({ id: 'ses_w', title: 'Fresh copy', updated: 2 })],
      ['ses_w'],
    );
    const reversed = buildSessionTitleMap(
      [state({ id: 'ses_w', title: 'Fresh copy', updated: 2 }), state({ id: 'ses_w', title: 'Stale copy', updated: 1 })],
      ['ses_w'],
    );

    expect(titles.get('ses_w')).toBe('Fresh copy');
    expect(reversed.get('ses_w')).toBe('Fresh copy');
  });

  test('returns the shared empty map when nothing is wanted or found', () => {
    expect(buildSessionTitleMap([state({ id: 'ses_a', title: 'Main chat' })], [])).toBe(EMPTY_SESSION_TITLE_MAP);
    expect(buildSessionTitleMap([state({ id: 'ses_a', title: 'Main chat' })], ['ses_missing'])).toBe(EMPTY_SESSION_TITLE_MAP);
  });
});
