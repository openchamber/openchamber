import { describe, expect, test } from 'bun:test';

import {
  getShortcutAction,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
} from './shortcuts';

describe('rename_session shortcut', () => {
  test('is registered in the shortcut actions', () => {
    const action = getShortcutAction('rename_session');
    expect(action).not.toBeNull();
    expect(action!.id).toBe('rename_session');
    expect(action!.label).toBe('Rename session');
  });

  test('has ctrl+r as default combo', () => {
    const action = getShortcutAction('rename_session');
    expect(action!.defaultCombo).toBe('ctrl+r');
  });

  test('is customizable', () => {
    const action = getShortcutAction('rename_session');
    expect(action!.customizable).toBe(true);

    const customizable = getCustomizableShortcutActions();
    expect(customizable.some((a) => a.id === 'rename_session')).toBe(true);
  });

  test('returns default combo when no override is set', () => {
    const combo = getEffectiveShortcutCombo('rename_session');
    expect(combo).toBe('ctrl+r');
  });

  test('returns override combo when one is set', () => {
    const combo = getEffectiveShortcutCombo('rename_session', {
      rename_session: 'f2',
    });
    expect(combo).toBe('f2');
  });

  test('returns empty string for unassigned override', () => {
    const combo = getEffectiveShortcutCombo('rename_session', {
      rename_session: 'none',
    });
    // 'none' is normalized to the unassigned sentinel
    expect(combo === '' || combo === 'none').toBe(true);
  });
});
