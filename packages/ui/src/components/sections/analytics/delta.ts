export type DeltaKind = 'up' | 'down' | 'flat' | 'new';

export const deltaKind = (current: number, prev: number): DeltaKind =>
  prev === 0 ? 'new' : current === prev ? 'flat' : current > prev ? 'up' : 'down';

export const deltaPercent = (current: number, prev: number): number =>
  prev === 0 ? 0 : Math.round(Math.abs((current - prev) / prev) * 100);

/**
 * Display form for a delta percent. Percentages off a tiny previous-period
 * baseline explode (e.g. 1 → 142 sessions = 14100%), which is correct but
 * meaningless to show — cap anything over 999% as "999+".
 */
export const formatDeltaPercent = (pct: number): string =>
  pct > 999 ? "999+" : String(pct);
