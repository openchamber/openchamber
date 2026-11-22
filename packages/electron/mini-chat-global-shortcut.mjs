
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
  super: 'Super',
  win: 'Super',
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
  insert: 'Insert',
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

const GRABBING_MODIFIERS = new Set(['CommandOrControl', 'Control', 'Alt', 'Super']);
for (let index = 1; index <= 24; index += 1) {
  KEY_TO_ACCELERATOR[`f${index}`] = `F${index}`;
}

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

export function normalizeStoredShortcutCombo(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '__unassigned__' ? null : trimmed;
}

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
