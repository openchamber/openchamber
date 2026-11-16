import assert from 'node:assert/strict';
import test from 'node:test';

import { menuAccelerator, normalizeMenuShortcuts } from './menu-shortcuts.mjs';

test('default combos produce the same keys as the menu templates', () => {
  const shortcuts = {
    new_window: 'mod+shift+alt+n',
    previous_project: 'ctrl+alt+arrowup',
    zoom_in: 'mod+=',
    zoom_out: 'mod+minus',
    zoom_reset: 'mod+0',
  };
  assert.equal(menuAccelerator(shortcuts, 'new_window', 'x'), 'CommandOrControl+Shift+Alt+N');
  assert.equal(menuAccelerator(shortcuts, 'previous_project', 'x'), 'Control+Alt+Up');
  assert.equal(menuAccelerator(shortcuts, 'zoom_in', 'x'), 'CommandOrControl+=');
  assert.equal(menuAccelerator(shortcuts, 'zoom_out', 'x'), 'CommandOrControl+-');
  assert.equal(menuAccelerator(shortcuts, 'zoom_reset', 'x'), 'CommandOrControl+0');
});

test('an item keeps its built-in key until the renderer reports one', () => {
  assert.equal(menuAccelerator({}, 'open_git_panel', 'Cmd+Shift+G'), 'Cmd+Shift+G');
});

test('an unassigned or unusable combo leaves the item without a key', () => {
  assert.equal(menuAccelerator({ open_git_panel: '' }, 'open_git_panel', 'Cmd+Shift+G'), undefined);
  assert.equal(menuAccelerator({ open_git_panel: 'mod+k g' }, 'open_git_panel', 'Cmd+Shift+G'), undefined);
});

test('every key Settings accepts for a menu item converts to an accelerator', () => {
  const keys = ['a', '7', 'f12', 'f24', 'arrowup', 'space', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end',
    'pageup', 'pagedown', 'comma', 'period', 'plus', 'minus', 'enter', '/', ';', "'", '[', ']', '\\', '`', '='];
  for (const key of keys) {
    assert.ok(menuAccelerator({ new_window: `alt+${key}` }, 'new_window'), key);
  }
});

test('the renderer map keeps only known ids', () => {
  assert.deepEqual(normalizeMenuShortcuts({ zoom_in: 'mod+=', other: 'mod+x' }), { zoom_in: 'mod+=' });
  assert.deepEqual(normalizeMenuShortcuts(null), {});
});
