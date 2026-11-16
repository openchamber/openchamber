// Pure helpers for the app menu keys Settings can rebind.
//
// main.mjs applies these to the menu templates; the electron tests exercise
// the logic without an Electron runtime.

import { convertShortcutComboToAccelerator } from './mini-chat-global-shortcut.mjs';

const MENU_SHORTCUT_IDS = new Set([
  'new_window',
  'open_git_panel',
  'previous_project',
  'next_project',
  'show_diagnostics',
  'toggle_developer_tools',
  'toggle_memory_debug',
  'zoom_in',
  'zoom_out',
  'zoom_reset',
]);

// Keeps the known ids from the renderer's map; anything else is dropped.
export function normalizeMenuShortcuts(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([id]) => MENU_SHORTCUT_IDS.has(id)));
}

// The item's built-in key until the renderer reports one. A reported empty
// combo means unassigned: the item stays in the menu without a key.
export function menuAccelerator(shortcuts, id, fallback) {
  if (!Object.hasOwn(shortcuts, id)) return fallback;
  return convertShortcutComboToAccelerator(shortcuts[id]) ?? undefined;
}
