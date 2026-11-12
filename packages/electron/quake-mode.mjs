// Pure helpers for Windows Terminal-style Quake Mode.
//
// main.mjs wires these to Electron's globalShortcut + BrowserWindow APIs; the
// electron tests exercise the logic without an Electron runtime.
//
// Quake Mode keeps the single main window alive in the background and toggles
// it between hidden and a top-attached dropdown via one global hotkey. There
// is no second window and the renderer is never reloaded: showing an existing
// window must not navigate it.
//
// The default hotkey is deliberately NOT Windows Terminal's Win+` — it is
// Ctrl+` (no Win/Super modifier), so the two can coexist.

import { normalizeStoredShortcutCombo } from './mini-chat-global-shortcut.mjs';

export const QUAKE_MODE_ENABLED_KEY = 'desktopQuakeModeEnabled';
export const QUAKE_MODE_SHORTCUT_KEY = 'desktopQuakeModeShortcut';
export const QUAKE_MODE_HEIGHT_KEY = 'desktopQuakeModeHeightFraction';

// Stored when the user gives the Quake combo to another shortcut. Unlike an
// absent value it never falls back to the default, so the released combo
// stays free for whatever took it.
export const QUAKE_MODE_UNASSIGNED = '__unassigned__';

// Deliberately different from Windows Terminal's Win+` so the two can coexist.
export const DEFAULT_QUAKE_MODE_SHORTCUT_COMBO = 'ctrl+`';
export const DEFAULT_QUAKE_MODE_HEIGHT_FRACTION = 1;
const MIN_QUAKE_MODE_HEIGHT_FRACTION = 0.2;
const MAX_QUAKE_MODE_HEIGHT_FRACTION = 1;

// Clamps any stored value into the supported height range; unknown values fall
// back to the default instead of breaking the window geometry.
export function parseQuakeHeightFraction(value) {
  // Stored as a number, or a numeric string from a hand edit.
  const fraction = Number.parseFloat(String(value));
  if (!Number.isFinite(fraction)) return DEFAULT_QUAKE_MODE_HEIGHT_FRACTION;
  if (fraction < MIN_QUAKE_MODE_HEIGHT_FRACTION) return MIN_QUAKE_MODE_HEIGHT_FRACTION;
  if (fraction > MAX_QUAKE_MODE_HEIGHT_FRACTION) return MAX_QUAKE_MODE_HEIGHT_FRACTION;
  return Math.round(fraction * 100) / 100;
}

// Reads the Quake settings out of a settings.json root object. When Quake is
// enabled but no custom shortcut was stored, the default combo applies so a
// fresh opt-in works without an extra configuration step. An explicitly
// unassigned shortcut stays unassigned: `storedCombo` carries the sentinel so
// the settings row can offer Reset, and `combo` is null.
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

// Quake geometry for one display: attached to the top, full display width,
// `heightFraction` of the display height. Takes plain bounds ({ x, y, width,
// height }) so it stays testable without Electron's screen module.
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

// Toggle decision for the global hotkey: a visible, non-minimized window that
// has focus hides; anything else (hidden, minimized, behind another app, or no
// window) shows and focuses the Quake window. Pure so the matrix is
// unit-testable.
export function selectQuakeToggleAction({ windowExists, isVisible, isMinimized, isFocused }) {
  if (windowExists === true && isVisible === true && isMinimized !== true && isFocused === true) return 'hide';
  return 'show';
}
