import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DonutChart } from './DonutChart';

describe('DonutChart', () => {
  test('arcs are centered via a translate group (not rendered at origin)', () => {
    const html = renderToStaticMarkup(
      <DonutChart values={[10, 20, 30]} ariaLabel="Model distribution" />,
    );
    // @visx/shape Pie only applies top/left in its default render path; when
    // using the children render-prop the consumer must wrap arcs in a <Group>.
    // Assert that wrap is present (translate to the 50,50 center).
    expect(html).toMatch(/translate\(\s*50/);
  });

  test('arc coordinates span past the center (centered, not top-left)', () => {
    const html = renderToStaticMarkup(
      <DonutChart values={[10, 20, 30]} ariaLabel="Model distribution" />,
    );
    // A donut centered at (50,50) with outerRadius 48 reaches ~98 on the right
    // edge. If centered at the origin (the bug), the max coordinate is ~48.
    const numbers = html.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    expect(numbers.some((n) => n > 90)).toBe(true);
  });

  test('renders an svg with role img and the aria label', () => {
    const html = renderToStaticMarkup(
      <DonutChart values={[10, 20, 30]} ariaLabel="Model distribution" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Model distribution"');
  });
});
