import { scaleBand, scaleLinear } from '@visx/scale';

export interface Point {
  x: number;
  y: number;
}

export function computeSparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
): Point[] {
  if (values.length < 2) return [];
  const max = Math.max(...values, 0);
  const x = scaleLinear<number>({ domain: [0, values.length - 1], range: [0, width] });
  const y = scaleLinear<number>({ domain: [0, Math.max(max, 1)], range: [height - 1, 1] });
  return values.map((v, i) => ({ x: x(i), y: y(Math.max(0, v)) }));
}

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  label: string;
}

export function computeBarRects(
  data: readonly { label: string; value: number }[],
  width: number,
  height: number,
  labelHeight: number,
): BarRect[] {
  if (data.length === 0) return [];
  const chartHeight = height - labelHeight;
  const x = scaleBand<string>({
    domain: data.map((d) => d.label),
    range: [0, Math.max(width, 1)],
    padding: 0.25,
  });
  const max = data.reduce((acc, d) => Math.max(acc, d.value), 0);
  const y = scaleLinear<number>({ domain: [0, Math.max(max, 0)], range: [chartHeight, 0] });
  return data.map((d) => {
    const bh = max > 0 ? chartHeight - Math.max(0, y(d.value)) : 0;
    return {
      x: x(d.label) ?? 0,
      y: chartHeight - bh,
      width: x.bandwidth(),
      height: bh,
      value: d.value,
      label: d.label,
    };
  });
}

export interface StackedBar {
  y: number;
  height: number;
  value: number;
  seriesIndex: number;
}

export interface StackedRow {
  label: string;
  x: number;
  width: number;
  bars: StackedBar[];
}

interface LinePoint {
  x: number;
  y: number;
  value: number;
  index: number;
}

interface LineSeries {
  seriesIndex: number;
  points: LinePoint[];
}

/**
 * Computes one polyline per series from rows of `values` (value per series).
 * X is index-based (evenly spaced days); Y is a shared 0..max scale across all
 * series so lines are directly comparable.
 */
export function computeLineSeries(
  data: readonly { label: string; values: number[] }[],
  width: number,
  height: number,
  labelHeight: number,
): LineSeries[] {
  if (data.length === 0) return [];
  const chartHeight = Math.max(height - labelHeight, 1);
  const seriesCount = data[0]!.values.length;
  const max = data.reduce(
    (acc, d) => d.values.reduce((m, v) => Math.max(m, Math.max(0, v)), acc),
    0,
  );
  const x = scaleLinear<number>({
    domain: [0, Math.max(data.length - 1, 1)],
    range: [0, Math.max(width, 1)],
  });
  const y = scaleLinear<number>({
    domain: [0, Math.max(max, 1)],
    range: [chartHeight, 0],
  });
  const series: LineSeries[] = [];
  for (let s = 0; s < seriesCount; s++) {
    const points: LinePoint[] = data.map((d, i) => ({
      x: x(i),
      y: y(Math.max(0, d.values[s] ?? 0)),
      value: d.values[s] ?? 0,
      index: i,
    }));
    series.push({ seriesIndex: s, points });
  }
  return series;
}

export function buildStackedRows(
  data: readonly { label: string; segments: number[] }[],
  width: number,
  height: number,
  labelHeight: number,
): StackedRow[] {
  if (data.length === 0) return [];
  const chartHeight = height - labelHeight;
  const x = scaleBand<string>({
    domain: data.map((d) => d.label),
    range: [0, Math.max(width, 1)],
    padding: 0.25,
  });
  const totals = data.map((d) => d.segments.reduce((s, v) => s + Math.max(0, v), 0));
  const max = totals.reduce((acc, t) => Math.max(acc, t), 0);
  return data.map((d) => {
    const baseX = x(d.label) ?? 0;
    let top = chartHeight;
    const bars: StackedBar[] = d.segments.map((value, seriesIndex) => {
      const v = Math.max(0, value);
      const bh = max > 0 ? (v / max) * chartHeight : 0;
      top -= bh;
      return { y: top, height: bh, value: v, seriesIndex };
    });
    return { label: d.label, x: baseX, width: x.bandwidth(), bars };
  });
}
