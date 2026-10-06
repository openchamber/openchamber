// Pure helpers for the Mini Chat global shortcut.
//
// main.mjs wires these to Electron's globalShortcut API; the electron tests
// exercise the logic without an Electron runtime.

export const MINI_CHAT_GLOBAL_SHORTCUT_SETTING_KEY = 'desktopMiniChatGlobalShortcut';

const MODIFIER_TO_ACCELERATOR = {
  mod: 'CommandOrControl',
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super',
};

const KEY_TO_ACCELERATOR = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  space: 'Space',
  tab: 'Tab',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  comma: ',',
  period: '.',
  plus: 'Plus',
  minus: '-',
  enter: 'Enter',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
  '=': '=',
};

// A global shortcut grabs its key system-wide, so a plain or Shift-only key
// would swallow ordinary typing in every app. Function keys are the exception.
const GRABBING_MODIFIERS = new Set(['CommandOrControl', 'Control', 'Alt', 'Super']);
for (let index = 1; index <= 24; index += 1) {
  KEY_TO_ACCELERATOR[`f${index}`] = `F${index}`;
}

// Combos use the in-app shortcut syntax ('mod+alt+n'). A global shortcut must
// be a single chord — multi-chord sequences have no OS-level representation —
// and every key must map onto an Electron accelerator token. Returns the
// accelerator string, or null when the combo cannot be registered globally.
export function convertShortcutComboToAccelerator(combo) {
  if (typeof combo !== 'string') return null;
  const trimmed = combo.trim();
  if (trimmed === '' || trimmed === '__unassigned__') return null;
  if (/\s/.test(trimmed)) return null;
  const parts = trimmed.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const modifier = MODIFIER_TO_ACCELERATOR[part];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== null) return null;
    key = part;
  }
  if (key === null) return null;
  let acceleratorKey = null;
  if (/^[a-z0-9]$/.test(key)) acceleratorKey = key.toUpperCase();
  else if (Object.hasOwn(KEY_TO_ACCELERATOR, key)) acceleratorKey = KEY_TO_ACCELERATOR[key];
  if (!acceleratorKey) return null;
  const isFunctionKey = /^F\d+$/.test(acceleratorKey);
  if (!isFunctionKey && !modifiers.some((modifier) => GRABBING_MODIFIERS.has(modifier))) return null;
  return [...modifiers, acceleratorKey].join('+');
}

// Collapses a stored setting value into a combo string, or null when the
// shortcut is absent, empty, or explicitly unassigned.
export function normalizeStoredShortcutCombo(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '__unassigned__' ? null : trimmed;
}

// Three-state behavior for a global shortcut press:
//   focused mini chat        -> hide it
//   other mini chats alive   -> focus the most recently focused one
//   none, renderer alive     -> open a draft mini chat via the renderer
//   none, no renderer window -> surface the main window so the next press works
//
// `windows` are plain descriptors ({ id, isMiniChat, isFocused, focusedAt });
// ties on focusedAt keep the first (oldest) mini chat deterministically.
export function selectMiniChatGlobalShortcutAction(windows, { hasRendererWindow }) {
  const miniChats = windows.filter((entry) => entry.isMiniChat === true);
  const focused = miniChats.find((entry) => entry.isFocused === true);
  if (focused) return { type: 'hide', windowId: focused.id };
  if (miniChats.length > 0) {
    const target = miniChats.reduce((best, entry) => (
      (entry.focusedAt ?? 0) > (best.focusedAt ?? 0) ? entry : best
    ));
    return { type: 'focus', windowId: target.id };
  }
  return hasRendererWindow ? { type: 'open-draft' } : { type: 'reveal-main' };
}
