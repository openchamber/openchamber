import { expect, test } from 'bun:test';
import {
  getDropdownNavigationKey,
  handleDropdownNavigationKey,
  shouldDismissDropdown,
} from './dropdown-navigation';

type KeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;
type CompositionState = Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode'>>;

function keyEvent(key: string, modifiers: Partial<Omit<KeyEvent, 'key'>> = {}): KeyEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

function dropdownEvent(key: string, compositionState: CompositionState = {}) {
  const calls = {
    navigation: [] as Array<'ArrowDown' | 'ArrowUp'>,
    preventDefault: 0,
    stopPropagation: 0,
  };
  const event = {
    ...keyEvent(key, { ctrlKey: true }),
    defaultPrevented: false,
    isPropagationStopped: () => false,
    nativeEvent: compositionState,
    preventDefault: () => { calls.preventDefault += 1; },
    stopPropagation: () => { calls.stopPropagation += 1; },
  } as unknown as Parameters<typeof handleDropdownNavigationKey>[0];

  return { calls, event };
}

function reactKeyEvent(key: string, compositionState: CompositionState = {}) {
  return {
    key,
    nativeEvent: {
      isComposing: false,
      keyCode: 0,
      ...compositionState,
    },
  } as unknown as Parameters<typeof shouldDismissDropdown>[0];
}

test('maps only exact Ctrl+N and Ctrl+P to menu navigation keys', () => {
  expect(getDropdownNavigationKey(keyEvent('n', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true }))).toBe('ArrowUp');
  expect(getDropdownNavigationKey(keyEvent('N', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownNavigationKey(keyEvent('n'))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('n', { ctrlKey: true, shiftKey: true }))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true, altKey: true }))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true, metaKey: true }))).toBe(null);
});

test('handles exact Ctrl+N and Ctrl+P during IME composition', () => {
  const navigationCases = [
    ['n', 'ArrowDown'],
    ['p', 'ArrowUp'],
  ] as const;

  for (const [key, navigationKey] of navigationCases) {
    for (const compositionState of [{ isComposing: true }, { keyCode: 229 }]) {
      const { calls, event } = dropdownEvent(key, compositionState);

      expect(handleDropdownNavigationKey(event, (nextKey) => calls.navigation.push(nextKey))).toBe(true);
      expect(calls).toEqual({
        navigation: [navigationKey],
        preventDefault: 1,
        stopPropagation: 1,
      });
    }
  }
});

test('leaves other IME input untouched', () => {
  for (const compositionState of [{ isComposing: true }, { keyCode: 229 }]) {
    const { calls, event } = dropdownEvent('x', compositionState);

    expect(handleDropdownNavigationKey(event, (key) => calls.navigation.push(key))).toBe(false);
    expect(calls).toEqual({
      navigation: [],
      preventDefault: 0,
      stopPropagation: 0,
    });
  }
});

test('dismisses on Escape only outside IME composition', () => {
  expect(shouldDismissDropdown(reactKeyEvent('Escape'))).toBe(true);
  expect(shouldDismissDropdown(reactKeyEvent('Escape', { isComposing: true }))).toBe(false);
  expect(shouldDismissDropdown(reactKeyEvent('Escape', { keyCode: 229 }))).toBe(false);
  expect(shouldDismissDropdown(reactKeyEvent('Enter'))).toBe(false);
});
