import { afterEach, describe, expect, test } from 'bun:test';

import { readTabletLayout, type TabletLayout } from './device';

// No module mocking here on purpose: mock.module is process-global and would
// leak into every other test file. Outside a Capacitor shell isIPadApp() is
// already false, so a bare viewport stub isolates the geometry rules.
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

let keyboardOpen = false;
let nativeShell = false;
let focusedInput = false;

const setViewport = (width: number, height: number) => {
  (globalThis as { window?: unknown }).window = {
    innerWidth: width,
    innerHeight: height,
    // isIPadApp() reaches for the Capacitor markers; a plain web location
    // keeps it on its `false` path without mocking the module.
    location: { protocol: 'https:', search: '' },
    Capacitor: { isNativePlatform: () => nativeShell },
  };
  // SAFETY: the test installs its own minimal DOM global; the shape is ours.
  (globalThis as { document?: unknown }).document = {
    documentElement: { classList: { contains: (name: string) => keyboardOpen && name === 'oc-keyboard-open' } },
    activeElement: focusedInput ? { tagName: 'TEXTAREA', isContentEditable: false } : null,
  };
};

const withViewport = (width: number, height: number): TabletLayout => {
  setViewport(width, height);
  return readTabletLayout();
};

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  // SAFETY: restores the global the stub above replaced.
  (globalThis as { document?: unknown }).document = originalDocument;
  keyboardOpen = false;
  nativeShell = false;
  focusedInput = false;
});

describe('readTabletLayout', () => {
  test('a phone stays a phone in both orientations', () => {
    expect(withViewport(390, 844).enabled).toBe(false);
    // The long side alone must never qualify — this is the case a plain
    // width threshold gets wrong.
    expect(withViewport(844, 390).enabled).toBe(false);
  });

  test('a tablet qualifies in both orientations', () => {
    expect(withViewport(834, 1194).enabled).toBe(true);
    expect(withViewport(1194, 834).enabled).toBe(true);
  });

  test('side panels need real width, so a tablet in portrait keeps the drawer', () => {
    expect(withViewport(834, 1194).roomyForPanels).toBe(false);
    expect(withViewport(1194, 834).roomyForPanels).toBe(true);
  });

  test('an unfolded foldable is a tablet but never roomy enough for panels', () => {
    // Book foldables are near-square: the long side is barely wider than a
    // tablet's short one, so both orientations keep the portrait layout.
    expect(withViewport(690, 840)).toEqual({ enabled: true, roomyForPanels: false });
    expect(withViewport(840, 690)).toEqual({ enabled: true, roomyForPanels: false });
  });

  test('folding shut drops back to the phone layout', () => {
    expect(withViewport(370, 900).enabled).toBe(false);
  });

  test('the soft keyboard does not drop an unfolded foldable to the phone layout', () => {
    // Unfolded and idle: a tablet.
    expect(withViewport(932, 704).enabled).toBe(true);
    // Android resizes the layout viewport for the keyboard, so the short side
    // falls under the threshold. The size class must not follow it, or the
    // surface holding the focused field remounts and the keyboard closes.
    keyboardOpen = true;
    expect(withViewport(932, 404).enabled).toBe(true);
    // Keyboard gone, viewport whole again.
    keyboardOpen = false;
    expect(withViewport(932, 704).enabled).toBe(true);
  });

  test('rotating a phone while typing keeps the phone layout until the keyboard closes', () => {
    expect(withViewport(390, 844).enabled).toBe(false);
    keyboardOpen = true;
    // Landscape over a viewport the keyboard shrank: 844 wide must not read as a tablet.
    expect(withViewport(844, 90)).toEqual({ enabled: false, roomyForPanels: false });
    keyboardOpen = false;
    expect(withViewport(844, 390).enabled).toBe(false);
  });

  test('in the native shell a focused field over a shrunk viewport is the keyboard', () => {
    nativeShell = true;
    expect(withViewport(932, 704).enabled).toBe(true);
    focusedInput = true;
    expect(withViewport(932, 404).enabled).toBe(true);
  });

  test('without a focused field the same shrink is a real resize', () => {
    nativeShell = true;
    expect(withViewport(932, 704).enabled).toBe(true);
    expect(withViewport(932, 404).enabled).toBe(false);
  });
});
