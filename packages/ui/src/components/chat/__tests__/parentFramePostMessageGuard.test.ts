import { describe, expect, test } from 'bun:test';

/**
 * Mirrors the ChatContainer chat-settings-sync guard.
 * VS Code/Cursor/Positron webviews delete `window.parent`, so the old
 * `window.parent === window` check still fell through to `.postMessage` and
 * crashed chat open with:
 * TypeError: Cannot read properties of undefined (reading 'postMessage')
 */
const canPostMessageToParentFrame = (win: { parent?: unknown } | undefined): boolean => {
  if (typeof win === 'undefined' || !win) return false;
  return Boolean(win.parent) && win.parent !== win;
};

describe('parent-frame postMessage guard (VS Code webview)', () => {
  test('rejects when parent was deleted (VS Code webview injector behavior)', () => {
    const vscodeLikeWindow = { parent: undefined };
    expect(canPostMessageToParentFrame(vscodeLikeWindow)).toBe(false);
  });

  test('rejects when parent is null', () => {
    expect(canPostMessageToParentFrame({ parent: null })).toBe(false);
  });

  test('rejects top-level windows where parent === self', () => {
    const topLevel = {} as { parent?: unknown };
    topLevel.parent = topLevel;
    expect(canPostMessageToParentFrame(topLevel)).toBe(false);
  });

  test('allows real embedded iframe parent windows', () => {
    const parent = {};
    const child = { parent };
    expect(canPostMessageToParentFrame(child)).toBe(true);
  });

  test('old guard incorrectly allows deleted parent', () => {
    const vscodeLikeWindow = { parent: undefined as unknown };
    const oldGuardWouldSkip = vscodeLikeWindow.parent === vscodeLikeWindow;
    expect(oldGuardWouldSkip).toBe(false);
  });
});
