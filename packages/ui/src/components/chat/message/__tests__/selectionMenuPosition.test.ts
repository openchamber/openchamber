import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_MENU_FALLBACK_HEIGHT_PX,
  DESKTOP_MENU_FALLBACK_WIDTH_PX,
  DESKTOP_MENU_SELECTION_GAP_PX,
  DESKTOP_MENU_SIDE_MARGIN_PX,
  getDesktopClampedX,
  getDesktopMenuY,
} from '../selectionMenuPosition';

const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;
const MENU_WIDTH = DESKTOP_MENU_FALLBACK_WIDTH_PX;
const MENU_HEIGHT = DESKTOP_MENU_FALLBACK_HEIGHT_PX;
// The chat viewport starts below the app header.
const CHAT_TOP = 48;

const menuY = (selectionTop: number, selectionBottom: number, menuHeight = MENU_HEIGHT) => getDesktopMenuY({
  selectionTop,
  selectionBottom,
  menuHeight,
  viewportHeight: VIEWPORT_HEIGHT,
  boundaryTop: CHAT_TOP,
});

describe('getDesktopMenuY', () => {
  test('places the menu above a selection with room above it', () => {
    expect(menuY(300, 320)).toEqual({ y: 300 - DESKTOP_MENU_SELECTION_GAP_PX, placement: 'above' });
  });

  // Issue #3596: the menu was pushed down onto selections near the top of
  // the chat and blocked right-click copy.
  test('flips below a selection too close to the top of the chat', () => {
    const result = menuY(CHAT_TOP + 20, CHAT_TOP + 40);
    expect(result).toEqual({ y: CHAT_TOP + 40 + DESKTOP_MENU_SELECTION_GAP_PX, placement: 'below' });
  });

  test('never overlaps the selection when either side has room', () => {
    for (const top of [CHAT_TOP, CHAT_TOP + 30, CHAT_TOP + 60, 400, VIEWPORT_HEIGHT - 60]) {
      const bottom = top + 20;
      const { y, placement } = menuY(top, bottom);
      const menuTop = placement === 'above' ? y - MENU_HEIGHT : y;
      const menuBottom = placement === 'above' ? y : y + MENU_HEIGHT;
      expect(menuBottom <= top || menuTop >= bottom).toBe(true);
      expect(menuTop).toBeGreaterThanOrEqual(CHAT_TOP + DESKTOP_MENU_SIDE_MARGIN_PX);
      expect(menuBottom).toBeLessThanOrEqual(VIEWPORT_HEIGHT - DESKTOP_MENU_SIDE_MARGIN_PX);
    }
  });

  test('flips a tall comment box below when it would climb over the header', () => {
    expect(menuY(CHAT_TOP + 100, CHAT_TOP + 120, 150).placement).toBe('below');
  });

  test('keeps the menu below the viewport top when the chat boundary is off screen', () => {
    const result = getDesktopMenuY({
      selectionTop: 60,
      selectionBottom: 80,
      menuHeight: MENU_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      boundaryTop: -500,
    });
    expect(result).toEqual({ y: 60 - DESKTOP_MENU_SELECTION_GAP_PX, placement: 'above' });
  });

  // Issue #2257: a selection spanning past the viewport has a negative top
  // and no free side; the menu must stay fully on screen.
  test('pins the menu on screen when the selection fills the visible area', () => {
    expect(menuY(-210, VIEWPORT_HEIGHT + 300)).toEqual({
      y: CHAT_TOP + DESKTOP_MENU_SIDE_MARGIN_PX + MENU_HEIGHT,
      placement: 'above',
    });
  });

  test('flips below a selection that starts above the viewport but ends inside it', () => {
    expect(menuY(-210, 200)).toEqual({ y: 200 + DESKTOP_MENU_SELECTION_GAP_PX, placement: 'below' });
  });

  test('clamps a selection scrolled below the viewport back to the bottom margin', () => {
    expect(menuY(VIEWPORT_HEIGHT + 500, VIEWPORT_HEIGHT + 520)).toEqual({
      y: VIEWPORT_HEIGHT - DESKTOP_MENU_SIDE_MARGIN_PX,
      placement: 'above',
    });
  });

  test('falls back to the viewport middle when the viewport is shorter than the menu', () => {
    const result = getDesktopMenuY({
      selectionTop: 10,
      selectionBottom: 20,
      menuHeight: MENU_HEIGHT,
      viewportHeight: MENU_HEIGHT,
      boundaryTop: 0,
    });
    expect(result).toEqual({ y: MENU_HEIGHT / 2, placement: 'above' });
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
