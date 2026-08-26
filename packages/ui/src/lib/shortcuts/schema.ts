import {
  getShortcutConflict,
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
export type ShortcutBindingConflictKind = ShortcutConflict | 'contextual-prefix';
export type ShortcutBindingConflict = {
  action: ShortcutAction;
  kind: ShortcutBindingConflictKind;
};

function allowsContextualPrefix(
  action: ShortcutAction,
  combo: ShortcutCombo,
  candidate: ShortcutAction,
  candidateCombo: ShortcutCombo,
): boolean {
  const chordCount = parseShortcut(combo)?.chords.length;
  const candidateChordCount = parseShortcut(candidateCombo)?.chords.length;
  if (chordCount === 1 && candidateChordCount === 2) {
    return 'allowsSequenceFallback' in action && action.allowsSequenceFallback;
  }
  if (chordCount === 2 && candidateChordCount === 1) {
    return 'allowsSequenceFallback' in candidate && candidate.allowsSequenceFallback;
  }
  return false;
}

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_SCHEMA.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<CustomizableShortcutAction> {
  return SHORTCUT_SCHEMA.filter(
    (action): action is CustomizableShortcutAction => action.customizable,
  );
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  if (!action.customizable) return action.defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return '';
    if (isValidShortcutCombo(normalized)) return normalized;
  }

  return action.defaultBinding;
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

export function getShortcutBindingConflicts(
  actionId: ShortcutActionId,
  combo: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutBindingConflict[] {
  const conflicts: ShortcutBindingConflict[] = [];
  const action = getShortcutAction(actionId);
  if (!action) return conflicts;
  for (const candidate of SHORTCUT_SCHEMA) {
    if (candidate.id === actionId) continue;
    const candidateCombo = ('prefixStyle' in candidate && candidate.prefixStyle)
      ? getEffectiveShortcutPrefix(candidate.id, overrides)
      : getEffectiveShortcutCombo(candidate.id, overrides);
    const kind = getShortcutConflict(combo, candidateCombo);
    if (!kind) continue;
    conflicts.push({
      action: candidate,
      kind: kind === 'prefix' && allowsContextualPrefix(action, combo, candidate, candidateCombo)
        ? 'contextual-prefix'
        : kind,
    });
  }
  return conflicts;
}
