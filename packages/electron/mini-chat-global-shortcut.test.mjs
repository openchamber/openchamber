import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertShortcutComboToAccelerator,
  normalizeStoredShortcutCombo,
  selectMiniChatGlobalShortcutAction,
} from './mini-chat-global-shortcut.mjs';

test('single-chord combos convert to Electron accelerators', () => {
  assert.equal(convertShortcutComboToAccelerator('mod+alt+n'), 'CommandOrControl+Alt+N');
  assert.equal(convertShortcutComboToAccelerator('mod+shift+k'), 'CommandOrControl+Shift+K');
  assert.equal(convertShortcutComboToAccelerator('ctrl+alt+p'), 'Control+Alt+P');
  assert.equal(convertShortcutComboToAccelerator('shift+f2'), 'Shift+F2');
  assert.equal(convertShortcutComboToAccelerator('mod+arrowleft'), 'CommandOrControl+Left');
  assert.equal(convertShortcutComboToAccelerator('alt+space'), 'Alt+Space');
  assert.equal(convertShortcutComboToAccelerator('mod+comma'), 'CommandOrControl+,');
  assert.equal(convertShortcutComboToAccelerator('f5'), 'F5');
  assert.equal(convertShortcutComboToAccelerator('mod+enter'), 'CommandOrControl+Enter');
  assert.equal(convertShortcutComboToAccelerator('mod+/'), 'CommandOrControl+/');
  assert.equal(convertShortcutComboToAccelerator('alt+['), 'Alt+[');
  // Control apart from Command on macOS, and every modifier at once (a hyper key).
  assert.equal(convertShortcutComboToAccelerator('ctrl+n'), 'Control+N');
  assert.equal(convertShortcutComboToAccelerator('mod+shift+alt+n'), 'CommandOrControl+Shift+Alt+N');
  assert.equal(convertShortcutComboToAccelerator('mod+ctrl+shift+alt+n'), 'CommandOrControl+Control+Shift+Alt+N');
  assert.equal(convertShortcutComboToAccelerator('super+n'), 'Super+N');
  assert.equal(convertShortcutComboToAccelerator('mod+super+shift+n'), 'CommandOrControl+Super+Shift+N');
  assert.equal(convertShortcutComboToAccelerator('  mod+alt+n  '), 'CommandOrControl+Alt+N');
});

test('multi-chord, keyless, and unknown combos are not registrable', () => {
  assert.equal(convertShortcutComboToAccelerator('mod+k p'), null);
  assert.equal(convertShortcutComboToAccelerator('mod'), null);
  assert.equal(convertShortcutComboToAccelerator('a+b'), null);
  assert.equal(convertShortcutComboToAccelerator('__unassigned__'), null);
  assert.equal(convertShortcutComboToAccelerator(''), null);
  assert.equal(convertShortcutComboToAccelerator('mod+unknownkey'), null);
});

test('combos without a grabbing modifier are not registrable', () => {
  assert.equal(convertShortcutComboToAccelerator('n'), null);
  assert.equal(convertShortcutComboToAccelerator('shift+n'), null);
  assert.equal(convertShortcutComboToAccelerator('mod+shift'), null);
  assert.equal(convertShortcutComboToAccelerator('enter'), null);
  assert.equal(convertShortcutComboToAccelerator(null), null);
  assert.equal(convertShortcutComboToAccelerator(undefined), null);
});

test('stored combo values collapse to a combo or null', () => {
  assert.equal(normalizeStoredShortcutCombo('mod+alt+n'), 'mod+alt+n');
  assert.equal(normalizeStoredShortcutCombo('  mod+alt+n  '), 'mod+alt+n');
  assert.equal(normalizeStoredShortcutCombo(''), null);
  assert.equal(normalizeStoredShortcutCombo('   '), null);
  assert.equal(normalizeStoredShortcutCombo('__unassigned__'), null);
  assert.equal(normalizeStoredShortcutCombo(undefined), null);
  assert.equal(normalizeStoredShortcutCombo(42), null);
});

test('a focused mini chat hides on the global shortcut', () => {
  assert.deepEqual(selectMiniChatGlobalShortcutAction([
    { id: 1, isMiniChat: false, isFocused: false, focusedAt: 0 },
    { id: 2, isMiniChat: true, isFocused: true, focusedAt: 50 },
    { id: 3, isMiniChat: true, isFocused: false, focusedAt: 100 },
  ], { hasRendererWindow: true }), { type: 'hide', windowId: 2 });
});

test('mini chats without focus focus the most recently focused one', () => {
  assert.deepEqual(selectMiniChatGlobalShortcutAction([
    { id: 2, isMiniChat: true, isFocused: false, focusedAt: 50 },
    { id: 3, isMiniChat: true, isFocused: false, focusedAt: 100 },
  ], { hasRendererWindow: true }), { type: 'focus', windowId: 3 });
  // Ties keep the first mini chat deterministically.
  assert.deepEqual(selectMiniChatGlobalShortcutAction([
    { id: 2, isMiniChat: true, isFocused: false, focusedAt: 0 },
    { id: 3, isMiniChat: true, isFocused: false, focusedAt: 0 },
  ], { hasRendererWindow: true }), { type: 'focus', windowId: 2 });
  // A focused main window never becomes the hide target; the mini chat wins.
  assert.deepEqual(selectMiniChatGlobalShortcutAction([
    { id: 1, isMiniChat: false, isFocused: true, focusedAt: 0 },
    { id: 2, isMiniChat: true, isFocused: false, focusedAt: 0 },
  ], { hasRendererWindow: true }), { type: 'focus', windowId: 2 });
});

test('no mini chat opens a draft when a renderer is alive', () => {
  assert.deepEqual(selectMiniChatGlobalShortcutAction([
    { id: 1, isMiniChat: false, isFocused: false, focusedAt: 0 },
  ], { hasRendererWindow: true }), { type: 'open-draft' });
});

test('no mini chat and no renderer window reveals the main window', () => {
  assert.deepEqual(selectMiniChatGlobalShortcutAction([], { hasRendererWindow: false }), { type: 'reveal-main' });
});
