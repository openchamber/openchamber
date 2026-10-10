/**
 * Regression guard: the work-status card showed up shifted left and cut off
 * after a cold start.
 *
 * The right slot (the context panel's aside) holds the card's host, anchored
 * right, and the closed context panel's content, which is wider than the
 * card's column. With `overflow: hidden` on either axis the slot is a scroll
 * container, and `overflow-x: clip` beside `overflow-y: hidden` computes to
 * `hidden` as well. On mount the panel's tab strip runs `scrollIntoView` on
 * its active tab, which scrolled the slot sideways; the right-anchored card
 * moved left with the content and lost its left edge to the slot's clip.
 *
 * Layout is not computed in the test DOM, so this pins the source contract.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');

// Every zone frame shares the aside, so the left and bottom zones clip the same way.
const slotElement = (): string => {
  const start = source.indexOf("data-right-slot={zone === 'right' ? '' : undefined}");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('style={panelStyle}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

const panelStyle = (): string => {
  const start = source.indexOf('const panelStyle: React.CSSProperties = {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('};', start);
  return source.slice(start, end);
};

describe('right slot cannot be scrolled sideways', () => {
  test('the slot clips on both axes instead of hiding overflow', () => {
    const element = slotElement();
    expect(element).toContain('overflow-clip');
    expect(/overflow-(hidden|auto|scroll)\b/.test(element)).toBe(false);
    expect(/overflow-[xy]-(hidden|auto|scroll)\b/.test(element)).toBe(false);
  });

  test('the slot style sets no per-axis overflow that would turn clip into hidden', () => {
    expect(/overflow[XY]?\s*:/.test(panelStyle())).toBe(false);
  });
});
