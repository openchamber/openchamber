import type React from 'react';
import { isDesktopShell } from '@/lib/desktop';
import { isMacOS } from '@/lib/utils';

type ShortcutModifier = 'mod' | 'shift' | 'alt' | 'ctrl';
type ShortcutDisplayPlatform = 'macos' | 'other';
type ShortcutKey = string;

export type ShortcutCombo = string;
export type ShortcutConflict = 'exact' | 'prefix';

export const UNASSIGNED_SHORTCUT: ShortcutCombo = '__unassigned__';

interface ParsedShortcutChord {
  modifiers: Set<ShortcutModifier>;
  key: ShortcutKey;
}

export interface ParsedShortcut {
  chords: ReadonlyArray<ParsedShortcutChord>;
}

const MODIFIER_KEY_MAP: Record<string, ShortcutModifier> = {
  mod: 'mod',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  ctrl: 'ctrl',
  meta: 'mod',
  cmd: 'mod',
  command: 'mod',
};

const MODIFIER_LABELS: Record<ShortcutDisplayPlatform, Record<ShortcutModifier, string>> = {
  macos: {
    mod: '⌘',
    shift: '⇧',
    alt: '⌥',
    ctrl: '⌃',
  },
  other: {
    mod: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt',
    ctrl: 'Ctrl',
  },
};

const KEY_LABEL_MAP: Record<string, string> = {
  comma: ',',
  period: '.',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: '⌫',
  delete: '⌦',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
};

const MODIFIER_PRIORITY: ShortcutModifier[] = ['mod', 'ctrl', 'shift', 'alt'];
const RISKY_BROWSER_SHORTCUT_KEYS = new Set(['w', 't', 'r', 'p', 's', 'f', 'l', 'n', 'q', 'd', 'h', 'j', 'o', 'u']);
const MODIFIER_KEY_ALIASES: Record<ShortcutModifier, readonly string[]> = {
  mod: isMacOS() && isDesktopShell() ? ['meta'] : isMacOS() ? ['meta', 'control'] : ['control'],
  shift: ['shift'],
  alt: ['alt'],
  ctrl: ['control'],
};

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

export function normalizeCombo(combo: ShortcutCombo): ShortcutCombo {
  if (isUnassignedShortcut(combo)) return UNASSIGNED_SHORTCUT;

  const chords = combo
    .trim()
    .replace(/\s*\+\s*/g, '+')
    .split(/\s+/)
    .filter(Boolean);
  if (chords.length === 0 || chords.length > 2) return '';

  return chords.map(normalizeChord).join(' ');
}

function normalizeChord(combo: ShortcutCombo): ShortcutCombo {
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
    } else {
      key = part;
    }
  }

  const orderedModifiers = MODIFIER_PRIORITY.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].filter(Boolean).join('+');
}

export function isValidShortcutCombo(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) return true;
  const parsed = parseShortcut(combo);
  return parsed !== undefined && parsed.chords.every((chord) => chord.key.trim().length > 0);
}

export function parseShortcut(combo: ShortcutCombo): ParsedShortcut | undefined {
  if (isUnassignedShortcut(combo)) {
    return { chords: [{ modifiers: new Set<ShortcutModifier>(), key: UNASSIGNED_SHORTCUT }] };
  }

  const normalized = normalizeCombo(combo);
  if (!normalized) return undefined;

  return {
    chords: normalized.split(' ').map((chord) => {
      const modifiers = new Set<ShortcutModifier>();
      let key: ShortcutKey = '';
      for (const part of chord.split('+')) {
        const modifier = MODIFIER_KEY_MAP[part];
        if (modifier) {
          modifiers.add(modifier);
        } else {
          key = part;
        }
      }
      return { modifiers, key };
    }),
  };
}

function getShortcutDisplayPlatform(): ShortcutDisplayPlatform {
  return isMacOS() ? 'macos' : 'other';
}

export function formatShortcutForDisplay(
  combo: ShortcutCombo,
  unassignedLabel = 'Unassigned',
  platform = getShortcutDisplayPlatform(),
): string {
  if (isUnassignedShortcut(combo)) return unassignedLabel;
  const parsed = parseShortcut(combo);
  if (!parsed || parsed.chords.some((chord) => !chord.key && chord.modifiers.size === 0)) {
    return unassignedLabel;
  }
  return parsed.chords.map((chord) => formatChordForDisplay(chord, platform)).join(', ');
}

function formatChordForDisplay(
  parsed: ParsedShortcutChord,
  platform: ShortcutDisplayPlatform,
): string {
  const modifierLabels = MODIFIER_LABELS[platform];
  const parts = MODIFIER_PRIORITY
    .filter((modifier) => parsed.modifiers.has(modifier))
    .map((modifier) => modifierLabels[modifier]);
  if (parsed.key) {
    parts.push(KEY_LABEL_MAP[parsed.key.toLowerCase()] || parsed.key.toUpperCase());
  }
  return parts.join(' + ');
}

