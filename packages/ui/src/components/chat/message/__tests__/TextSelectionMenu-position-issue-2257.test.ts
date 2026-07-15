/**
 * Reproduction test for issue #2257:
 * Desktop: 'Add to Chat' floating button gets pushed to screen edge
 * when selecting long agent responses
 *
 * Root cause: the Y-axis position of the TextSelectionMenu is
 * not clamped to the viewport. The X-axis uses `getDesktopClampedX`
 * to keep the menu within viewport bounds, but the Y position is
 * simply `rect.top - 10` with no viewport clamping.
 *
 * When selecting text across a scroll boundary (e.g., dragging
 * downward from visible text, causing the container to scroll),
 * `range.getBoundingClientRect().top` can become negative (selection
 * start is above the viewport). The menu then renders off-screen.
 */

import { describe, test, expect } from 'bun:test';

// ---- Replicate the relevant constants and logic from TextSelectionMenu.tsx ----

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;

/**
 * The X-clamping function that exists in the component.
 * This works correctly — it keeps the menu within viewport bounds horizontally.
 */
function getDesktopClampedX(
  anchorX: number,
  viewportWidth: number = window.innerWidth,
  menuWidth: number = DESKTOP_MENU_FALLBACK_WIDTH_PX,
): number {
  const halfWidth = menuWidth / 2;
  const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
  const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

  if (minX > maxX) {
    return viewportWidth / 2;
  }

  return Math.min(Math.max(anchorX, minX), maxX);
}

/**
 * The Y-position formula used in the component (showMenu function, line 295):
 *   const menuY = rect.top - 10;
 *
 * NOTE: There is NO equivalent Y-clamping function. This is the bug.
 */
function getDesktopUnclampedY(rectTop: number): number {
  return rectTop - 10;
}

/**
 * A hypothetical Y-clamping function that WOULD fix the bug.
 * Used to show what the correct behavior looks like.
 */
function getDesktopClampedY(
  anchorY: number,
  menuHeight: number,
  viewportHeight: number = window.innerHeight,
  margin: number = 4,
): number {
  const minY = margin + menuHeight; // menu extends upward due to translate(-50%, -100%)
  const maxY = viewportHeight - margin;
  return Math.min(Math.max(anchorY, minY), maxY);
}

// ---- Tests ----

describe('TextSelectionMenu positioning (issue #2257 reproduction)', () => {
  const VIEWPORT_W = 1024;
  const VIEWPORT_H = 768;

  describe('X-axis clamping (already correct)', () => {
    test('clamps X to stay within viewport', () => {
      // Even if anchor is far left, clamped X stays within margin
      const clamped = getDesktopClampedX(-500, VIEWPORT_W);
      expect(clamped).toBeGreaterThanOrEqual(DESKTOP_MENU_SIDE_MARGIN_PX + DESKTOP_MENU_FALLBACK_WIDTH_PX / 2);
    });

    test('clamps X when anchor is far right', () => {
      const clamped = getDesktopClampedX(99999, VIEWPORT_W);
      expect(clamped).toBeLessThanOrEqual(VIEWPORT_W - DESKTOP_MENU_SIDE_MARGIN_PX - DESKTOP_MENU_FALLBACK_WIDTH_PX / 2);
    });

    test('leaves X unchanged when already within bounds', () => {
      const clamped = getDesktopClampedX(VIEWPORT_W / 2, VIEWPORT_W);
      expect(clamped).toBe(VIEWPORT_W / 2);
    });
  });

  describe('Y-axis NOT clamped — THE BUG', () => {
    test('Y position is NOT clamped to viewport (BUG: off-screen when rect.top is negative)', () => {
      // Simulate selection whose bounding rect starts above viewport
      // (e.g., user scrolled down while drag-selecting)
      const rectTop = -200; // selection start is 200px above the viewport
      const menuY = getDesktopUnclampedY(rectTop);

      // This is off-screen! The menu renders at Y = -210
      expect(menuY).toBe(-210);
      // The menu is invisible — it's above the viewport top
      expect(menuY).toBeLessThan(0);
    });

    test('Y position not clamped even when rect.top is very small (BUG: menu clips at top edge)', () => {
      // Selection near the very top of the viewport
      const rectTop = 5; // only 5px from top
      const menuY = getDesktopUnclampedY(rectTop);

      // Menu positioned at Y = -5 (off-screen or partially visible)
      // With transform: translate(-50%, -100%), and approximate menu height of ~40px,
      // the visual top of the menu would be at roughly -45px
      expect(menuY).toBe(-5);
      expect(menuY).toBeLessThan(0);
    });

    test('Y position works only when rect.top is reasonably large enough', () => {
      // Selection comfortably in the middle of viewport
      const rectTop = 300;
      const menuY = getDesktopUnclampedY(rectTop);
      expect(menuY).toBe(290); // visible — would be fine
      expect(menuY).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Hypothetical fix: Y-axis clamping', () => {
    test('clamped Y stays within viewport when selection extends above viewport', () => {
      const MENU_HEIGHT = 44; // typical menu height in pixels
      const rectTop = -200;
      const unclamped = getDesktopUnclampedY(rectTop);
      const clamped = getDesktopClampedY(unclamped, MENU_HEIGHT, VIEWPORT_H);

      // Unclamped is off-screen (-210)
      expect(unclamped).toBe(-210);
      // Clamped stays within viewport
      expect(clamped).toBeGreaterThanOrEqual(4 + MENU_HEIGHT);
      expect(clamped).toBeLessThanOrEqual(VIEWPORT_H - 4);
    });

    test('clamped Y stays within viewport when selection is near top edge', () => {
      const MENU_HEIGHT = 44;
      const rectTop = 5;
      const unclamped = getDesktopUnclampedY(rectTop);
      const clamped = getDesktopClampedY(unclamped, MENU_HEIGHT, VIEWPORT_H);

      // Unclamped is off-screen (-5)
      expect(unclamped).toBe(-5);
      // Clamped is visible
      expect(clamped).toBeGreaterThanOrEqual(4 + MENU_HEIGHT);
    });
  });
});
