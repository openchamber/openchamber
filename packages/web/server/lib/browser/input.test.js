import { describe, it, expect } from 'bun:test';
import { keyEventsForCombo, parseKeyCombo } from './input.js';

describe('parseKeyCombo', () => {
  it('parses named keys', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 });
    expect(parseKeyCombo('Tab')).toMatchObject({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(parseKeyCombo('ArrowLeft')).toMatchObject({ key: 'ArrowLeft', keyCode: 37 });
  });

  it('parses single characters as text-producing keys', () => {
    expect(parseKeyCombo('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    expect(parseKeyCombo('5')).toMatchObject({ key: '5', code: 'Digit5', text: '5' });
  });

  it('suppresses text for shortcut modifiers', () => {
    const combo = parseKeyCombo('Control+A');
    expect(combo.modifiers).toBe(2);
    expect(combo.text).toBeUndefined();
    expect(combo.key).toBe('A');
  });

  it('keeps text for shift-only combos', () => {
    const combo = parseKeyCombo('Shift+a');
    expect(combo.modifiers).toBe(8);
    expect(combo.text).toBe('a');
  });

  it('rejects empty, unknown, or multi-key combos', () => {
    expect(parseKeyCombo('')).toBeNull();
    expect(parseKeyCombo('NotAKey')).toBeNull();
    expect(parseKeyCombo('a+b')).toBeNull();
  });
});

describe('keyEventsForCombo', () => {
  it('emits keyDown then keyUp for text keys', () => {
    const events = keyEventsForCombo(parseKeyCombo('Enter'));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'keyDown', text: '\r' });
    expect(events[1]).toMatchObject({ type: 'keyUp' });
  });

  it('emits rawKeyDown for shortcut keys without text', () => {
    const events = keyEventsForCombo(parseKeyCombo('Control+A'));
    expect(events[0].type).toBe('rawKeyDown');
    expect(events[0].text).toBeUndefined();
  });
});
