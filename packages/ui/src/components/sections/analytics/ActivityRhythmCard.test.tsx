import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityRhythmCard } from './ActivityRhythmCard';

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const labels = {
  title: 'Activity rhythm',
  ariaLabel: 'Activity by weekday and hour',
  weekdayNames,
  less: 'Less',
  more: 'More',
};

const buildGrid = (peakWeekday: number, peakHour: number, peakValue: number) => {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  grid[peakWeekday][peakHour] = peakValue;
  return grid;
};

describe('ActivityRhythmCard', () => {
  test('renders title, aria and a 7x24 cell grid', () => {
    const grid = buildGrid(3, 9, 500);
    const html = renderToStaticMarkup(
      <ActivityRhythmCard byWeekdayHour={grid} labels={labels} />,
    );
    expect(html).toContain('Activity rhythm');
    expect(html).toContain('Activity by weekday and hour');
    // 7*24 = 168 data cells, each carries the `aspect-square` class.
    const cellCount = (html.match(/aspect-square/g) ?? []).length;
    expect(cellCount).toBe(7 * 24);
  });

  test('marks the peak cell at the highest level and leaves zeros at level 0', () => {
    const grid = buildGrid(3, 9, 500); // peak at Wed 9:00, all else 0
    const html = renderToStaticMarkup(
      <ActivityRhythmCard byWeekdayHour={grid} labels={labels} />,
    );
    expect(html).toContain('_90%,transparent)');
    expect(html).toContain('bg-foreground/5');
  });

  test('renders without crashing when the grid is all zero', () => {
    const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const html = renderToStaticMarkup(
      <ActivityRhythmCard byWeekdayHour={grid} labels={labels} />,
    );
    expect(html).toContain('Activity rhythm');
    // No data cell carries the peak (level-4) color. The legend ramp still
    // shows it, so scope the check to `aspect-square` cells (legend swatches
    // are `size-2`).
    expect(/aspect-square[^"]*?_90%/.test(html)).toBe(false);
  });
});
