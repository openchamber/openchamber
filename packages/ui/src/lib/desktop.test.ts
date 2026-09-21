import { describe, expect, test } from 'bun:test';

import { isBrowserClientRuntime } from './desktop';

describe('browser client runtime', () => {
  test('uses browser file behavior only outside the Electron shell', () => {
    expect(isBrowserClientRuntime('web', false)).toBe(true);
    expect(isBrowserClientRuntime('web', true)).toBe(false);
  });

  test('keeps desktop and VS Code runtime behavior out of browser-only flows', () => {
    expect(isBrowserClientRuntime('desktop', false)).toBe(false);
    expect(isBrowserClientRuntime('vscode', false)).toBe(false);
  });
});
