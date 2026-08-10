import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sparkline } from './Sparkline';
import { computeSparklinePoints } from './geometry';

describe('Sparkline', () => {
  test('renders a visx path for >= 2 points', () => {
    const html = renderToStaticMarkup(
      <Sparkline values={[1, 2, 3]} width={30} height={10} />,
    );
    expect(html).toContain('<path');
    expect(html).toContain('d="');
  });

  test('no path for fewer than 2 points', () => {
    const html = renderToStaticMarkup(<Sparkline values={[5]} />);
    expect(html).not.toContain('<path');
  });

  test('all-zero values render a flat path (no NaN)', () => {
    const html = renderToStaticMarkup(
      <Sparkline values={[0, 0, 0]} height={10} />,
    );
    expect(html).toContain('<path');
    expect(html).not.toContain('NaN');
  });

  test('tone class applied', () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 2]} tone="up" />);
    expect(html).toContain('--status-success');
    expect(html).toContain('aria-hidden');
  });

  test('helper geometry is consistent with rendered path', () => {
    const points = computeSparklinePoints([1, 2, 3], 30, 10);
    expect(points).toHaveLength(3);
    // peak (value 3) maps to the smallest y (top of the chart)
    expect(points[2]!.y).toBeLessThan(points[0]!.y);
  });
});
