
import { normalizeStoredShortcutCombo } from './mini-chat-global-shortcut.mjs';

export const QUAKE_MODE_ENABLED_KEY = 'desktopQuakeModeEnabled';
export const QUAKE_MODE_SHORTCUT_KEY = 'desktopQuakeModeShortcut';
export const QUAKE_MODE_HEIGHT_KEY = 'desktopQuakeModeHeightFraction';

export const QUAKE_MODE_UNASSIGNED = '__unassigned__';

export const DEFAULT_QUAKE_MODE_SHORTCUT_COMBO = 'ctrl+`';
export const DEFAULT_QUAKE_MODE_HEIGHT_FRACTION = 1;
const MIN_QUAKE_MODE_HEIGHT_FRACTION = 0.2;
const MAX_QUAKE_MODE_HEIGHT_FRACTION = 1;

export function parseQuakeHeightFraction(value) {
  const fraction = Number.parseFloat(String(value));
  if (!Number.isFinite(fraction)) return DEFAULT_QUAKE_MODE_HEIGHT_FRACTION;
  if (fraction < MIN_QUAKE_MODE_HEIGHT_FRACTION) return MIN_QUAKE_MODE_HEIGHT_FRACTION;
  if (fraction > MAX_QUAKE_MODE_HEIGHT_FRACTION) return MAX_QUAKE_MODE_HEIGHT_FRACTION;
  return Math.round(fraction * 100) / 100;
}

export function readQuakeModeSettings(root) {
  const settings = root ?? {};
  const enabled = settings[QUAKE_MODE_ENABLED_KEY] === true;
  const raw = settings[QUAKE_MODE_SHORTCUT_KEY];
  const unassigned = raw === QUAKE_MODE_UNASSIGNED;
  const storedCombo = unassigned ? QUAKE_MODE_UNASSIGNED : normalizeStoredShortcutCombo(raw);
  return {
    enabled,
    storedCombo,
    combo: unassigned ? null : storedCombo ?? (enabled ? DEFAULT_QUAKE_MODE_SHORTCUT_COMBO : null),
    heightFraction: parseQuakeHeightFraction(settings[QUAKE_MODE_HEIGHT_KEY]),
  };
}

export function computeQuakeBounds(displayBounds, heightFraction = DEFAULT_QUAKE_MODE_HEIGHT_FRACTION) {
  const bounds = displayBounds ?? {};
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;
  const width = Math.max(1, Math.round(Number(bounds.width) || 0));
  const height = Math.max(
    1,
    Math.round((Number(bounds.height) || 0) * parseQuakeHeightFraction(heightFraction)),
  );
  return { x, y, width, height };
}

export function selectQuakeToggleAction({ windowExists, isVisible, isMinimized, isFocused }) {
  if (windowExists === true && isVisible === true && isMinimized !== true && isFocused === true) return 'hide';
  return 'show';
}
