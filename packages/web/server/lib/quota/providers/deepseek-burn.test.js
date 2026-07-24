import { describe, expect, it } from 'vitest';

import { computeBurn } from './deepseek-burn.js';

const HOUR = 3_600_000;

describe('computeBurn', () => {
  it('computes hourly burn and runway from a decreasing balance', () => {
    const { burnPerHour, runwaySeconds } = computeBurn([
      { balanceUsd: 44, at: 0 },
      { balanceUsd: 43, at: 2 * HOUR }
    ]);
    expect(burnPerHour).toBeCloseTo(0.5, 6);
    expect(runwaySeconds).toBeCloseTo((43 / 0.5) * 3600, 3);
  });

  it('returns nulls with fewer than two samples', () => {
    expect(computeBurn([{ balanceUsd: 44, at: 0 }])).toEqual({ burnPerHour: null, runwaySeconds: null });
    expect(computeBurn([])).toEqual({ burnPerHour: null, runwaySeconds: null });
  });

  it('never reports negative burn across a top-up', () => {
    const { burnPerHour } = computeBurn([
      { balanceUsd: 40, at: 0 },
      { balanceUsd: 50, at: HOUR },
      { balanceUsd: 48, at: 2 * HOUR }
    ]);
    expect(burnPerHour).toBeCloseTo(2, 6);
    expect(burnPerHour).toBeGreaterThan(0);
  });

  it('returns nulls when samples span less than the minimum window', () => {
    expect(computeBurn([
      { balanceUsd: 44, at: 0 },
      { balanceUsd: 43, at: 30_000 }
    ])).toEqual({ burnPerHour: null, runwaySeconds: null });
  });

  it('returns nulls when the balance is flat', () => {
    expect(computeBurn([
      { balanceUsd: 44, at: 0 },
      { balanceUsd: 44, at: 2 * HOUR }
    ])).toEqual({ burnPerHour: null, runwaySeconds: null });
  });
});
