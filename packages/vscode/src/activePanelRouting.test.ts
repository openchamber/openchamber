import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActivePanelId } from './activePanelRouting';

describe('pickActivePanelId', () => {
  test('returns null when there are no panels and no recent panel', () => {
    assert.equal(pickActivePanelId([], null), null);
  });

  test('falls back to the last active panel when none is currently focused', () => {
    // A chat panel exists but the user is focused elsewhere (e.g. the code editor).
    const panels = [{ id: 'ses_a', active: false }];
    assert.equal(pickActivePanelId(panels, 'ses_a'), 'ses_a');
  });

  test('prefers the currently focused panel over the last active one', () => {
    const panels = [
      { id: 'ses_a', active: false },
      { id: 'ses_b', active: true },
    ];
    assert.equal(pickActivePanelId(panels, 'ses_a'), 'ses_b');
  });

  test('uses the focused panel even when there is no recorded last active panel', () => {
    assert.equal(pickActivePanelId([{ id: 'ses_b', active: true }], null), 'ses_b');
  });

  test('returns the last active panel when no panel is focused', () => {
    const panels = [
      { id: 'ses_a', active: false },
      { id: 'ses_b', active: false },
    ];
    assert.equal(pickActivePanelId(panels, 'ses_b'), 'ses_b');
  });

  test('returns null when nothing is focused and there is no recent panel', () => {
    assert.equal(pickActivePanelId([{ id: 'ses_a', active: false }], null), null);
  });
});
