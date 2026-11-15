import { describe, expect, test } from 'bun:test';

import { toOverlayShortcut } from './useAnnotationVoice';

describe('dictation shortcut inside an annotated page', () => {
  test('mod is Command on macOS and Control elsewhere', () => {
    expect(toOverlayShortcut('mod+alt+v', true)).toEqual({ key: 'v', meta: true, ctrl: false, alt: true, shift: false });
    expect(toOverlayShortcut('mod+alt+v', false)).toEqual({ key: 'v', meta: false, ctrl: true, alt: true, shift: false });
  });

  test('super is the Windows key off macOS', () => {
    expect(toOverlayShortcut('super+shift+d', false)).toEqual({ key: 'd', meta: true, ctrl: false, alt: false, shift: true });
  });

  test('an unassigned shortcut, a sequence or a named key leaves the overlay without one', () => {
    expect(toOverlayShortcut('', true)).toBeNull();
    expect(toOverlayShortcut('mod+k v', true)).toBeNull();
    expect(toOverlayShortcut('mod+space', true)).toBeNull();
  });
});
