import { expect, test } from 'bun:test';

import { hasOpenDropdown, isTypingInEditableTarget } from './keyboard-shortcut-dom';

test('does not treat an unrelated visible listbox as an open dropdown', () => {
  const promptNavigator = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[role="listbox"]') ? promptNavigator : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(false);
});

test('detects an open dropdown popup', () => {
  const dropdown = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[data-slot="dropdown-menu-content"][data-open]') ? dropdown : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(true);
});

test('detects an open select popup', () => {
  const select = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[data-slot="select-content"][data-open]') ? select : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(true);
});

// isTypingInEditableTarget — the mod+digit surface switcher guard (issue
// #2503): while the user is typing in an editable target, ctrl/cmd+digit
// must keep its normal meaning (browser tab switching, in-input chords)
// instead of switching the context panel surface.
const targetWithClosest = (result: Element | null): EventTarget =>
  ({ closest: (selector: string) => (selector === 'input, textarea, [contenteditable="true"]' ? result : null) }) as unknown as EventTarget;

test('editable guard is false for a null target', () => {
  expect(isTypingInEditableTarget(null)).toBe(false);
});

test('editable guard is false for a target without closest', () => {
  expect(isTypingInEditableTarget({} as EventTarget)).toBe(false);
});

test('editable guard is true inside an input, textarea or contenteditable', () => {
  const editable = {} as Element;
  expect(isTypingInEditableTarget(targetWithClosest(editable))).toBe(true);
});

test('editable guard is false outside editable surfaces', () => {
  expect(isTypingInEditableTarget(targetWithClosest(null))).toBe(false);
});
