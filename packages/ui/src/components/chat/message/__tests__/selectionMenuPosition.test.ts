import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_MENU_FALLBACK_HEIGHT_PX,
  DESKTOP_MENU_FALLBACK_WIDTH_PX,
  DESKTOP_MENU_SELECTION_GAP_PX,
  DESKTOP_MENU_SIDE_MARGIN_PX,
  getDesktopClampedX,
  getDesktopClampedY,
  getDesktopSelectionAnchorY,
} from '../selectionMenuPosition';

const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;
const MENU_WIDTH = DESKTOP_MENU_FALLBACK_WIDTH_PX;
const MENU_HEIGHT = DESKTOP_MENU_FALLBACK_HEIGHT_PX;

// Regression coverage for issue #2257: selecting a long assistant response
// across a scroll boundary makes range.getBoundingClientRect().top negative,
// and the unclamped anchor (rect.top - 10) placed the menu above the viewport.
describe('getDesktopClampedY (issue #2257)', () => {
  test('keeps the menu on screen when the selection starts above the viewport', () => {
    const clamped = getDesktopClampedY(-210, VIEWPORT_HEIGHT, MENU_HEIGHT);
    expect(clamped).toBe(DESKTOP_MENU_SIDE_MARGIN_PX + MENU_HEIGHT);
  });

  test('keeps the menu fully visible for selections near the top edge', () => {
    // The menu renders with translate(-50%, -100%), so it extends upward from
    // the anchor; anchors smaller than margin + menu height clip the menu.
    const clamped = getDesktopClampedY(5, VIEWPORT_HEIGHT, MENU_HEIGHT);
    expect(clamped).toBe(DESKTOP_MENU_SIDE_MARGIN_PX + MENU_HEIGHT);
  });

  test('clamps anchors below the viewport back to the bottom margin', () => {
    const clamped = getDesktopClampedY(VIEWPORT_HEIGHT + 500, VIEWPORT_HEIGHT, MENU_HEIGHT);
    expect(clamped).toBe(VIEWPORT_HEIGHT - DESKTOP_MENU_SIDE_MARGIN_PX);
  });

  test('leaves in-viewport anchors unchanged', () => {
    expect(getDesktopClampedY(300, VIEWPORT_HEIGHT, MENU_HEIGHT)).toBe(300);
    expect(getDesktopClampedY(MENU_HEIGHT + DESKTOP_MENU_SIDE_MARGIN_PX, VIEWPORT_HEIGHT, MENU_HEIGHT))
      .toBe(MENU_HEIGHT + DESKTOP_MENU_SIDE_MARGIN_PX);
  });

  test('falls back to the viewport middle when the viewport is shorter than the menu', () => {
    const tinyViewportHeight = MENU_HEIGHT;
    expect(getDesktopClampedY(10, tinyViewportHeight, MENU_HEIGHT)).toBe(tinyViewportHeight / 2);
  });
});

// Regression coverage for issue #3416: the popup used to be pushed straight
// down when it did not fit above the selection, which painted it over the
// selected line. Triple-clicking the first line of a message then landed the
// third click on a toolbar button instead of the text.
describe('getDesktopSelectionAnchorY (issue #3416)', () => {
  // A single line of chat text, and the container top the popup stays below.
  const LINE = { top: 200, bottom: 226 };
  const FITS_ABOVE = LINE.top - DESKTOP_MENU_SELECTION_GAP_PX - MENU_HEIGHT;
  const ABOVE_ANCHOR = LINE.top - DESKTOP_MENU_SELECTION_GAP_PX;
  const BELOW_ANCHOR = LINE.bottom + DESKTOP_MENU_SELECTION_GAP_PX + MENU_HEIGHT;

  test('anchors above the selection when the popup fits there', () => {
    expect(getDesktopSelectionAnchorY(LINE, MENU_HEIGHT, FITS_ABOVE)).toBe(ABOVE_ANCHOR);
    expect(getDesktopSelectionAnchorY(LINE, MENU_HEIGHT, 0)).toBe(ABOVE_ANCHOR);
  });

  test('flips below the selection when the popup does not fit above it', () => {
    // The first line of a message: its container starts at the line itself, so
    // nothing fits in the gap above.
    expect(getDesktopSelectionAnchorY(LINE, MENU_HEIGHT, LINE.top + 4)).toBe(BELOW_ANCHOR);
    expect(getDesktopSelectionAnchorY(LINE, MENU_HEIGHT, FITS_ABOVE + 1)).toBe(BELOW_ANCHOR);
  });

  test('flips a popup that grew taller than the room above the selection', () => {
    const tallMenu = MENU_HEIGHT * 4;
    expect(getDesktopSelectionAnchorY(LINE, tallMenu, FITS_ABOVE)).toBe(
      LINE.bottom + DESKTOP_MENU_SELECTION_GAP_PX + tallMenu,
    );
  });

  test('never returns an anchor that paints the popup over the selection', () => {
    for (const minTop of [-500, 0, 150, FITS_ABOVE, FITS_ABOVE + 1, LINE.top, LINE.bottom, 400]) {
      const anchorY = getDesktopSelectionAnchorY(LINE, MENU_HEIGHT, minTop);
      const menuTop = anchorY - MENU_HEIGHT;
      expect(menuTop < LINE.bottom && anchorY > LINE.top).toBe(false);
    }
  });
});

describe('getDesktopClampedX', () => {
  test('clamps anchors past the left edge to the left margin', () => {
    const clamped = getDesktopClampedX(-500, VIEWPORT_WIDTH, MENU_WIDTH);
    expect(clamped).toBe(DESKTOP_MENU_SIDE_MARGIN_PX + MENU_WIDTH / 2);
  });

  test('clamps anchors past the right edge to the right margin', () => {
    const clamped = getDesktopClampedX(VIEWPORT_WIDTH + 500, VIEWPORT_WIDTH, MENU_WIDTH);
    expect(clamped).toBe(VIEWPORT_WIDTH - DESKTOP_MENU_SIDE_MARGIN_PX - MENU_WIDTH / 2);
  });

  test('leaves in-viewport anchors unchanged', () => {
    expect(getDesktopClampedX(VIEWPORT_WIDTH / 2, VIEWPORT_WIDTH, MENU_WIDTH)).toBe(VIEWPORT_WIDTH / 2);
  });

  test('falls back to the viewport middle when the viewport is narrower than the menu', () => {
    const tinyViewportWidth = MENU_WIDTH / 2;
    expect(getDesktopClampedX(10, tinyViewportWidth, MENU_WIDTH)).toBe(tinyViewportWidth / 2);
  });
});
