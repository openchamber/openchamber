import { isMacOS } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';

type ShortcutModifier = 'mod' | 'shift' | 'alt' | 'option' | 'ctrl';
type ShortcutKey = string;
export type ShortcutCombo = string;

export const UNASSIGNED_SHORTCUT: ShortcutCombo = '__unassigned__';

export interface ShortcutAction {
  id: string;
  defaultCombo: ShortcutCombo;
  label: string;
  description?: string;
  customizable?: boolean;
}

interface ParsedShortcut {
  modifiers: Set<ShortcutModifier>;
  key: ShortcutKey;
}

const MODIFIER_KEY_MAP: Record<string, ShortcutModifier> = {
  'mod': 'mod',
  'shift': 'shift',
  'alt': 'alt',
  'option': 'alt',
  'ctrl': 'ctrl',
  'meta': 'mod',
  'cmd': 'mod',
  'command': 'mod',
};

const DISPLAY_LABEL_MAP: Record<ShortcutModifier, string> = {
  'mod': isMacOS() && isDesktopShell() ? '⌘' : 'Ctrl',
  'shift': '⇧',
  'alt': '⌥',
  'option': '⌥',
  'ctrl': '⌃',
};

const KEY_LABEL_MAP: Record<string, string> = {
  'comma': ',',
  'period': '.',
  'enter': 'Enter',
  'escape': 'Esc',
  'tab': 'Tab',
  'space': 'Space',
  'backspace': '⌫',
  'delete': '⌦',
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'home': 'Home',
  'end': 'End',
  'pageup': 'Page Up',
  'pagedown': 'Page Down',
  'backtick': '`',
  'grave': '`',
  '=': '=',
  'equal': '=',
  'plus': '+',
  'minus': '-',
  '-': '-',
};

const MODIFIER_PRIORITY: ShortcutModifier[] = ['mod', 'ctrl', 'shift', 'alt'];

