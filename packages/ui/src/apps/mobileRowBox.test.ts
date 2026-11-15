/**
 * Regression guard for issue #6979: on a phone an expandable session row
 * scrolled inside itself instead of letting the list follow the drag.
 *
 * Two things made that happen. The row's swipe wrapper used `overflow-hidden`,
 * and styles/mobile.css rewrites every such element to `overflow-y: auto` on a
 * touch layout, so the row became a vertical scroll container. The detailed
 * row's chevron then gave it 2px to scroll: the row's box was 52px (6 + 20 +
 * 4 + 16 + 6) while the 32px chevron box starts at 22 and ends at 54.
 *
 * Layout is not computed in the test DOM, so this pins the source contract.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(here, ...parts), 'utf-8');

const swipeRowSource = read('MobileSessionSwipe.tsx');
const twoLineRowSource = read('mobileSidebar', 'mobileRowParts.tsx');
const indexCss = read('..', 'index.css');

/** The classes of the element that wraps a row's sliding content. */
const swipeRowClasses = (): string => {
  const start = swipeRowSource.indexOf('data-active-session={dataActiveSession || undefined}');
  expect(start).toBeGreaterThan(-1);
  const end = swipeRowSource.indexOf('onTouchStart={handleTouchStart}', start);
  expect(end).toBeGreaterThan(start);
  return swipeRowSource.slice(start, end).match(/className="([^"]+)"/)?.[1] ?? '';
};

describe('a phone session row is never a scroll container of its own', () => {
  test('the swipe wrapper clips with a class mobile.css leaves alone', () => {
    const classes = swipeRowClasses();
    expect(classes).toContain('oc-row-clip');
    // styles/mobile.css rewrites `.overflow-hidden` to `overflow-y: auto
    // !important` on a touch layout, which is what made the row a scroller.
    expect(/\boverflow-(hidden|auto|scroll)\b/.test(classes)).toBe(false);
  });

  test('the clip class keeps clipping without a scroll box', () => {
    expect(/\.oc-row-clip\s*\{[^}]*overflow:\s*clip;/.test(indexCss)).toBe(true);
  });

  test('the two-line row box is as tall as the chevron hanging over it', () => {
    const layout = twoLineRowSource.match(/const layoutClass = '([^']+)'/)?.[1] ?? '';
    expect(layout).toContain('pt-1.5');
    // 8px under the second line, not 6: 6 + 20 + 4 + 16 + 8 = 54, where the
    // chevron's 32px box at top 22 ends.
    expect(layout).toContain('pb-2');
    expect(layout).not.toContain('py-1.5');
    expect(/h-8 items-center[^\n]*top: 22/.test(twoLineRowSource)).toBe(true);
  });
});
