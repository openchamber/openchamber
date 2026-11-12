import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { hostViewerStateSchema, isSurfaceAttended, reportHostViewerState, onHostSurfaceSeen } from './surfaceAttention';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });

let documentFocused = true;
dom.document.hasFocus = () => documentFocused;

// Host state is module-level and cannot be cleared, so the document fallback
// is covered first and every later test runs with a host report in place.
describe('surfaceAttention', () => {
  test('without a host report, follows document focus', () => {
    documentFocused = true;
    expect(isSurfaceAttended()).toBe(true);
    documentFocused = false;
    expect(isSurfaceAttended()).toBe(false);
  });

  test('host report is authoritative over document focus', () => {
    // Focus in the VS Code editor, chat on screen: seen.
    documentFocused = false;
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
    expect(isSurfaceAttended()).toBe(true);

    // Chat on screen but VS Code in the background: not seen.
    documentFocused = true;
    reportHostViewerState({ windowFocused: false, surfaceVisible: true });
    expect(isSurfaceAttended()).toBe(false);

    // VS Code focused but the chat view collapsed: not seen.
    reportHostViewerState({ windowFocused: true, surfaceVisible: false });
    expect(isSurfaceAttended()).toBe(false);
  });

  test('marks seen when a report turns the surface seen, not while it stays unseen', () => {
    let marks = 0;
    const unsubscribe = onHostSurfaceSeen(() => { marks += 1; });

    // Chat collapsed while VS Code is focused: stays unseen.
    reportHostViewerState({ windowFocused: true, surfaceVisible: false });
    expect(marks).toBe(0);

    // Chat opened again: seen.
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
    expect(marks).toBe(1);

    // Repeated identical report is not a new return.
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
    expect(marks).toBe(1);

    // VS Code goes to the background, then comes back.
    reportHostViewerState({ windowFocused: false, surfaceVisible: true });
    expect(marks).toBe(1);
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
    expect(marks).toBe(2);

    unsubscribe();
    reportHostViewerState({ windowFocused: false, surfaceVisible: true });
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
    expect(marks).toBe(2);
  });

  test('schema rejects malformed bridge payloads', () => {
    expect(hostViewerStateSchema.safeParse({ focused: true }).success).toBe(false);
    expect(hostViewerStateSchema.safeParse({ windowFocused: 'yes', surfaceVisible: true }).success).toBe(false);
    expect(hostViewerStateSchema.safeParse(null).success).toBe(false);
    expect(hostViewerStateSchema.safeParse({ windowFocused: false, surfaceVisible: true }).success).toBe(true);
  });
});