const SHIFTED_KEY_BASE_MAP: Record<string, string> = {
  '{': '[',
  '}': ']',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '|': '\\',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

function isUnassignedShortcut(combo: ShortcutCombo): boolean {
  return combo.trim().toLowerCase() === UNASSIGNED_SHORTCUT;
}

export function keyToShortcutToken(key: string): string {
  const lowered = key.toLowerCase();

  if (lowered === ',') return 'comma';
  if (lowered === '.') return 'period';
  if (lowered === ' ') return 'space';
  if (lowered === 'esc') return 'escape';
  if (lowered === '+') return 'plus';
  if (lowered === '-' || lowered === '_') return 'minus';
  if (lowered === 'arrowup') return 'arrowup';
  if (lowered === 'arrowdown') return 'arrowdown';
  if (lowered === 'arrowleft') return 'arrowleft';
  if (lowered === 'arrowright') return 'arrowright';
  if (lowered === '`') return 'backtick';

  return SHIFTED_KEY_BASE_MAP[lowered] ?? lowered;
}

const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = [
  {
    id: 'open_go_to_line',
    defaultCombo: 'alt+g',
    label: 'Go to line (files editor)',
    description: 'Open go to line in the files editor',
    customizable: true,
  },
  {
    id: 'open_command_palette',
    defaultCombo: 'mod+p',
    label: 'Open command palette',
    description: 'Open the command palette',
    customizable: true,
  },
  {
    id: 'focus_input',
    defaultCombo: 'mod+i',
    label: 'Focus input',
    description: 'Focus the chat input field',
    customizable: true,
  },
  {
    id: 'open_status',
    defaultCombo: 'mod+shift+o',
    label: 'Open OpenCode status',
    description: 'Open the OpenCode status dialog',
  },
  {
    id: 'open_settings',
    defaultCombo: 'mod+comma',
    label: 'Open settings',
    description: 'Open the settings panel',
    customizable: true,
  },
  {
    id: 'toggle_terminal',
    defaultCombo: 'mod+backtick',
    label: 'Toggle terminal',
    description: 'Toggle the integrated terminal',
    customizable: true,
  },
  {
    id: 'toggle_bottom_panel',
    defaultCombo: 'mod+j',
    label: 'Toggle bottom panel',
    description: 'Toggle the bottom panel dock',
    customizable: true,
  },
  {
    id: 'toggle_terminal_expanded',
    defaultCombo: 'mod+shift+j',
    label: 'Toggle terminal expanded',
    description: 'Toggle terminal expanded or collapsed',
    customizable: true,
  },
  {
    id: 'toggle_files',
    defaultCombo: 'mod+shift+f',
    label: 'Toggle files',
    description: 'Toggle the files panel',
  },
  {
    id: 'toggle_sidebar',
    defaultCombo: 'mod+b',
    label: 'Toggle sidebar',
    description: 'Toggle the session sidebar',
    customizable: true,
  },
  {
    id: 'open_timeline_dialog',
    defaultCombo: 'mod+t',
    label: 'Open conversation timeline',
    description: 'Search and navigate within current conversation',
    customizable: true,
  },
  {
    id: 'toggle_right_sidebar',
    defaultCombo: 'mod+alt+b',
    label: 'Toggle review panel',
    description: 'Toggle the review panel (right sidebar)',
    customizable: true,
  },
  {
    id: 'open_right_sidebar_git',
    defaultCombo: 'mod+shift+g',
    label: 'Open right sidebar Git tab',
    description: 'Open right sidebar and select Git',
    customizable: true,
  },
  {
    id: 'open_right_sidebar_files',
    defaultCombo: 'mod+shift+f',
    label: 'Open right sidebar Files tab',
    description: 'Open right sidebar and select Files',
    customizable: true,
  },
  {
    id: 'cycle_right_sidebar_tab',
    defaultCombo: 'mod+alt+shift+r',
    label: 'Cycle right sidebar tab',
    description: 'Cycle through right sidebar tabs',
    customizable: true,
  },
  {
    id: 'close_context_panel_tab',
    defaultCombo: 'mod+w',
    label: 'Close context panel tab',
    description: 'Close the active context panel tab (closes the panel when empty)',
    customizable: true,
  },
  {
    id: 'previous_session',
    defaultCombo: 'mod+shift+[',
    label: 'Previous session',
    description: 'Switch to the previous session',
    customizable: true,
  },
  {
    id: 'next_session',
    defaultCombo: 'mod+shift+]',
    label: 'Next session',
    description: 'Switch to the next session',
    customizable: true,
  },
  {
    id: 'new_chat',
    defaultCombo: 'mod+n',
    label: 'New session',
    description: 'Start a new session',
    customizable: true,
  },
  {
    id: 'new_chat_worktree',
    defaultCombo: 'mod+shift+n',
    label: 'New worktree draft',
    description: 'Create a new worktree and open a draft in it',
    customizable: true,
  },
  {
    id: 'new_mini_chat',
    defaultCombo: 'mod+alt+n',
    label: 'New Mini Chat window',
    description: 'Open a new Mini Chat draft window',
    customizable: true,
  },
  {
    id: 'submit_message',
    defaultCombo: 'mod+enter',
    label: 'Submit message',
    description: 'Submit the current message',
  },
  {
    id: 'clear_input',
    defaultCombo: 'escape',
    label: 'Clear input',
    description: 'Clear the input field',
  },
  {
    id: 'open_diff_panel',
    defaultCombo: 'mod+2',
    label: 'Open diff panel',
    description: 'Switch to the diff panel',
  },
  {
    id: 'open_terminal_panel',
    defaultCombo: 'mod+3',
    label: 'Open terminal panel',
    description: 'Switch to the terminal panel',
  },
  {
    id: 'open_git_panel',
    defaultCombo: 'mod+4',
    label: 'Open git panel',
    description: 'Switch to the git panel',
  },
  {
    id: 'open_help',
    defaultCombo: 'mod+.',
    label: 'Open keyboard shortcuts',
    description: 'Show the keyboard shortcuts help',
    customizable: true,
  },
  {
    id: 'toggle_context_plan',
    defaultCombo: 'mod+shift+p',
    label: 'Toggle plan context panel',
    description: 'Open or close plan in the context panel',
    customizable: true,
  },
  {
    id: 'toggle_services_menu',
    defaultCombo: 'mod+shift+s',
    label: 'Toggle services menu',
    description: 'Open or close the services menu',
    customizable: true,
  },
  {
    id: 'cycle_services_tab',
    defaultCombo: 'mod+alt+shift+s',
    label: 'Cycle services tab',
    description: 'Cycle through tabs in the services menu',
    customizable: true,
  },
  {
    id: 'cycle_theme',
    defaultCombo: 'mod+/',
    label: 'Cycle theme',
    description: 'Cycle between light, dark, and system theme',
    customizable: true,
  },
  {
    id: 'zoom_in',
    defaultCombo: 'mod+=',
    label: 'Zoom in',
    description: 'Increase the webview zoom level',
    customizable: true,
  },
  {
    id: 'zoom_out',
    defaultCombo: 'mod+-',
    label: 'Zoom out',
    description: 'Decrease the webview zoom level',
    customizable: true,
  },
  {
    id: 'zoom_reset',
    defaultCombo: 'mod+0',
    label: 'Reset zoom',
    description: 'Reset the webview zoom level to 100%',
    customizable: true,
  },
  {
    id: 'leader_key',
    defaultCombo: 'ctrl+x',
    label: 'Leader key',
    description: 'Start an OpenCode-style chord, then press M / A / N / C',
    customizable: true,
  },
  {
    id: 'open_model_selector',
    defaultCombo: 'mod+shift+m',
    label: 'Open model selector',
    description: 'Open model selector while in chat',
    customizable: true,
  },
  {
    id: 'cycle_thinking_variant',
    defaultCombo: 'mod+shift+t',
    label: 'Cycle thinking variant',
    description: 'Cycle thinking variant while in chat',
  },
  {
    id: 'cycle_agent',
    defaultCombo: 'tab',
    label: 'Cycle agent',
    description: 'Cycle agent while the model selector is open',
    customizable: true,
  },
  {
    id: 'cycle_favorite_model_forward',
    defaultCombo: 'ctrl+]',
    label: 'Cycle favorite model forward',
    description: 'Cycle forward through starred models without opening the picker',
    customizable: true,
  },
  {
    id: 'cycle_favorite_model_backward',
    defaultCombo: 'ctrl+[',
    label: 'Cycle favorite model backward',
    description: 'Cycle backward through starred models without opening the picker',
    customizable: true,
  },
  {
    id: 'expand_input',
    defaultCombo: 'mod+shift+e',
    label: 'Expand input',
    description: 'Toggle focus mode for the chat input',
    customizable: true,
  },
  {
    id: 'toggle_dictation',
    defaultCombo: 'mod+alt+v',
    label: 'Voice input',
    description: 'Start dictation; press again to confirm and insert the transcript',
    customizable: true,
  },
  {
    id: 'abort_run',
    defaultCombo: 'escape',
    label: 'Abort active run',
    description: 'Abort the currently running task (double press)',
  },
  {
    id: 'switch_tab_1',
    defaultCombo: 'mod+1',
    label: 'Switch to visible session 1',
    description: 'Switch to the first visible sidebar session',
  },
  {
    id: 'switch_tab_2',
    defaultCombo: 'mod+2',
    label: 'Switch to visible session 2',
    description: 'Switch to the second visible sidebar session',
  },
  {
    id: 'switch_tab_3',
    defaultCombo: 'mod+3',
    label: 'Switch to visible session 3',
    description: 'Switch to the third visible sidebar session',
  },
  {
    id: 'switch_tab_4',
    defaultCombo: 'mod+4',
    label: 'Switch to visible session 4',
    description: 'Switch to the fourth visible sidebar session',
  },
  {
    id: 'switch_tab_5',
    defaultCombo: 'mod+5',
    label: 'Switch to visible session 5',
    description: 'Switch to the fifth visible sidebar session',
  },
  {
    id: 'switch_tab_6',
    defaultCombo: 'mod+6',
    label: 'Switch to visible session 6',
    description: 'Switch to the sixth visible sidebar session',
  },
  {
    id: 'switch_tab_7',
    defaultCombo: 'mod+7',
    label: 'Switch to visible session 7',
    description: 'Switch to the seventh visible sidebar session',
  },
  {
    id: 'switch_tab_8',
    defaultCombo: 'mod+8',
    label: 'Switch to visible session 8',
    description: 'Switch to the eighth visible sidebar session',
  },
  {
    id: 'switch_tab_9',
    defaultCombo: 'mod+9',
    label: 'Switch to visible session 9',
    description: 'Switch to the ninth visible sidebar session',
  },
] as const;

export function normalizeCombo(combo: ShortcutCombo): ShortcutCombo {
  if (isUnassignedShortcut(combo)) {
    return UNASSIGNED_SHORTCUT;
  }

  const rawParts = combo
    .toLowerCase()
    .trim()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  const modifiers = new Set<ShortcutModifier>();
  let key = '';

  for (const rawPart of rawParts) {
    const part = rawPart === ',' ? 'comma' : rawPart === '.' ? 'period' : rawPart;
    const modifier = MODIFIER_KEY_MAP[part];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    key = part;
  }

  const orderedModifiers = MODIFIER_PRIORITY.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].filter(Boolean).join('+');
}

