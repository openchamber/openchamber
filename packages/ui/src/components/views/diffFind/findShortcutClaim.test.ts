import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { isForeignEditableFocus } from './findShortcutClaim';

// The predicate narrows with the global `HTMLElement`, so the happy-dom classes
// must be the globals too — otherwise `instanceof` never matches at runtime.
// Using the globals for element creation keeps the lib.dom types as well.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
});

const root = document.createElement('div');
const inside = document.createElement('input');
root.appendChild(inside);
document.body.appendChild(root);

test('an editable control outside the root owns the shortcut', () => {
  expect(isForeignEditableFocus(document.createElement('input'), root)).toBe(true);
  expect(isForeignEditableFocus(document.createElement('textarea'), root)).toBe(true);
});

test('a contenteditable element outside the root owns the shortcut', () => {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  expect(isForeignEditableFocus(editor, root)).toBe(true);
});

test('an editable control inside the root belongs to this surface', () => {
  expect(isForeignEditableFocus(inside, root)).toBe(false);
});

test('a non-editable focus outside the root does not own the shortcut', () => {
  expect(isForeignEditableFocus(document.createElement('button'), root)).toBe(false);
});

test('no focus, or focus on the body, leaves the shortcut to this surface', () => {
  expect(isForeignEditableFocus(null, root)).toBe(false);
  expect(isForeignEditableFocus(document.body, root)).toBe(false);
});

test('without a root, any editable focus counts as foreign', () => {
  expect(isForeignEditableFocus(document.createElement('input'), null)).toBe(true);
});
