/** Theme-driven series palette (design-system.css defines --chart-1..5). */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * Color for the Nth series. Indices 0..4 map to the five branded chart colors
 * (the top-5 models never collide). Anything beyond — i.e. the aggregated
 * "other" bucket, always the last series — falls back to a neutral muted tone
 * so it never repeats an earlier model's color.
 */
export const seriesColor = (index: number): string =>
  SERIES_COLORS[index] ?? "var(--muted-foreground)";
