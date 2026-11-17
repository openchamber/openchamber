const MAX_TICKS = 12;

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
  const round = (tick: number) => Number(decimals <= 20 ? tick.toFixed(decimals) : tick.toPrecision(12));
  const ticks: number[] = [];
  for (let index = 0; low + index * step <= high + step / 2 && ticks.length < MAX_TICKS; index++) {
    ticks.push(round(low + index * step));
  }
  return ticks;
}
