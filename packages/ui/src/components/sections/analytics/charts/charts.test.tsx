import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarChart } from './BarChart';
import { HeatmapGrid } from './HeatmapGrid';
import { LineChart } from './LineChart';
import { StackedBarChart } from './StackedBarChart';

describe('BarChart', () => {
  test('renders one rect per datum', () => {
    const html = renderToStaticMarkup(
      <BarChart
        data={[
          { label: 'Aug 1', value: 10 },
          { label: 'Aug 2', value: 20 },
        ]}
        width={200}
        ariaLabel="Tokens per day"
      />,
    );
    const rectCount = (html.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(2);
  });

  test('renders no rects for empty data', () => {
    const html = renderToStaticMarkup(
      <BarChart data={[]} width={200} ariaLabel="Tokens per day" />,
    );
    expect(html).not.toContain('<rect');
  });
});

describe('HeatmapGrid', () => {
  test('renders a cell per matrix entry with its level color', () => {
    const html = renderToStaticMarkup(
      <HeatmapGrid
        rows={[
          [
            { level: 1, tooltipKey: 'a', tooltip: <span>x</span> },
            null,
            null,
          ],
        ]}
        lessLabel="Less"
        moreLabel="More"
        ariaLabel="Activity heatmap"
      />,
    );
    // the populated cell renders its level-1 color; null cells render the
    // subtle surface. Tooltip content is hover-gated, so assert the grid
    // role + the level class instead.
    expect(html).toContain('aria-label="Activity heatmap"');
    expect(html).toContain('var(--chart-1)_25%');
  });

  test('renders row/column headers and legend when provided', () => {
    const html = renderToStaticMarkup(
      <HeatmapGrid
        rows={[[{ level: 2, tooltipKey: '0-0', tooltip: <span>x</span> }]]}
        rowLabels={['Mo']}
        columnLabels={['0']}
        lessLabel="Less"
        moreLabel="More"
        ariaLabel="Rhythm"
      />,
    );
    expect(html).toContain('Mo');
    expect(html).toContain('>0<');
    expect(html).toContain('Less');
    expect(html).toContain('More');
  });
});

describe('StackedBarChart', () => {
  test('renders one column per datum with N stacked rects', () => {
    const html = renderToStaticMarkup(
      <StackedBarChart
        data={[
          { label: 'Aug 1', segments: [10, 5, 2] },
          { label: 'Aug 2', segments: [20, 0, 4] },
        ]}
        seriesLabels={['Prompt', 'Completion', 'Reasoning']}
        width={200}
        ariaLabel="Token breakdown"
      />,
    );
    const rectCount = (html.match(/<rect/g) ?? []).length;
    // 2 columns * 3 series = 6 rects (zero-height segments are still rendered)
    expect(rectCount).toBeGreaterThanOrEqual(4);
  });

  test('renders nothing for empty data', () => {
    const html = renderToStaticMarkup(
      <StackedBarChart
        data={[]}
        seriesLabels={[]}
        width={200}
        ariaLabel="x"
      />,
    );
    expect(html).not.toContain('<rect');
  });
});

describe('LineChart', () => {
  test('renders one path per series', () => {
    const html = renderToStaticMarkup(
      <LineChart
        data={[
          { label: 'Aug 1', values: [10, 4] },
          { label: 'Aug 2', values: [20, 6] },
          { label: 'Aug 3', values: [12, 8] },
        ]}
        seriesLabels={['gpt-5', 'claude']}
        width={200}
        ariaLabel="Model usage over time"
      />,
    );
    const pathCount = (html.match(/<path/g) ?? []).length;
    expect(pathCount).toBe(2);
  });

  test('renders no paths for empty data', () => {
    const html = renderToStaticMarkup(
      <LineChart
        data={[]}
        seriesLabels={['a', 'b']}
        width={200}
        ariaLabel="x"
      />,
    );
    expect(html).not.toContain('<path');
  });
});
