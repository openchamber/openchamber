import { describe, expect, test } from 'bun:test';
import {
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getShortcutBindingConflicts,
  getShortcutAction,
  parseShortcut,
  SHORTCUT_SCHEMA,
  type ShortcutCategory,
} from './index';

describe('shortcut schema', () => {
  test('declares unique IDs and valid bindings for every application shortcut', () => {
    const ids = SHORTCUT_SCHEMA.map((action) => action.id);
    const hasValidMetadata = SHORTCUT_SCHEMA.every((action) => {
      const chordCount = parseShortcut(action.defaultBinding)?.chords.length;
      return Boolean(action.category)
        && chordCount !== undefined
        && chordCount >= 1
        && chordCount <= 2;
    });

    expect(new Set(ids).size).toBe(ids.length);
    expect(hasValidMetadata).toBe(true);
  });

  test('keeps the flattened schema grouped in Settings order', () => {
    const groupOrder: ShortcutCategory[] = [];
    for (const action of SHORTCUT_SCHEMA) {
      if (groupOrder.at(-1) !== action.category) {
        groupOrder.push(action.category);
      }
    }

    expect(groupOrder).toEqual([
      'session',
      'models',
      'panels',
      'navigation',
      'application',
    ]);
  });

  test('derives settings labels for every customizable shortcut', () => {
    const customizable = getCustomizableShortcutActions();
    expect(customizable.length).toBeGreaterThan(0);
    expect(customizable.every((action) => (
      action.settingsLabelKey === `settings.openchamber.keyboardShortcuts.action.${action.id}.label`
    ))).toBe(true);
  });

  test('includes session prefix bindings and metadata', () => {
    expect(getShortcutAction('open_draft_project_picker')?.defaultBinding).toBe('mod+s p');
    expect(getShortcutAction('open_draft_worktree_picker')?.defaultBinding).toBe('mod+s g');
    expect(getShortcutAction('open_session_list')?.defaultBinding).toBe('mod+s l');
    expect(getShortcutAction('focus_input')?.category).toBe('session');
  });

  test('preserves valid overrides and falls back from malformed bindings', () => {
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k' })).toBe('mod+k');
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k x y' })).toBe('mod+n');
  });

  test('keeps internal bindings authoritative over persisted overrides', () => {
    expect(getEffectiveShortcutCombo('save_file', { save_file: 'mod+k' })).toBe('mod+s');
    expect(getEffectiveShortcutCombo('save_file', { save_file: '__unassigned__' })).toBe('mod+s');
  });

  test('detects conflicts against customizable and internal bindings', () => {
    const customizableConflict = getShortcutBindingConflicts('new_chat', 'mod+p')
      .find((conflict) => conflict.action.id === 'open_command_palette');
    const internalConflict = getShortcutBindingConflicts('new_chat', 'mod+f')
      .find((conflict) => conflict.action.id === 'find_in_file');
    const internalPrefixConflict = getShortcutBindingConflicts('new_chat', 'mod+s x')
      .find((conflict) => conflict.action.id === 'save_file');
    const contextualPrefixConflict = getShortcutBindingConflicts('focus_input', 'mod+l l')
      .find((conflict) => conflict.action.id === 'add_selection_to_chat');
    const contextualLeaderConflict = getShortcutBindingConflicts('add_selection_to_chat', 'mod+s')
      .find((conflict) => conflict.action.id === 'open_draft_project_picker');
    const blockingPrefixConflict = getShortcutBindingConflicts('new_chat', 'mod+p x')
      .find((conflict) => conflict.action.id === 'open_command_palette');

    expect(customizableConflict?.kind).toBe('exact');
    expect(customizableConflict?.action.customizable).toBe(true);
    expect(internalConflict?.kind).toBe('exact');
    expect(internalConflict?.action.customizable).toBe(false);
    expect(internalPrefixConflict?.kind).toBe('contextual-prefix');
    expect(internalPrefixConflict?.action.customizable).toBe(false);
    expect(contextualPrefixConflict?.kind).toBe('contextual-prefix');
    expect(contextualLeaderConflict?.kind).toBe('contextual-prefix');
    expect(blockingPrefixConflict?.kind).toBe('prefix');
  });
});

describe('shortcut defaults', () => {
    // Two actions silently sharing a default binding would race at dispatch
    // (registry insertion order decides). Pairs that intentionally share a
    // combo because they can never be active in the same runtime must be
    // whitelisted here explicitly.
    const RUNTIME_EXCLUSIVE_BINDING_PAIRS: ReadonlyArray<ReadonlySet<string>> = [];

    test('no two actions share a normalized default binding', () => {
        const byBinding = new Map<string, string[]>();
        for (const action of SHORTCUT_SCHEMA) {
            const combo = getEffectiveShortcutCombo(action.id);
            if (!combo) continue;
            const list = byBinding.get(combo) ?? [];
            list.push(action.id);
            byBinding.set(combo, list);
        }
        const conflicts = [...byBinding.entries()]
            .filter(([, ids]) => ids.length > 1)
            .filter(([, ids]) => !RUNTIME_EXCLUSIVE_BINDING_PAIRS.some(
                (pair) => ids.every((id) => pair.has(id)),
            ))
            .map(([combo, ids]) => `"${combo}" shared by ${ids.join(', ')}`);
        expect(conflicts).toEqual([]);
    });

    test('overrides recorded under the flat-file era still resolve', () => {
        // The persisted override format is a flat Record<string, string> and
        // must keep resolving through the schema after the module split.
        const overrides = { close_session_tab: 'alt+q', open_command_palette: 'mod+shift+k' };
        expect(getEffectiveShortcutCombo('close_session_tab', overrides)).toBe('alt+q');
        expect(getEffectiveShortcutCombo('open_command_palette', overrides)).toBe('mod+shift+k');
        // Unknown ids stay inert rather than throwing.
        expect(getEffectiveShortcutCombo('close_session_tab', { ghost_action: 'mod+z', close_session_tab: 'alt+q' } as Record<string, string>)).toBe('alt+q');
    });
});
