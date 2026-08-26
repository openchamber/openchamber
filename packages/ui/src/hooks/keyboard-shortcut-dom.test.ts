import { expect, test } from 'bun:test';

import { hasOpenDropdown, shouldStopDropdownImeEscape } from './keyboard-shortcut-dom';

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

test('stops IME Escape before an open dropdown dismiss listener', () => {
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: true, keyCode: 0 }, true)).toBe(true);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: false, keyCode: 229 }, true)).toBe(true);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: false, keyCode: 27 }, true)).toBe(false);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: true, keyCode: 0 }, false)).toBe(false);
});
