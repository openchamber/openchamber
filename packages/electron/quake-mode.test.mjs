import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeQuakeBounds,
  DEFAULT_QUAKE_MODE_HEIGHT_FRACTION,
  DEFAULT_QUAKE_MODE_SHORTCUT_COMBO,
  parseQuakeHeightFraction,
  QUAKE_MODE_UNASSIGNED,
  readQuakeModeSettings,
  selectQuakeToggleAction,
} from './quake-mode.mjs';

test('default shortcut differs from Windows Terminal Quake keys', () => {
  assert.equal(DEFAULT_QUAKE_MODE_SHORTCUT_COMBO, 'ctrl+`');
  assert.notEqual(DEFAULT_QUAKE_MODE_SHORTCUT_COMBO, 'super+`');
  assert.notEqual(DEFAULT_QUAKE_MODE_SHORTCUT_COMBO, 'mod+`');
});

test('height fractions clamp into range with a fullscreen default', () => {
  assert.equal(DEFAULT_QUAKE_MODE_HEIGHT_FRACTION, 1);
  assert.equal(parseQuakeHeightFraction(0.45), 0.45);
  assert.equal(parseQuakeHeightFraction(0.1), 0.2);
  assert.equal(parseQuakeHeightFraction(1.5), 1);
  assert.equal(parseQuakeHeightFraction(undefined), DEFAULT_QUAKE_MODE_HEIGHT_FRACTION);
  assert.equal(parseQuakeHeightFraction('nope'), DEFAULT_QUAKE_MODE_HEIGHT_FRACTION);
  assert.equal(parseQuakeHeightFraction('0.5'), 0.5);
});

test('settings read falls back to the default combo only when enabled', () => {
  const enabled = readQuakeModeSettings({ desktopQuakeModeEnabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.combo, DEFAULT_QUAKE_MODE_SHORTCUT_COMBO);
  assert.equal(enabled.storedCombo, null);
  assert.equal(enabled.heightFraction, DEFAULT_QUAKE_MODE_HEIGHT_FRACTION);

  const disabled = readQuakeModeSettings({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.combo, null);

  const custom = readQuakeModeSettings({
    desktopQuakeModeEnabled: true,
    desktopQuakeModeShortcut: 'ctrl+shift+q',
    desktopQuakeModeHeightFraction: 0.6,
  });
  assert.equal(custom.combo, 'ctrl+shift+q');
  assert.equal(custom.storedCombo, 'ctrl+shift+q');
  assert.equal(custom.heightFraction, 0.6);
});

test('an unassigned shortcut never falls back to the default', () => {
  const unassigned = readQuakeModeSettings({
    desktopQuakeModeEnabled: true,
    desktopQuakeModeShortcut: QUAKE_MODE_UNASSIGNED,
  });
  assert.equal(unassigned.combo, null);
  assert.equal(unassigned.storedCombo, QUAKE_MODE_UNASSIGNED);

  const disabled = readQuakeModeSettings({ desktopQuakeModeShortcut: QUAKE_MODE_UNASSIGNED });
  assert.equal(disabled.combo, null);
});

test('quake bounds attach to the top and span the display width', () => {
  assert.deepEqual(
    computeQuakeBounds({ x: 1920, y: 0, width: 1920, height: 1080 }, 0.5),
    { x: 1920, y: 0, width: 1920, height: 540 },
  );
  const defaults = computeQuakeBounds({ x: 0, y: 0, width: 2560, height: 1440 });
  assert.equal(defaults.height, Math.round(1440 * DEFAULT_QUAKE_MODE_HEIGHT_FRACTION));
  assert.deepEqual(
    computeQuakeBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 99),
    computeQuakeBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 1),
  );
});

test('toggle hides only a visible, non-minimized, focused window', () => {
  const visible = { windowExists: true, isVisible: true, isMinimized: false };
  assert.equal(selectQuakeToggleAction({ ...visible, isFocused: true }), 'hide');
  // Visible but behind another app: the hotkey brings it forward.
  assert.equal(selectQuakeToggleAction({ ...visible, isFocused: false }), 'show');
  assert.equal(selectQuakeToggleAction({ ...visible, isMinimized: true, isFocused: true }), 'show');
  assert.equal(selectQuakeToggleAction({ ...visible, isMinimized: true, isFocused: false }), 'show');
  assert.equal(selectQuakeToggleAction({ ...visible, isVisible: false, isFocused: false }), 'show');
  assert.equal(selectQuakeToggleAction({ windowExists: false, isVisible: false, isMinimized: false, isFocused: false }), 'show');
});
