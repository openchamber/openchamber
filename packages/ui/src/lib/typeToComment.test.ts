import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  KeyboardEvent: browser.KeyboardEvent,
});

const { getTypeToCommentText } = await import('./typeToComment');

const keystrokeOn = (target: EventTarget, init: KeyboardEventInit): string | null => {
  let result: string | null = 'not dispatched';
  const listener = (event: KeyboardEvent) => {
    result = getTypeToCommentText(event);
  };
  document.addEventListener('keydown', listener);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  document.removeEventListener('keydown', listener);
  return result;
};

describe('getTypeToCommentText', () => {
  test('a typed character starts the comment, in any layout and case', () => {
    expect(keystrokeOn(document.body, { key: 'a' })).toBe('a');
    expect(keystrokeOn(document.body, { key: 'Ж', shiftKey: true })).toBe('Ж');
    expect(keystrokeOn(document.body, { key: '?' })).toBe('?');
    expect(keystrokeOn(document.body, { key: '👍' })).toBe('👍');
  });

  test('shortcuts, named keys and whitespace are left alone', () => {
    expect(keystrokeOn(document.body, { key: 'c', metaKey: true })).toBeNull();
    expect(keystrokeOn(document.body, { key: 'c', ctrlKey: true })).toBeNull();
    expect(keystrokeOn(document.body, { key: 'c', altKey: true })).toBeNull();
    expect(keystrokeOn(document.body, { key: 'Enter' })).toBeNull();
    expect(keystrokeOn(document.body, { key: 'ArrowDown' })).toBeNull();
    expect(keystrokeOn(document.body, { key: 'Dead' })).toBeNull();
    expect(keystrokeOn(document.body, { key: ' ' })).toBeNull();
  });

  test('IME composition is left alone', () => {
    expect(keystrokeOn(document.body, { key: 'a', isComposing: true })).toBeNull();
  });

  test('typing into an editable field is left alone', () => {
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    const nested = document.createElement('span');
    editable.appendChild(nested);
    document.body.append(textarea, editable);

    expect(keystrokeOn(textarea, { key: 'a' })).toBeNull();
    expect(keystrokeOn(nested, { key: 'a' })).toBeNull();
  });
});
