import { isMacOS } from '@/lib/utils';
import { isTauriShell } from '@/lib/desktop';

export type ShortcutModifier = 'mod' | 'shift' | 'alt' | 'option' | 'ctrl';
export type ShortcutKey = string;
export type ShortcutCombo = string;

export const UNASSIGNED_SHORTCUT: ShortcutCombo = '__unassigned__';

export interface ShortcutAction {
  id: string;
  defaultCombo: ShortcutCombo;
  label: string;
  description?: string;
  customizable?: boolean;
}

export interface ParsedShortcut {
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
  'mod': isMacOS() && isTauriShell() ? '⌘' : 'Ctrl',
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

  return SHIFTED_KEY_BASE_MAP[lowered] ?? lowered;
}

const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = [
  {
    id: 'open_command_palette',
    defaultCombo: 'mod+k',
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
    defaultCombo: 'mod+j',
    label: 'Toggle terminal dock',
    description: 'Toggle the bottom terminal dock',
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
    defaultCombo: 'mod+l',
    label: 'Toggle sidebar',
    description: 'Toggle the session sidebar',
    customizable: true,
  },
  {
    id: 'toggle_nav_rail',
    defaultCombo: 'mod+shift+l',
    label: 'Toggle project rail',
    description: 'Expand or collapse the project navigation rail',
    customizable: true,
  },
  {
    id: 'toggle_right_sidebar',
    defaultCombo: 'mod+b',
    label: 'Toggle right sidebar',
    description: 'Toggle the right sidebar',
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
    defaultCombo: 'mod+shift+]',
    label: 'Cycle right sidebar tab',
    description: 'Cycle through right sidebar tabs',
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
    label: 'New session with worktree',
    description: 'Start a new session in a worktree',
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
    id: 'open_timeline',
    defaultCombo: 'mod+t',
    label: 'Open timeline',
    description: 'Open the timeline dialog',
    customizable: true,
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
    defaultCombo: 'mod+shift+[',
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
    id: 'open_model_selector',
    defaultCombo: 'mod+shift+m',
    label: 'Open model selector',
    description: 'Open model selector while in chat',
  },
  {
    id: 'cycle_thinking_variant',
    defaultCombo: 'mod+shift+t',
    label: 'Cycle thinking variant',
    description: 'Cycle thinking variant while in chat',
  },
  {
    id: 'expand_input',
    defaultCombo: 'mod+shift+e',
    label: 'Expand input',
    description: 'Toggle focus mode for the chat input',
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
    label: 'Switch to tab 1',
    description: 'Switch to the first tab or project',
  },
  {
    id: 'switch_tab_2',
    defaultCombo: 'mod+2',
    label: 'Switch to tab 2',
    description: 'Switch to the second tab or project',
  },
  {
    id: 'switch_tab_3',
    defaultCombo: 'mod+3',
    label: 'Switch to tab 3',
    description: 'Switch to the third tab or project',
  },
  {
    id: 'switch_tab_4',
    defaultCombo: 'mod+4',
    label: 'Switch to tab 4',
    description: 'Switch to the fourth tab or project',
  },
  {
    id: 'switch_tab_5',
    defaultCombo: 'mod+5',
    label: 'Switch to tab 5',
    description: 'Switch to the fifth tab or project',
  },
  {
    id: 'switch_tab_6',
    defaultCombo: 'mod+6',
    label: 'Switch to tab 6',
    description: 'Switch to the sixth tab or project',
  },
  {
    id: 'switch_tab_7',
    defaultCombo: 'mod+7',
    label: 'Switch to tab 7',
    description: 'Switch to the seventh tab or project',
  },
  {
    id: 'switch_tab_8',
    defaultCombo: 'mod+8',
    label: 'Switch to tab 8',
    description: 'Switch to the eighth tab or project',
  },
  {
    id: 'switch_tab_9',
    defaultCombo: 'mod+9',
    label: 'Switch to tab 9',
    description: 'Switch to the ninth tab or project',
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

export function isValidShortcutCombo(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return true;
  }

  const parsed = parseShortcut(combo);
  return parsed.key.trim().length > 0;
}

export function parseShortcut(combo: ShortcutCombo): ParsedShortcut {
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

export function getAllShortcutActions(): ReadonlyArray<ShortcutAction> {
  return SHORTCUT_ACTIONS;
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

export function getEffectiveShortcutLabel(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>
): string {
  const combo = getEffectiveShortcutCombo(actionId, overrides);
  if (!combo) {
    return '';
  }
  return formatShortcutForDisplay(combo);
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
  const isDesktopMac = isMacOS() && isTauriShell();
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

  const eventKey = keyToShortcutToken(event.key);
  const expectedKey = keyToShortcutToken(parsed.key);

  return eventKey === expectedKey;
}

export function getShortcutLabel(id: string): string {
  const action = getShortcutAction(id);
  if (!action) return '';

  const displayCombo = formatShortcutForDisplay(action.defaultCombo);
  return `${displayCombo} - ${action.label}`;
}

export function getModifierLabel(): string {
  return isMacOS() && isTauriShell() ? '⌘' : 'Ctrl';
}
