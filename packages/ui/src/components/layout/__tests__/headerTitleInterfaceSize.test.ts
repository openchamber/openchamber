/**
 * The interface size setting scales the root font, so only text sized in rem
 * follows it. The header's title was fixed at 14px and its caption at 10.5px:
 * at 200% the rest of the header doubled around a title that stayed put.
 *
 * Like issue-4075-headerTabStripDragRegion.test.ts, this reads the source
 * instead of mounting the header. It covers the title area in front of the
 * session tabs: a main surface's title, and the session title with its rename
 * field, its caption and its menu button.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const headerSource = readFileSync(join(__dirname, '..', 'Header.tsx'), 'utf-8');

const between = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from === -1 || to === -1 || source.indexOf(start, from + 1) !== -1) {
    throw new Error(`expected one title area from ${start} to ${end}`);
  }
  return source.slice(from, to);
};

const titleArea = between(headerSource, '{activeSurfaceHeader ? (', '<SessionTabsStrip');
const PX_TEXT_SIZE = /\btext-\[\d+(?:\.\d+)?px\]/g;
const PX_HEIGHT = /\bh-\[\d+(?:\.\d+)?px\]/g;

describe('header title follows the interface size', () => {
  test('the title area holds the session title, its caption and its menu button', () => {
    // Positive control: the slice is the area these checks are about.
    expect(titleArea).toContain('{currentSessionTitle}');
    expect(titleArea).toContain('{activeSurfaceHeader.subtitle}');
    expect(titleArea).toContain("t('header.sessionActions.openAria')");
    expect('text-[14px] text-[10.5px] h-[18px]'.match(PX_TEXT_SIZE)).toEqual(['text-[14px]', 'text-[10.5px]']);
    expect('h-[18px]'.match(PX_HEIGHT)).toEqual(['h-[18px]']);
  });

  test('the session title takes its size from the typography scale', () => {
    const lines = titleArea.split('\n');
    const title = lines.findIndex((line) => line.trim() === '{currentSessionTitle}');
    expect(title).toBeGreaterThan(0);
    const titleClass = lines[title - 1] ?? '';
    // 14px at 100%, as before, and in rem from there.
    expect(titleClass).toContain('typography-ui-header');
    expect(titleClass.match(PX_TEXT_SIZE) ?? []).toEqual([]);
    // The rename field, a draft's title line and a main surface's title are
    // title-sized too, so none of them sits a step below on the label size.
    expect(titleArea.match(/\btypography-ui-label\b/g) ?? []).toEqual([]);
  });

  test('no text size or line box in the title area is fixed in px', () => {
    expect(titleArea.match(PX_TEXT_SIZE) ?? []).toEqual([]);
    // The menu button's box matches the title's line, so it stays level with
    // the title at every size.
    expect(titleArea.match(PX_HEIGHT) ?? []).toEqual([]);
  });
});
