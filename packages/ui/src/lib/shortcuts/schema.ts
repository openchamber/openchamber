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
import { isMacOS } from '@/lib/utils';

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

export type ShortcutPlatform = 'macos' | 'other';
const currentPlatform = (): ShortcutPlatform => isMacOS() ? 'macos' : 'other';
const physicalCombo = (combo: ShortcutCombo, platform: ShortcutPlatform): ShortcutCombo =>
  platform === 'macos' ? normalizeCombo(combo)
    : normalizeCombo(combo.split(' ').map((chord) =>
      chord.split('+').map((part) => part === 'mod' ? 'ctrl' : part).join('+'),
    ).join(' '));

export function getPlatformShortcutConflict(
  left: ShortcutCombo, right: ShortcutCombo, platform: ShortcutPlatform = currentPlatform(),
): ShortcutConflict | undefined {
  return getShortcutConflict(physicalCombo(left, platform), physicalCombo(right, platform));
}

const explicitBinding = (actionId: string, overrides?: Record<string, ShortcutCombo>): string | undefined => {
  const value = overrides?.[actionId];
  if (value === undefined) return undefined;
  const normalized = normalizeCombo(value);
  if (normalized === UNASSIGNED_SHORTCUT) return '';
  return isValidShortcutCombo(normalized) ? normalized : undefined;
};
const defaultBinding = (action: ShortcutAction, platform: ShortcutPlatform): ShortcutCombo => {
  const binding = platform === 'other' && 'defaultBindingOther' in action
    ? action.defaultBindingOther : action.defaultBinding;
  return binding === UNASSIGNED_SHORTCUT ? '' : binding;
};

export function getShortcutDefaultConflict(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
  platform: ShortcutPlatform = currentPlatform(),
): CustomizableShortcutAction | undefined {
  const action = getShortcutAction(actionId);
  if (!action || !('preferExplicitOverrides' in action)
    || !action.preferExplicitOverrides || explicitBinding(actionId, overrides) !== undefined) return undefined;
  const proposed = defaultBinding(action, platform);
  return getCustomizableShortcutActions().find((other) => {
    if (other.id === actionId) return false;
    const binding = explicitBinding(other.id, overrides);
    return Boolean(binding && getPlatformShortcutConflict(proposed, binding, platform));
  });
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
  platform: ShortcutPlatform = currentPlatform(),
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  if (action.customizable) {
    const explicit = explicitBinding(actionId, overrides);
    if (explicit !== undefined) return explicit;
    if (getShortcutDefaultConflict(actionId, overrides, platform)) return '';
  }
  return defaultBinding(action, platform);
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
    const kind = getPlatformShortcutConflict(combo, candidateCombo);
    if (!kind) continue;
    conflicts.push({ action: candidate, kind });
  }
  return conflicts;
}
