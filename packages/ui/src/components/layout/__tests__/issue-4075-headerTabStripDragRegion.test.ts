/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/4075
 *
 * `-webkit-app-region: no-drag` applies to a whole subtree, so carrying it on
 * the tab-strip containers made every pixel of the strip undraggable --
 * the empty space beside the tabs included -- and left the window movable
 * only by the right-hand button cluster.
 *
 * The strip now follows Chrome's tab bar: the bar itself stays part of the
 * drag region and each tab carves out a no-drag exception. A full mount is
 * not available in bun test (the import graph pulls in dnd-kit and the
 * context menu), so this follows the source-level guard pattern used by the
 * neighboring layout regression tests.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const headerSource = readFileSync(join(__dirname, '..', 'Header.tsx'), 'utf-8');
const stripSource = readFileSync(join(__dirname, '..', 'SessionTabsStrip.tsx'), 'utf-8');

/** The single source line that opens the element carrying `marker`. */
const lineWith = (source: string, label: string, marker: string): string => {
  const matches = source.split('\n').filter((candidate) => candidate.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${label} line containing ${marker}, found ${matches.length}`);
  }
  return matches[0]!;
};

const NO_DRAG = 'app-region-no-drag';

describe('issue #4075 header tab-strip whitespace stays draggable', () => {
  test('the header root is still the window drag region', () => {
    expect(headerSource).toContain('app-region-drag relative flex h-12 select-none items-center');
  });

  // The two regressing containers. Either one re-acquiring no-drag kills
  // dragging for the whole strip, which is what #4075 reported.
  test('the header wrapper around the strip does not opt out of dragging', () => {
    const wrapper = lineWith(headerSource, 'header strip wrapper', 'flex h-full min-w-0 flex-1 items-center gap-0.5 text-left');
    expect(wrapper).not.toContain(NO_DRAG);
  });

  test('the tablist root does not opt out of dragging', () => {
    const tablist = lineWith(stripSource, 'tablist root', 'role="tablist"');
    expect(tablist).not.toContain(NO_DRAG);
  });

  test('the scroll container does not opt out of dragging', () => {
    const scroller = lineWith(stripSource, 'scroll container', 'session-tabs-scroll');
    expect(scroller).not.toContain(NO_DRAG);
  });

  // Each interactive slot must carve itself out, or clicking and reordering
  // tabs would be swallowed by the drag region.
  test('every tab slot carves out a no-drag exception', () => {
    const slotLines = stripSource
      .split('\n')
      .filter((line) => line.includes('session-tab-slot'));

    expect(slotLines.length).toBeGreaterThanOrEqual(2);
    for (const line of slotLines) {
      expect(line).toContain(NO_DRAG);
    }
  });

  test('the dragged tab item itself is a no-drag slot', () => {
    const tabItem = lineWith(stripSource, 'tab item root', 'shrink-0 touch-none');
    expect(tabItem).toContain(NO_DRAG);
  });

  test('the draft pill is a no-drag slot', () => {
    const draftPill = lineWith(stripSource, 'draft pill', 'bg-interactive-selection px-2');
    expect(draftPill).toContain(NO_DRAG);
  });

  // The JS fallback drag handler relies on the same class to decide what not
  // to drag, so the two mechanisms must keep agreeing.
  test('the fallback drag handler still honours the no-drag opt-out', () => {
    expect(headerSource).toContain("target.closest('.app-region-no-drag')");
  });
});
