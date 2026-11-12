import { describe, expect, test } from 'bun:test';

import { getDropdownNavigationKey, handleDropdownNavigationKey } from './dropdown-navigation';

function createEvent(overrides: Partial<KeyboardEvent> = {}) {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    get defaultPrevented() { return defaultPrevented; },
    isPropagationStopped: () => propagationStopped,
    preventDefault: () => { defaultPrevented = true; },
    stopPropagation: () => { propagationStopped = true; },
    ...overrides,
  };
}

describe('dropdown Ctrl+N/P navigation', () => {
  test('requires an exact Ctrl modifier chord', () => {
    expect(getDropdownNavigationKey(createEvent())).toBe('ArrowDown');
    expect(getDropdownNavigationKey(createEvent({ key: 'p', code: 'KeyP' }))).toBe('ArrowUp');
    expect(getDropdownNavigationKey(createEvent({ ctrlKey: false }))).toBeNull();
    expect(getDropdownNavigationKey(createEvent({ metaKey: true }))).toBeNull();
    expect(getDropdownNavigationKey(createEvent({ altKey: true }))).toBeNull();
    expect(getDropdownNavigationKey(createEvent({ shiftKey: true }))).toBeNull();
  });

  test('uses the physical key for non-Latin layouts', () => {
    expect(getDropdownNavigationKey(createEvent({ key: 'т', code: 'KeyN' }))).toBe('ArrowDown');
  });

  test('respects cancellation and otherwise navigates exactly once', () => {
    const cancelled = createEvent({ defaultPrevented: true });
    expect(handleDropdownNavigationKey(cancelled, () => { throw new Error('should not navigate'); })).toBe(false);

    const stopped = createEvent();
    stopped.stopPropagation();
    expect(handleDropdownNavigationKey(stopped, () => { throw new Error('should not navigate'); })).toBe(false);

    const event = createEvent();
    const steps: string[] = [];
    expect(handleDropdownNavigationKey(event, (key) => steps.push(key))).toBe(true);
    expect(steps).toEqual(['ArrowDown']);
    expect(event.defaultPrevented).toBe(true);
    expect(event.isPropagationStopped()).toBe(true);
  });
});
