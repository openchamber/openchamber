import { describe, expect, test } from 'bun:test';
import { getTerminalFocusOwner, isTerminalEventTarget } from './terminalFocus';

describe('terminal focus ownership', () => {
  test('finds connected terminal ancestors and rejects detached renderer inputs', () => {
    const originalElement = globalThis.Element;
    class TestElement {
      isConnected = true;
      dataset = { terminalOwner: 'main' };
      closest() { return this; }
    }
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: TestElement });
    try {
      const input = new TestElement() as unknown as Element;
      expect(getTerminalFocusOwner(input)).toBe('main');
      expect(isTerminalEventTarget(input)).toBe(true);
      (input as unknown as TestElement).isConnected = false;
      expect(getTerminalFocusOwner(input)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'Element', { configurable: true, value: originalElement });
    }
  });
});
