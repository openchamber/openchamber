import { describe, expect, test } from 'bun:test';

import {
  eventMatchesShortcutPrefix,
  formatShortcutForDisplay,
  getEffectiveShortcutPrefix,
  getShortcutConflict,
  isRiskyBrowserShortcut,
  isShortcutPrefixHeld,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
} from './index';

describe('getEffectiveShortcutPrefix', () => {
  test('falls back to the action default (bare mod) when unset', () => {
    expect(getEffectiveShortcutPrefix('switch_context_surface', {})).toBe('mod');
  });

  test('honors modifier + key overrides', () => {
    expect(getEffectiveShortcutPrefix('switch_context_surface', { switch_context_surface: 'mod+p' })).toBe('mod+p');
  });

  test('honors modifier-only overrides', () => {
    expect(getEffectiveShortcutPrefix('switch_context_surface', { switch_context_surface: 'shift' })).toBe('shift');
  });

  test('returns UNASSIGNED for an explicit unassignment', () => {
    expect(
      getEffectiveShortcutPrefix('switch_context_surface', { switch_context_surface: UNASSIGNED_SHORTCUT }),
    ).toBe(UNASSIGNED_SHORTCUT);
  });

  test('returns empty string for an unknown action', () => {
    expect(getEffectiveShortcutPrefix('does_not_exist', {})).toBe('');
  });
});

describe('isShortcutPrefixHeld', () => {
  test('false for an unassigned prefix', () => {
    expect(isShortcutPrefixHeld(UNASSIGNED_SHORTCUT, new Set(['control']))).toBe(false);
  });

  test('requires the prefix primary key to be held', () => {
    expect(isShortcutPrefixHeld('mod+p', new Set(['control']))).toBe(false);
    expect(isShortcutPrefixHeld('mod+p', new Set(['control', 'p']))).toBe(true);
  });

  test('requires every prefix modifier to be held', () => {
    expect(isShortcutPrefixHeld('mod+shift', new Set(['control']))).toBe(false);
    expect(isShortcutPrefixHeld('mod+shift', new Set(['control', 'shift']))).toBe(true);
  });
});

const keydown = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent =>
  ({
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  }) as KeyboardEvent;

describe('eventMatchesShortcutPrefix', () => {
  test('matches a bare mod prefix when the primary modifier is held', () => {
    expect(eventMatchesShortcutPrefix(keydown('1', { ctrl: true }), 'mod')).toBe(true);
  });

  test('rejects a bare mod prefix without the primary modifier', () => {
    expect(eventMatchesShortcutPrefix(keydown('1', {}), 'mod')).toBe(false);
  });

  test('rejects when the event carries modifiers the prefix does not expect', () => {
    expect(eventMatchesShortcutPrefix(keydown('1', { ctrl: true, shift: true }), 'mod')).toBe(false);
  });

  test('requires the prefix primary key to be held at match time', () => {
    expect(eventMatchesShortcutPrefix(keydown('1', { ctrl: true }), 'mod+p', new Set(['control']))).toBe(false);
    expect(eventMatchesShortcutPrefix(keydown('1', { ctrl: true }), 'mod+p', new Set(['control', 'p']))).toBe(true);
  });

  test('false for an unassigned prefix', () => {
    expect(eventMatchesShortcutPrefix(keydown('1', { ctrl: true }), UNASSIGNED_SHORTCUT)).toBe(false);
  });
});

describe('shortcut sequences', () => {
  test('normalizes, parses, and formats up to two chords', () => {
    expect(normalizeCombo(' command + S   P ')).toBe('mod+s p');
    expect(parseShortcut('mod+s p')?.chords).toHaveLength(2);
    expect(formatShortcutForDisplay('mod+s p')).toBe('Ctrl + S, P');
  });

  test('rejects bindings with more than two chords', () => {
    expect(normalizeCombo('mod+s p q')).toBe('');
    expect(parseShortcut('mod+s p q')).toBe(undefined);
  });

  test('reports exact and prefix conflicts but allows sibling sequences', () => {
    expect(getShortcutConflict('mod+s', 'mod+s')).toBe('exact');
    expect(getShortcutConflict('mod+s', 'mod+s p')).toBe('prefix');
    expect(getShortcutConflict('mod+s p', 'mod+s q')).toBe(undefined);
  });

  test('warns when a sequence leader conflicts with a browser shortcut', () => {
    expect(isRiskyBrowserShortcut('mod+s p')).toBe(true);
  });
});

describe('platform shortcut labels', () => {
  test('normalizes Command and Option to platform-neutral modifiers', () => {
    expect(normalizeCombo('command+option+n')).toBe('mod+alt+n');
  });

  test('uses macOS modifier symbols', () => {
    expect(formatShortcutForDisplay('mod+ctrl+shift+alt+n', 'Unassigned', 'macos')).toBe(
      '⌘ + ⌃ + ⇧ + ⌥ + N',
    );
    expect(formatShortcutForDisplay('alt', 'Unassigned', 'macos')).toBe('⌥');
  });

  test('uses named modifiers on other platforms', () => {
    expect(formatShortcutForDisplay('mod+shift+alt+n', 'Unassigned', 'other')).toBe(
      'Ctrl + Shift + Alt + N',
    );
    expect(formatShortcutForDisplay('alt', 'Unassigned', 'other')).toBe('Alt');
  });
});
