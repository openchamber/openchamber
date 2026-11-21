
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

export function normalizeMenuShortcuts(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([id]) => MENU_SHORTCUT_IDS.has(id)));
}

export function menuAccelerator(shortcuts, id, fallback) {
  if (!Object.hasOwn(shortcuts, id)) return fallback;
  return convertShortcutComboToAccelerator(shortcuts[id]) ?? undefined;
}
