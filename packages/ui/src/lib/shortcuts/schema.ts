import { isDesktopShell } from '@/lib/desktop';
import { isMacOS } from '@/lib/utils';
import {
  getShortcutConflict,
  heldSequenceChord,
  isValidShortcutCombo,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
  type ShortcutConflict,
} from './bindings';
import { SHORTCUT_SCHEMA } from './config';

export { SHORTCUT_SCHEMA } from './config';

export type ShortcutAction = (typeof SHORTCUT_SCHEMA)[number];
export type ShortcutActionId = ShortcutAction['id'];
export type ShortcutCategory = ShortcutAction['category'];
export type CustomizableShortcutAction = Extract<ShortcutAction, { customizable: true }>;
/** 'contextual-prefix' is kept in the union for the recording dialog's
    messaging even though no default layout produces it any more. */
export type ShortcutBindingConflictKind = ShortcutConflict | 'contextual-prefix';
export type ShortcutBindingConflict = {
  action: ShortcutAction;
  kind: ShortcutBindingConflictKind;
};

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_SCHEMA.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<CustomizableShortcutAction> {
  return SHORTCUT_SCHEMA.filter(
    (action): action is CustomizableShortcutAction => action.customizable,
  );
}

/** False for a native menu key on a runtime without that menu item. */
export function isShortcutAvailable(action: ShortcutAction): boolean {
  if (!('nativeMenu' in action)) return true;
  return isDesktopShell() && (action.nativeMenu === 'all' || !isMacOS());
}

export function isSingleChordShortcut(action: ShortcutAction): boolean {
  return 'singleChord' in action || 'nativeMenu' in action;
}

/** What the desktop app menu shows and listens to; empty means unassigned. */
export function getNativeMenuShortcutCombos(
  overrides?: Record<string, ShortcutCombo>,
): Record<string, ShortcutCombo> {
  return Object.fromEntries(SHORTCUT_SCHEMA
    .filter((action) => 'nativeMenu' in action)
    .map((action) => [action.id, getEffectiveShortcutCombo(action.id, overrides)]));
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  const defaultBinding = action.defaultBinding === UNASSIGNED_SHORTCUT ? '' : action.defaultBinding;
  if (!action.customizable) return defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return '';
    if (isValidShortcutCombo(normalized)) return normalized;
  }

  return defaultBinding;
}

export function getEffectiveShortcutPrefix(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  if (!action.customizable) return action.defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string' && override.trim() !== '') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return UNASSIGNED_SHORTCUT;
    const chord = parseShortcut(normalized)?.chords[0];
    if (chord && (chord.modifiers.size > 0 || chord.key)) return normalized;
  }

  return action.defaultBinding;
}

/** What an action is bound to: a prefix-style action's bare prefix, otherwise its combo. */
export function getEffectiveShortcutBinding(
  action: ShortcutAction,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  return 'prefixStyle' in action && action.prefixStyle
    ? getEffectiveShortcutPrefix(action.id, overrides)
    : getEffectiveShortcutCombo(action.id, overrides);
}

/**
 * Whether the recorded normalized combo fires this action. A sequence also
 * answers to its second key with the leader's modifiers held, as in dispatch.
 * A digit prefix has no chord of its own, so its action answers to the prefix
 * plus a digit it accepts: session tabs start at 1, and context surfaces take
 * 0 as the tenth.
 */
export function shortcutMatchesRecordedCombo(
  action: ShortcutAction,
  recorded: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): boolean {
  const binding = normalizeCombo(getEffectiveShortcutBinding(action, overrides));
  if (binding === recorded) return true;
  const [leader, secondChord] = binding.split(' ');
  if (secondChord) return recorded === `${leader} ${heldSequenceChord(leader, secondChord)}`;
  if (!('prefixStyle' in action && action.prefixStyle)) return false;
  const digitChord = /^(.+)\+(\d)$/.exec(recorded);
  if (digitChord?.[1] !== binding) return false;
  return action.id !== 'switch_session_tab' || digitChord[2] !== '0';
}

export function getShortcutBindingConflicts(
  actionId: ShortcutActionId,
  combo: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutBindingConflict[] {
  const conflicts: ShortcutBindingConflict[] = [];
  const action = getShortcutAction(actionId);
  if (!action) return conflicts;
  for (const candidate of SHORTCUT_SCHEMA) {
    if (candidate.id === actionId || !isShortcutAvailable(candidate)) continue;
    const kind = getShortcutConflict(combo, getEffectiveShortcutBinding(candidate, overrides));
    if (!kind) continue;
    conflicts.push({ action: candidate, kind });
  }
  return conflicts;
}
