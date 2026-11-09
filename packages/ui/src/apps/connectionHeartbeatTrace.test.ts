import { describe, expect, test } from 'bun:test';

import { HEARTBEAT_COLUMNS, buildHeartbeatTrace } from './connectionHeartbeatTrace';

const rowsOf = (dots: ReturnType<typeof buildHeartbeatTrace>, column: number) =>
  dots.filter((dot) => dot.column === column).map((dot) => dot.row).sort((a, b) => a - b);

describe('heartbeat trace', () => {
  test('without answers the trace is a flat line, one dot per column', () => {
    const dots = buildHeartbeatTrace(100, [{ beat: 90, latencyMs: null }]);
    expect(dots).toHaveLength(HEARTBEAT_COLUMNS);
    expect(new Set(dots.map((dot) => dot.row))).toEqual(new Set([7]));
  });

  test('an answer draws a connected spike that starts at the newest column and scrolls left', () => {
    const last = HEARTBEAT_COLUMNS - 1;
    // The spike is the fourth beat of the waveform, three beats after the answer landed.
    const dots = buildHeartbeatTrace(103, [{ beat: 100, latencyMs: 40 }]);
    // 40 ms: log2(8) * 1.2 = 3.6, four rows above the baseline at row 7.
    expect(rowsOf(dots, last)).toEqual([3, 4, 5, 6, 7]);
    // The dip before the spike, one row under the baseline.
    expect(rowsOf(dots, last - 1)).toEqual([8]);

    const later = buildHeartbeatTrace(104, [{ beat: 100, latencyMs: 40 }]);
    expect(rowsOf(later, last - 1)).toEqual([3, 4, 5, 6, 7]);
    // The drop to two rows under the baseline lights every row down from the peak.
    expect(rowsOf(later, last)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  test('a slower answer spikes higher, capped at the top row', () => {
    const peak = (latencyMs: number) => Math.min(...rowsOf(buildHeartbeatTrace(3, [{ beat: 0, latencyMs }]), HEARTBEAT_COLUMNS - 1));
    expect(peak(20)).toBeGreaterThan(peak(150));
    expect(peak(150)).toBeGreaterThan(peak(400));
    expect(peak(5_000)).toBe(0);
  });
});