function isValidShortcutCombo(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return true;
  }

  const parsed = parseShortcut(combo);
  return parsed.key.trim().length > 0;
}

function parseShortcut(combo: ShortcutCombo): ParsedShortcut {
  if (isUnassignedShortcut(combo)) {
    return { modifiers: new Set<ShortcutModifier>(), key: UNASSIGNED_SHORTCUT };
  }

  const normalized = normalizeCombo(combo);
  const parts = normalized.split('+');
  const modifiers: Set<ShortcutModifier> = new Set();
  let key: ShortcutKey = '';

  for (const part of parts) {
    const modifier = MODIFIER_KEY_MAP[part];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      key = part;
    }
  }

  return { modifiers, key };
}

export function formatShortcutForDisplay(combo: ShortcutCombo): string {
  if (isUnassignedShortcut(combo)) {
    return 'Unassigned';
  }

  const parsed = parseShortcut(combo);

  if (!parsed.key && parsed.modifiers.size === 0) {
    return 'Unassigned';
  }

  const parts: string[] = [];

  for (const modifier of MODIFIER_PRIORITY) {
    if (parsed.modifiers.has(modifier)) {
      parts.push(DISPLAY_LABEL_MAP[modifier]);
    }
  }

  if (parsed.key) {
    const keyLabel = KEY_LABEL_MAP[parsed.key.toLowerCase()] || parsed.key.toUpperCase();
    parts.push(keyLabel);
  }

  return parts.join(' + ');
}

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<ShortcutAction> {
  return SHORTCUT_ACTIONS.filter((action) => action.customizable === true);
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) {
    return '';
  }

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    if (override.trim().toLowerCase() === UNASSIGNED_SHORTCUT) {
      return '';
    }

    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) {
      return UNASSIGNED_SHORTCUT;
    }

    if (isValidShortcutCombo(normalized)) {
      return normalized;
    }
  }

  return action.defaultCombo;
}

