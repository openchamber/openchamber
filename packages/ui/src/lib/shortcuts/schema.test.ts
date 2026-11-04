import { describe, expect, test } from 'bun:test';
import {
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getNativeMenuShortcutCombos,
  getShortcutBindingConflicts,
  getShortcutAction,
  isMenuAcceleratorCombo,
  isShortcutAvailable,
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
      'desktop',
    ]);
  });

  test('derives settings labels for every customizable shortcut', () => {
    const customizable = getCustomizableShortcutActions();
    expect(customizable.length).toBeGreaterThan(0);
    expect(customizable.every((action) => (
      action.settingsLabelKey === `settings.openchamber.keyboardShortcuts.action.${action.id}.label`
    ))).toBe(true);
  });

  test('keeps the mod+k leader for open/go actions', () => {
    expect(getShortcutAction('open_draft_project_picker')?.defaultBinding).toBe('mod+k p');
    expect(getShortcutAction('open_draft_worktree_picker')?.defaultBinding).toBe('mod+k g');
    expect(getShortcutAction('open_session_list')?.defaultBinding).toBe('mod+k l');
    expect(getShortcutAction('open_timeline_dialog')?.defaultBinding).toBe('mod+k t');
    expect(getShortcutAction('toggle_prompt_navigator')?.defaultBinding).toBe('mod+k n');
    expect(getShortcutAction('toggle_services_menu')?.defaultBinding).toBe('mod+k i');
    expect(getShortcutAction('open_help')?.defaultBinding).toBe('mod+k h');
    expect(getShortcutAction('cycle_theme')?.defaultBinding).toBe('mod+k c');
    expect(getShortcutAction('focus_input')?.category).toBe('session');
  });

  test('exposes prompt history search as a customizable session shortcut', () => {
    const action = getShortcutAction('search_prompt_history');

    expect(action?.category).toBe('session');
    expect(action?.defaultBinding).toBe('mod+arrowup');
    expect(action?.customizable).toBe(true);
    if (action?.customizable !== true) throw new Error('search_prompt_history must be customizable');
    expect(action.settingsLabelKey)
      .toBe('settings.openchamber.keyboardShortcuts.action.search_prompt_history.label');
  });

  test('splits the held digit prefixes between session tabs and surfaces', () => {
    expect(getShortcutAction('switch_session_tab')?.defaultBinding).toBe('mod');
    expect(getShortcutAction('switch_context_surface')?.defaultBinding).toBe('mod+alt');
  });

  test('lists every keyboard action in Settings except the double Escape stop', () => {
    expect(SHORTCUT_SCHEMA.filter((action) => !action.customizable).map((action) => action.id)).toEqual(['abort_run']);
  });

  test('keeps native menu keys out of the way where the menu does not exist', () => {
    const conflict = getShortcutBindingConflicts('new_chat', 'mod+shift+g')
      .find((candidate) => candidate.action.id === 'open_git_panel');
    expect(conflict).toBeUndefined();
    expect(isShortcutAvailable(getShortcutAction('open_git_panel')!)).toBe(false);
    expect(isShortcutAvailable(getShortcutAction('new_chat')!)).toBe(true);
  });

  test('accepts only combos the native menu can show', () => {
    for (const combo of ['alt+insert', 'mod+minus', 'mod+=', 'ctrl+alt+arrowup', 'mod+shift+alt+n']) {
      expect(isMenuAcceleratorCombo(combo)).toBe(true);
    }
    for (const combo of ['g', 'shift+g', 'mod+k g', 'alt+capslock', 'alt+contextmenu']) {
      expect(isMenuAcceleratorCombo(combo)).toBe(false);
    }
  });

  test('reports the menu keys, with an unassigned one as empty', () => {
    const combos = getNativeMenuShortcutCombos({ zoom_in: 'mod+shift+=', zoom_out: '__unassigned__' });
    expect(combos.zoom_in).toBe('mod+shift+=');
    expect(combos.zoom_out).toBe('');
    expect(combos.new_window).toBe('mod+shift+alt+n');
    expect(Object.keys(combos)).toHaveLength(10);
  });

  test('every action ships with a default binding', () => {
    // Palette-only commands live outside this schema entirely; an action in
    // the schema without a binding would be dead weight in Settings.
    // Desktop-category actions are the exception: they register as OS-level
    // global shortcuts, not in-app bindings, so their default is unassigned.
    for (const action of SHORTCUT_SCHEMA) {
      if (action.category === 'desktop') continue;
      expect(getEffectiveShortcutCombo(action.id)).not.toBe('');
    }
  });

  test('preserves valid overrides and falls back from malformed bindings', () => {
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k' })).toBe('mod+k');
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k x y' })).toBe('mod+n');
  });

  test('keeps internal bindings authoritative over persisted overrides', () => {
    expect(getEffectiveShortcutCombo('abort_run', { abort_run: 'mod+k' })).toBe('escape');
    expect(getEffectiveShortcutCombo('abort_run', { abort_run: '__unassigned__' })).toBe('escape');
  });

  test('surfaces a desktop global combo override as a replaceable conflict', () => {
    const conflict = getShortcutBindingConflicts('new_chat', 'mod+alt+m', { mini_chat_global: 'mod+alt+m' })
      .find((candidate) => candidate.action.id === 'mini_chat_global');
    expect(conflict?.kind).toBe('exact');
    expect(conflict?.action.customizable).toBe(true);
  });

  test('detects conflicts against customizable and internal bindings', () => {
    const customizableConflict = getShortcutBindingConflicts('new_chat', 'mod+p')
      .find((conflict) => conflict.action.id === 'open_command_palette');
    const internalConflict = getShortcutBindingConflicts('new_chat', 'escape')
      .find((conflict) => conflict.action.id === 'abort_run');
    const internalPrefixConflict = getShortcutBindingConflicts('new_chat', 'escape x')
      .find((conflict) => conflict.action.id === 'abort_run');
    const leaderPrefixConflict = getShortcutBindingConflicts('new_chat', 'mod+k')
      .find((conflict) => conflict.action.id === 'open_session_list');
    const blockingPrefixConflict = getShortcutBindingConflicts('new_chat', 'mod+p x')
      .find((conflict) => conflict.action.id === 'open_command_palette');

    expect(customizableConflict?.kind).toBe('exact');
    expect(customizableConflict?.action.customizable).toBe(true);
    expect(internalConflict?.kind).toBe('exact');
    expect(internalConflict?.action.customizable).toBe(false);
    expect(internalPrefixConflict?.kind).toBe('prefix');
    expect(internalPrefixConflict?.action.customizable).toBe(false);
    expect(leaderPrefixConflict?.kind).toBe('prefix');
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
