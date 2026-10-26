import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { placeCaretPopup, viewportLimits } from './placement';

const bounds = { left: 100, right: 900 };
const limits = { top: 0, bottom: 1000 };

describe('caret popup placement', () => {
  test('rises right above the typed line, starting at the trigger', () => {
    expect(placeCaretPopup({ caret: { top: 700, bottom: 720, left: 400 }, bounds, limits, width: 320 }))
      .toEqual({ left: 388, top: 694, place: 'above', width: 320, maxHeight: 260 });
  });

  test('shifts back inside the field near its end edge, and narrows to a narrow field', () => {
    expect(placeCaretPopup({ caret: { top: 700, bottom: 720, left: 880 }, bounds, limits, width: 320 }).left).toBe(580);
    expect(placeCaretPopup({ caret: { top: 700, bottom: 720, left: 150 }, bounds: { left: 100, right: 300 }, limits, width: 320 }))
      .toMatchObject({ left: 100, width: 200 });
  });

  test('drops below the line near the top, when there is clearly more room there', () => {
    expect(placeCaretPopup({ caret: { top: 100, bottom: 120, left: 400 }, bounds, limits, width: 320 }))
      .toMatchObject({ place: 'below', top: 126, maxHeight: 260 });
    expect(placeCaretPopup({ caret: { top: 100, bottom: 120, left: 400 }, caretBottom: 140, bounds, limits, width: 320 }))
      .toMatchObject({ place: 'below', top: 146 });
  });

  test('a phone keyboard ends the room below: an empty composer above it opens its list upward', () => {
    // The caret sits just above the keyboard; the window still runs under it.
    expect(placeCaretPopup({ caret: { top: 300, bottom: 320, left: 400 }, bounds, limits: { top: 90, bottom: 410 }, width: 320 }))
      .toMatchObject({ place: 'above', maxHeight: 196 });
  });

  test('the iOS app\'s keyboard inset ends the visible room, where the visual viewport does not', () => {
    const dom = new Window({ width: 400, height: 800 });
    Object.assign(globalThis, { window: dom, document: dom.document });
    dom.document.documentElement.style.setProperty('--oc-keyboard-inset', '300px');
    expect(viewportLimits().bottom).toBe(500);
    dom.document.documentElement.style.removeProperty('--oc-keyboard-inset');
    expect(viewportLimits().bottom).toBe(800);
  });

  test('right to left, it runs leftward from the caret', () => {
    expect(placeCaretPopup({ caret: { top: 700, bottom: 720, left: 600 }, bounds, limits, width: 320, rightToLeft: true }).left).toBe(292);
  });
});