export function isRiskyBrowserShortcut(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);
  if (!parsed.modifiers.has('mod')) {
    return false;
  }

  const key = parsed.key.toLowerCase();
  const dangerousPrimary = new Set(['w', 't', 'r', 'p', 's', 'f', 'l', 'n']);
  return dangerousPrimary.has(key) && !parsed.modifiers.has('shift') && !parsed.modifiers.has('alt');
}

export function eventMatchesShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  shortcut: ShortcutAction | ShortcutCombo
): boolean {
  const combo = typeof shortcut === 'string' ? shortcut : shortcut.defaultCombo;
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);

  const expectedMod = parsed.modifiers.has('mod');
  const expectedShift = parsed.modifiers.has('shift');
  const expectedAlt = parsed.modifiers.has('alt');
  const expectedCtrl = parsed.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();

  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (expectedMod && !modMatches) {
    return false;
  }

  if (!expectedMod && event.metaKey) {
    return false;
  }

  if (expectedShift !== event.shiftKey) {
    return false;
  }

  if (expectedAlt !== event.altKey) {
    return false;
  }

  if (expectedCtrl) {
    if (!event.ctrlKey) {
      return false;
    }
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) {
      return false;
    }
  }

  let eventKeyRaw = event.key;
  if ((!eventKeyRaw || eventKeyRaw === 'Dead') && event.code === 'Backquote') {
    eventKeyRaw = '`';
  }
  if (event.altKey) {
    if (event.code.startsWith('Key') && event.code.length === 4) {
      eventKeyRaw = event.code.slice(3).toLowerCase();
    } else if (event.code.startsWith('Digit') && event.code.length === 6) {
      eventKeyRaw = event.code.slice(5);
    }
  }

  const eventKey = keyToShortcutToken(eventKeyRaw);
  const expectedKey = keyToShortcutToken(parsed.key);

  return eventKey === expectedKey;
}

export function getModifierLabel(): string {
  return isMacOS() && isDesktopShell() ? '⌘' : 'Ctrl';
}

/**
 * Zoom shortcuts accept both the unshifted and shifted key variants
 * (Mod+= / Mod++, Mod+- / Mod+_), matching browser/Codex conventions.
 */
export function eventMatchesZoomShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  direction: 'in' | 'out',
  effectiveCombo: ShortcutCombo,
): boolean {
  if (eventMatchesShortcut(event, effectiveCombo)) {
    return true;
  }

  const normalized = normalizeCombo(effectiveCombo);
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();
  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (!modMatches || event.altKey) {
    return false;
  }

  // Reject plain Ctrl on desktop Mac when the binding is Mod-only.
  if (isDesktopMac && event.ctrlKey && !event.metaKey) {
    return false;
  }

  if (direction === 'in' && normalized === 'mod+=') {
    return event.key === '+' || event.code === 'NumpadAdd';
  }

  if (direction === 'out' && (normalized === 'mod+-' || normalized === 'mod+minus')) {
    return event.key === '_' || event.code === 'NumpadSubtract';
  }

  return false;
}
