import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_MENU_FALLBACK_HEIGHT_PX,
  DESKTOP_MENU_FALLBACK_WIDTH_PX,
  DESKTOP_MENU_SIDE_MARGIN_PX,
  getDesktopClampedX,
  getDesktopClampedY,
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