export function getShortcutConflict(left: ShortcutCombo, right: ShortcutCombo): ShortcutConflict | undefined {
  const normalizedLeft = normalizeCombo(left);
  const normalizedRight = normalizeCombo(right);
  const hasInvalidBinding = !isValidShortcutCombo(normalizedLeft) || !isValidShortcutCombo(normalizedRight);
  const hasUnassignedBinding = normalizedLeft === UNASSIGNED_SHORTCUT
    || normalizedRight === UNASSIGNED_SHORTCUT;
  if (hasInvalidBinding || hasUnassignedBinding) return undefined;
  if (normalizedLeft === normalizedRight) return 'exact';

  const leftChords = normalizedLeft.split(' ');
  const rightChords = normalizedRight.split(' ');
  const sharesLeader = leftChords[0] === rightChords[0];
  return sharesLeader && leftChords.length !== rightChords.length ? 'prefix' : undefined;
}

export function isRiskyBrowserShortcut(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) return false;
  const parsed = parseShortcut(combo);
  if (!parsed) return false;
  // Every chord counts: a second chord like "mod+w" is just as capable of
  // closing the tab as a first one, and mod+shift+w closes a window.
  return parsed.chords.some((chord) => {
    if (!chord.modifiers.has('mod')) return false;
    if (chord.modifiers.has('alt')) return false;
    if (chord.modifiers.has('shift')) {
      return chord.key.toLowerCase() === 'w' || chord.key.toLowerCase() === 'q';
    }
    return RISKY_BROWSER_SHORTCUT_KEYS.has(chord.key.toLowerCase());
  });
}

export function eventMatchesShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  combo: ShortcutCombo,
): boolean {
  if (isUnassignedShortcut(combo)) return false;
  const parsed = parseShortcut(combo);
  if (!parsed || parsed.chords.length !== 1) return false;
  const chord = parsed.chords[0];

  const expectedMod = chord.modifiers.has('mod');
  const expectedShift = chord.modifiers.has('shift');
  const expectedAlt = chord.modifiers.has('alt');
  const expectedCtrl = chord.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();
  let modMatches = event.ctrlKey;
  if (isDesktopMac) {
    modMatches = event.metaKey;
  } else if (isMac) {
    modMatches = event.metaKey || event.ctrlKey;
  }

  if (expectedMod && !modMatches) return false;
  if (!expectedMod && event.metaKey) return false;
  if (expectedShift !== event.shiftKey) return false;
  if (expectedAlt !== event.altKey) return false;
  if (expectedCtrl) {
    if (!event.ctrlKey) return false;
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) return false;
  }

  let eventKeyRaw = event.key;
  if (event.altKey) {
    if (event.code.startsWith('Key') && event.code.length === 4) {
      eventKeyRaw = event.code.slice(3).toLowerCase();
    } else if (event.code.startsWith('Digit') && event.code.length === 6) {
      eventKeyRaw = event.code.slice(5);
    }
  }

  return keyToShortcutToken(eventKeyRaw) === keyToShortcutToken(chord.key);
}

export function isShortcutPrefixHeld(prefixCombo: ShortcutCombo, heldKeys: ReadonlySet<string>): boolean {
  if (isUnassignedShortcut(prefixCombo)) return false;
  const parsed = parseShortcut(prefixCombo);
  if (!parsed || parsed.chords.length !== 1) return false;
  const chord = parsed.chords[0];

  for (const modifier of chord.modifiers) {
    if (!MODIFIER_KEY_ALIASES[modifier].some((alias) => heldKeys.has(alias))) return false;
  }
  return !chord.key || heldKeys.has(chord.key.toLowerCase());
}

export function eventMatchesShortcutPrefix(
  event: KeyboardEvent | React.KeyboardEvent,
  prefixCombo: ShortcutCombo,
  heldKeys?: ReadonlySet<string>,
): boolean {
  if (isUnassignedShortcut(prefixCombo)) return false;
  const parsed = parseShortcut(prefixCombo);
  if (!parsed || parsed.chords.length !== 1) return false;
  const chord = parsed.chords[0];
  const expectedMod = chord.modifiers.has('mod');
  const expectedShift = chord.modifiers.has('shift');
  const expectedAlt = chord.modifiers.has('alt');
  const expectedCtrl = chord.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();
  const modMatches = isDesktopMac ? event.metaKey : isMac ? event.metaKey || event.ctrlKey : event.ctrlKey;

  if (expectedMod && !modMatches) return false;
  if (!expectedMod && event.metaKey) return false;
  if (expectedShift !== event.shiftKey || expectedAlt !== event.altKey) return false;
  if (expectedCtrl) {
    if (!event.ctrlKey) return false;
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) return false;
  }

  return !chord.key || Boolean(heldKeys?.has(chord.key.toLowerCase()));
}
