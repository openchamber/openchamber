import { describe, expect, test } from 'bun:test';
import { settleShortcutRecordingState, updateShortcutRecordingState } from './ShortcutRecordingDialog';

const emptyState = { chords: [], livePreview: null, settled: false };

function keyEvent(key: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
  return { key, code, repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe('ShortcutRecordingDialog recording state', () => {
  test('previews modifiers and clears the preview when they are released', () => {
    const pressed = updateShortcutRecordingState(emptyState, keyEvent('Control', { ctrlKey: true, shiftKey: true }), 'keydown');
    expect(pressed.livePreview).toBe('mod+shift');
    expect(updateShortcutRecordingState(pressed, keyEvent('Control'), 'keyup').livePreview).toBeNull();
  });

  test('waits after the first chord and settles when a second chord is recorded', () => {
    const first = updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown');
    const second = updateShortcutRecordingState(first, keyEvent('p'), 'keydown');
    const third = updateShortcutRecordingState(second, keyEvent('x'), 'keydown');
    expect(first.chords).toEqual(['mod+s']);
    expect(first.settled).toBe(false);
    expect(second.chords).toEqual(['mod+s', 'p']);
    expect(second.settled).toBe(true);
    expect(third.chords).toEqual(['x']);
    expect(third.settled).toBe(false);
  });

  test('settles a single chord for timeout and Confirm validation', () => {
    const waiting = updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown');
    expect(settleShortcutRecordingState(waiting)).toEqual({ chords: ['mod+s'], livePreview: null, settled: true });
  });

  test('records at most three simultaneous keys', () => {
    const previous = { chords: ['mod+k'], livePreview: null, settled: false };
    const threeKeys = updateShortcutRecordingState(
      previous,
      keyEvent('s', { ctrlKey: true, shiftKey: true }),
      'keydown',
    );
    const fourKeys = updateShortcutRecordingState(
      previous,
      keyEvent('s', { ctrlKey: true, metaKey: true, shiftKey: true }),
      'keydown',
    );

    expect(threeKeys.chords).toEqual(['mod+k', 'mod+shift+s']);
    expect(fourKeys.chords).toEqual(['mod+k']);
  });

  test('ignores repeat and IME events', () => {
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), repeat: true }, 'keydown')).toEqual(emptyState);
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), isComposing: true }, 'keydown')).toEqual(emptyState);
  });

  test('records Enter and Escape while Backspace removes the final chord', () => {
    const state = { chords: ['mod+k', 'mod+p'], livePreview: null, settled: true };
    expect(updateShortcutRecordingState(emptyState, keyEvent('Enter'), 'keydown').chords).toEqual(['enter']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('Escape'), 'keydown').chords).toEqual(['escape']);
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown').chords).toEqual(['mod+k']);
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown').settled).toBe(false);
    expect(updateShortcutRecordingState({ chords: ['mod+k'], livePreview: null, settled: false }, keyEvent('Backspace'), 'keydown')).toEqual(emptyState);
  });

  test('maxChords=1 settles on the first chord', () => {
    const first = updateShortcutRecordingState(emptyState, keyEvent('m', { altKey: true }), 'keydown', 1);
    expect(first.chords).toEqual(['alt+m']);
    expect(first.settled).toBe(true);
  });

  test('maxChords=1 replaces an already-settled chord in one press', () => {
    const settled = { chords: ['alt+m'], livePreview: null, settled: true };
    const next = updateShortcutRecordingState(settled, keyEvent('k', { ctrlKey: true }), 'keydown', 1);
    expect(next).toEqual({ chords: ['mod+k'], livePreview: null, settled: true });
  });

  test('on macOS records Control and Command as separate modifiers', () => {
    const mac = { macModifiers: true };
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { ctrlKey: true }), 'keydown', 1, mac).chords).toEqual(['ctrl+n']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { metaKey: true }), 'keydown', 1, mac).chords).toEqual(['mod+n']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { ctrlKey: true, metaKey: true }), 'keydown', 1, mac).chords).toEqual(['mod+ctrl+n']);
    // Elsewhere Control is the primary modifier and Meta is the Super key.
    const other = { macModifiers: false, maxKeys: 5 };
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { ctrlKey: true }), 'keydown', 1, other).chords).toEqual(['mod+n']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { metaKey: true }), 'keydown', 1, other).chords).toEqual(['super+n']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('n', { ctrlKey: true, metaKey: true, shiftKey: true }), 'keydown', 1, other).chords).toEqual(['mod+super+shift+n']);
  });

  test('with maxKeys=5 records three modifiers and the hyper combination', () => {
    const global = { macModifiers: true, maxKeys: 5 };
    expect(updateShortcutRecordingState(
      emptyState, keyEvent('n', { shiftKey: true, altKey: true, metaKey: true }), 'keydown', 1, global,
    ).chords).toEqual(['mod+shift+alt+n']);
    expect(updateShortcutRecordingState(
      emptyState, keyEvent('n', { ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }), 'keydown', 1, global,
    ).chords).toEqual(['mod+ctrl+shift+alt+n']);
    // In-app shortcuts keep their three-key limit.
    expect(updateShortcutRecordingState(
      emptyState, keyEvent('n', { shiftKey: true, altKey: true, metaKey: true }), 'keydown', 1, { macModifiers: true },
    ).chords).toEqual([]);
  });
});
