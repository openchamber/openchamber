// A valid series can hold values near Number.MAX_VALUE, where the rounded
// bounds overflow; past this many steps the axis gives up on round values.
const MAX_TICKS = 12;

/**
 * Round values from at most `min` to at least `max`, about four steps apart: a chart's axis.
 * Each tick is computed from the first, not by adding steps, and rounded to the
 * step's own decimals, so neither float noise (0.30000000000000004) nor a
 * large base (1e12 + 0.5) blurs two ticks into one.
 */
export function axisTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const raw = (max - min || Math.abs(max) || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const share = raw / magnitude;
  const step = (share <= 1 ? 1 : share <= 2 ? 2 : share <= 5 ? 5 : 10) * magnitude;
  const low = Math.floor(min / step) * step;
  const high = Math.max(Math.ceil(max / step) * step, low + step);
  if (![step, low, high].every(Number.isFinite)) return min === max ? [min] : [min, max];
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  // toFixed stops at 20 decimals; a smaller step rounds by significant digits instead.
  const round = (tick: number) => Number(decimals <= 20 ? tick.toFixed(decimals) : tick.toPrecision(12));
  const ticks: number[] = [];
  for (let index = 0; low + index * step <= high + step / 2 && ticks.length < MAX_TICKS; index++) {
    ticks.push(round(low + index * step));
  }
  return ticks;
}
